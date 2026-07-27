// content.js
//
// Injected automatically into supported job-application pages (see
// manifest.json content_scripts.matches). This is the JS equivalent of
// backend/services/form_filler.py's scan -> match -> fill pipeline, except
// it runs directly in the user's own tab instead of through Selenium, which
// is what makes true one-click / auto-popup behavior possible.

// Note: BACKEND_URL lives in background.js now, not here — see the comment
// at the top of background.js for why the fetch had to move there.

const MIN_TEXT_FIELD_CONFIDENCE = 0.75; // mirrors fill_fields()'s default in form_filler.py

// ---------- 1. Platform detection ----------
const platformKey = detectPlatform(window.location.hostname);
if (platformKey) {
  initAutofill();
}

// Lets the popup's "Fill This Form Now" button trigger a fill on demand,
// in addition to the auto-injected banner.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_AUTOFILL") {
    if (!platformKey) {
      sendResponse({ success: false, error: "This site isn't a supported platform yet." });
      return true;
    }
    chrome.storage.local.get("profile_id").then(({ profile_id: profileId }) => {
      if (!profileId) {
        sendResponse({ success: false, error: "No profile ID saved yet." });
        return;
      }
      runAutofill(profileId).then(() => sendResponse({ success: true }));
    });
    return true; // keep the message channel open for the async response
  }
});

async function initAutofill() {
  const { profile_id: profileId } = await chrome.storage.local.get("profile_id");
  if (!profileId) {
    // No profile selected yet — still show the banner, but clicking it will
    // prompt the user to open the popup and set one up first.
    injectBanner(() => alert("Please set your Profile ID first — click the Tauzand extension icon in your toolbar."));
    return;
  }
  injectBanner(() => runAutofill(profileId));
}

// ---------- 2. Auto-popup banner (the in-page "click to fill" button) ----------
function injectBanner(onClick) {
  if (document.getElementById("tauzand-autofill-banner")) return; // avoid double-inject on SPA route changes

  const banner = document.createElement("div");
  banner.id = "tauzand-autofill-banner";
  banner.textContent = "\u26A1 Autofill this form";
  Object.assign(banner.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    background: "#1F4E79",
    color: "#ffffff",
    padding: "10px 16px",
    borderRadius: "8px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
  });
  banner.addEventListener("click", onClick);
  document.body.appendChild(banner);
}

function showToast(message) {
  const banner = document.getElementById("tauzand-autofill-banner");
  if (banner) banner.textContent = message;
}

// ---------- 2b. Manual-review highlighting ----------
// Used when a field can't be filled programmatically (e.g. a dropdown
// blocked by a trusted-event check — see the comment in fillChoiceFields)
// so the user notices it needs their attention instead of it silently
// staying blank.
function highlightForManualReview(element, label) {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  const originalOutline = element.style.outline;
  const originalOffset = element.style.outlineOffset;
  element.style.outline = "3px solid #E4572E";
  element.style.outlineOffset = "2px";
  console.log(`[Tauzand Autofill] highlighted for manual review: ${label}`);
  setTimeout(() => {
    element.style.outline = originalOutline;
    element.style.outlineOffset = originalOffset;
  }, 4000);
}

// ---------- 3. React-safe value setter ----------
// Plain `element.value = x` is silently ignored by React-controlled inputs
// (Ashby, and parts of Workday) because React's internal state never sees
// the change. This uses the native setter + a real input event instead.
function setFieldValue(element, value) {
  const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;
  nativeSetter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function optionTextFor(element) {
  return (element.getAttribute("aria-label") || element.textContent || element.value || "").trim();
}

// Asks background.js to click a real screen position through the Chrome
// DevTools Protocol (see background.js's trusted-click service comment for
// why this is needed instead of a plain element.click()).
async function trustedClick(element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const response = await chrome.runtime.sendMessage({ type: "DEBUGGER_CLICK", x, y });
  if (!response || !response.success) {
    throw new Error((response && response.error) || "trusted click failed");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 3b. Human-like typing ----------
// Mirrors _human_type() in form_filler.py: types one character at a time
// with a randomized delay, instead of setting the whole value instantly.
// Range matches the backend's FIELD_TYPE_DELAY_MIN_MS/MAX_MS defaults.
const TYPE_DELAY_MIN_MS = 90;
const TYPE_DELAY_MAX_MS = 220;
// Pause after every radio/checkbox/dropdown click, so choice fields fill at
// a visible, human-like pace instead of clicking through all of them
// instantly back-to-back.
const CHOICE_CLICK_DELAY_MS = 350;

async function typeIntoField(element, value) {
  const text = String(value);
  element.focus();
  let typedSoFar = "";
  for (const char of text) {
    typedSoFar += char;
    setFieldValue(element, typedSoFar);
    const delay = TYPE_DELAY_MIN_MS + Math.random() * (TYPE_DELAY_MAX_MS - TYPE_DELAY_MIN_MS);
    await sleep(delay);
  }
}

// ---------- 3c. Audio alert ----------
// Mirrors audio_alert.py's alert_human_intervention_needed(): a beep,
// repeated AUDIO_ALERT_REPEAT_COUNT times with a short gap, whenever
// something needs a human (legal/consent checkbox, CAPTCHA, login wall).
// A content script can't shell out to afplay/paplay/winsound like the
// Python backend does, so this uses the Web Audio API to generate the beep
// directly in the page instead.
const AUDIO_ALERT_ENABLED = true;
const AUDIO_ALERT_REPEAT_COUNT = 3;

// A short 880Hz beep as a base64 WAV, played through a reused <audio>
// element. Switched away from the Web Audio API (oscillator + AudioContext)
// because building a brand-new AudioContext for every beep, after an
// `await sleep(...)`, can land outside the browser's transient
// user-activation window and get silently muted — which was exactly why
// only the first of several beeps was ever actually audible. A plain
// <audio> element's .play() doesn't have that per-call gesture requirement
// once the page has played audio at least once already.
const BEEP_DATA_URI = "data:audio/wav;base64,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";
async function beepOnce() {
  try {
    // A fresh instance per beep (not a shared/reused one) — sidesteps any
    // race between resetting currentTime and a still-pending play()
    // promise from the previous beep, which could silently drop a beep.
    const audioEl = new Audio(BEEP_DATA_URI);
    await audioEl.play();
  } catch (err) {
    console.warn("[Tauzand Autofill] could not play alert sound:", err);
  }
}


async function alertHumanInterventionNeeded(reason) {
  console.warn("[Tauzand Autofill] human intervention needed:", reason);
  lastInterventionReason = reason;
  if (!AUDIO_ALERT_ENABLED) return;
  for (let i = 0; i < AUDIO_ALERT_REPEAT_COUNT; i++) {
    await beepOnce();
    await sleep(300);
  }
}
let lastInterventionReason = "";

// ---------- 3d. CAPTCHA / login-wall detection ----------
// Mirrors captcha_detector.py's DOM-selector + text-keyword layers. The OCR
// fallback (canvas-only challenges with no DOM/text signal) isn't ported —
// that needs a client-side OCR library (e.g. tesseract.js), which is a
// meaningfully heavier addition; flagged in the README as a known gap.
const CAPTCHA_SELECTORS = [
  "iframe[src*='recaptcha/api2/bframe']", // the actual interactive challenge frame (only appears when a real challenge is triggered)
  "iframe[title*='recaptcha challenge']",
  "iframe[src*='hcaptcha.com/captcha']",
  "div.g-recaptcha",
  "#captcha",
];
// NOTE: deliberately NOT using broad substring selectors like
// "[class*='captcha']" / "[id*='captcha']" or a bare "iframe[src*='recaptcha']"
// — Google Forms (and most Google properties) embed an invisible reCAPTCHA v3
// badge (class "grecaptcha-badge") purely for anti-spam scoring, with no
// challenge and no interaction ever required. It's a real, technically-visible
// element, so it slipped past the isVisible() check too — the broad selectors
// were matching it and stopping every run before any field got filled. Found
// during testing: the fix is precision in the selector itself, not visibility.
const CAPTCHA_KEYWORDS = ["not a robot", "verify you are human", "security check", "solve the challenge"];
// NOTE: deliberately dropped the bare words "captcha" / "recaptcha" /
// "hcaptcha" — Google Forms (and most Google properties) show a routine
// legal footer like "This site is protected by reCAPTCHA and the Google
// Privacy Policy..." on essentially every page, whether or not an actual
// challenge is active. That disclaimer text was matching the bare keyword
// and stopping every run. The remaining phrases only appear when a real,
// interactive challenge is actually being shown to the user.

const LOGIN_SELECTORS = ["input[type='password']", "button[data-automation-id='signInLink']"];
// Deliberately specific phrases only — same reasoning as the backend's
// LOGIN_KEYWORDS: a bare "sign in" false-positives on Google Forms' always
// present, harmless account-switch link.
const LOGIN_KEYWORDS = ["sign in to continue", "log in to continue", "please sign in", "authentication required"];

function pageTextLower() {
  return (document.body.innerText || "").toLowerCase();
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // Deliberately NOT checking element.offsetParent here — it's always null
  // for position:fixed elements regardless of whether they're actually
  // visible on screen, and Google Forms renders its dropdown's open option
  // list as a fixed-position floating menu. Relying on offsetParent was
  // silently treating every option in that menu as "not visible", so
  // "Preferred work location" (and any other custom dropdown) always found
  // zero candidate options and got skipped. Computed style is a reliable
  // check instead.
  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity) === 0) return false;
  return true;
}

async function checkForCaptcha() {
  for (const selector of CAPTCHA_SELECTORS) {
    const el = document.querySelector(selector);
    // Google Forms (and many Google properties) include a hidden invisible
    // reCAPTCHA badge / token element even when no visible challenge is
    // shown — matching purely on selector presence was stopping every run
    // before it ever reached the filling step. Only a genuinely visible
    // element counts as a real challenge.
    if (el && isVisible(el)) {
      await alertHumanInterventionNeeded(`CAPTCHA widget detected via selector '${selector}'`);
      return true;
    }
  }
  const text = pageTextLower();
  for (const keyword of CAPTCHA_KEYWORDS) {
    if (text.includes(keyword)) {
      await alertHumanInterventionNeeded(`CAPTCHA-related text detected on page: '${keyword}'`);
      return true;
    }
  }
  return false;
}

async function checkForLoginWall() {
  for (const selector of LOGIN_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) {
      await alertHumanInterventionNeeded(`Login/auth field detected via selector '${selector}' — manual sign-in required`);
      return true;
    }
  }
  const text = pageTextLower();
  for (const keyword of LOGIN_KEYWORDS) {
    if (text.includes(keyword)) {
      await alertHumanInterventionNeeded(`Login-related text detected on page: '${keyword}'`);
      return true;
    }
  }
  return false;
}

// ---------- 4. Scan + fill text fields ----------
async function fillTextFields(container, config, profile) {
  const blocks = container.querySelectorAll(config.questionSelector);
  let filledCount = 0;

  for (const block of blocks) {
    const titleEl = block.querySelector(config.questionTitleSelector);
    const questionTitle = titleEl ? titleEl.textContent.trim() : "";
    if (!questionTitle) continue; // decorative/non-question block — same fix as Edge Case 3 on the backend

    // Skip blocks that are actually choice questions — those are handled
    // separately in fillChoiceFields().
    const hasChoiceElements =
      block.querySelector(config.radioSelector) ||
      block.querySelector(config.checkboxSelector) ||
      block.querySelector(config.selectSelector);
    if (hasChoiceElements) continue;

    const textInput = block.querySelector(config.textInputSelector);
    if (!textInput) continue;

    const { profileKey, score } = bestProfileMatch(questionTitle);
    if (score < MIN_TEXT_FIELD_CONFIDENCE) continue;
    const value = profile[profileKey];
    if (!value) continue;

    showToast(`Typing: ${questionTitle}`);
    await typeIntoField(textInput, value);
    filledCount++;
  }
  return filledCount;
}

// ---------- 5. Scan + fill choice fields (radio / checkbox / dropdown) ----------
async function fillChoiceFields(container, config, profile) {
  const blocks = container.querySelectorAll(config.questionSelector);
  let filledCount = 0;
  let flaggedForReview = 0;

  for (const block of blocks) {
    const titleEl = block.querySelector(config.questionTitleSelector);
    const questionTitle = titleEl ? titleEl.textContent.trim() : "";
    if (!questionTitle) continue;

    const radioOptions = [...block.querySelectorAll(config.radioSelector)];
    const checkboxOptions = [...block.querySelectorAll(config.checkboxSelector)];
    const dropdownTriggers = [...block.querySelectorAll(config.selectSelector)];
    if (!radioOptions.length && !checkboxOptions.length && !dropdownTriggers.length) continue;

    const allOptionTexts = [...radioOptions, ...checkboxOptions].map(optionTextFor);

    // Legal / consent questions are always left for the user — same rule as
    // the backend's _is_legal_consent_group() — and now actually beeps too,
    // matching alert_human_intervention_needed() being called for this
    // exact case in form_filler.py (previously this was silent in the
    // extension).
    if (isLegalConsentGroup(questionTitle, allOptionTexts)) {
      await alertHumanInterventionNeeded(`Legal/consent checkbox requires manual review: ${questionTitle}`);
      flaggedForReview++;
      continue;
    }

    const { profileKey, score } = bestProfileMatch(questionTitle);
    if (score < CHOICE_MATCH_MIN_CONFIDENCE) {
      flaggedForReview++;
      continue;
    }
    let profileValue = profile[profileKey];
    if (!profileValue) continue;

    // Checkbox groups: "skills" etc. may be a comma-separated string in the
    // profile, not a real array — same fix as Edge Case 5 on the backend.
    if (checkboxOptions.length && typeof profileValue === "string" && /[,;]/.test(profileValue)) {
      profileValue = profileValue.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    }

    if (checkboxOptions.length && Array.isArray(profileValue)) {
      const optionPairs = checkboxOptions.map((el) => ({ text: optionTextFor(el), element: el }));
      const alreadySelectedTexts = new Set(); // prevents re-matching (and un-toggling) the same box — Edge Case 6 fix
      for (const valueItem of profileValue) {
        const availablePairs = optionPairs.filter((p) => !alreadySelectedTexts.has(p.text));
        const match = selectMatchingOption(availablePairs, valueItem);
        if (!match) continue;
        match.element.click();
        alreadySelectedTexts.add(match.text);
        filledCount++;
        await sleep(CHOICE_CLICK_DELAY_MS);
      }
    } else if (radioOptions.length) {
      const optionPairs = radioOptions.map((el) => ({ text: optionTextFor(el), element: el }));
      const match = selectMatchingOption(optionPairs, profileValue);
      if (match) {
        match.element.click();
        filledCount++;
        await sleep(CHOICE_CLICK_DELAY_MS);
      }
    } else if (dropdownTriggers.length) {
      const dropdown = dropdownTriggers[0];
      if (dropdown.tagName === "SELECT") {
        const optionPairs = [...dropdown.options].map((opt) => ({ text: opt.textContent, element: opt }));
        const match = selectMatchingOption(optionPairs, profileValue);
        if (match) {
          dropdown.value = match.element.value;
          dropdown.dispatchEvent(new Event("change", { bubbles: true }));
          filledCount++;
          await sleep(CHOICE_CLICK_DELAY_MS);
        }
      } else {
        // Custom (non-<select>) dropdown — Google Forms renders this as a
        // div[role='listbox'] gated by jsaction, which ignores synthetic
        // (untrusted) clicks. trustedClick() routes through chrome.debugger
        // (CDP) instead of dispatchEvent(), so this actually opens it.
        console.log(`[Tauzand Autofill] opening dropdown for "${questionTitle}", target value: "${profileValue}"`);

        try {
          await trustedClick(dropdown);

          // Poll for the options list to finish rendering.
          let optionElements = [];
          let previousCount = -1;
          const pollStart = Date.now();
          while (Date.now() - pollStart < 1500) {
            await sleep(120);
            optionElements = [...document.querySelectorAll("div[role='option']")].filter(isVisible);
            if (optionElements.length > 0 && optionElements.length === previousCount) break;
            previousCount = optionElements.length;
          }

          const optionPairs = optionElements.map((el) => ({ text: optionTextFor(el), element: el }));
          const match = selectMatchingOption(optionPairs, profileValue);
          if (match) {
            await trustedClick(match.element);
            filledCount++;
          } else {
            await trustedClick(document.body); // close the dropdown again so it isn't left open
            highlightForManualReview(dropdown, questionTitle);
            flaggedForReview++;
          }
        } catch (err) {
          // Trusted-click service unavailable for some reason (debugger
          // permission denied, attach failed, etc.) — fall back to the
          // safe, visible manual-review path instead of leaving the field
          // in an unknown state.
          console.warn(`[Tauzand Autofill] trusted click failed for "${questionTitle}":`, err);
          highlightForManualReview(dropdown, questionTitle);
          flaggedForReview++;
        }
        await sleep(CHOICE_CLICK_DELAY_MS);
      }
    }
  }
  return { filledCount, flaggedForReview };
}

// ---------- 6. Orchestration ----------
async function runAutofill(profileId) {
  showToast("Fetching your profile...");
  let profile;
  try {
    const data = await chrome.runtime.sendMessage({ type: "FETCH_PROFILE", profileId });
    if (!data || !data.success) throw new Error((data && data.error) || "Unknown error");
    profile = data.profile;
  } catch (err) {
    showToast("Could not load profile — check backend is running");
    console.error("[Tauzand Autofill] profile fetch failed:", err);
    return;
  }

  const config = PLATFORM_SELECTORS[platformKey];

  showToast("Checking for CAPTCHA/login wall...");
  try {
    const captchaFound = await checkForCaptcha();
    const loginWallFound = !captchaFound && (await checkForLoginWall());
    if (captchaFound || loginWallFound) {
      showToast(`\u26A0\uFE0F Stopped — ${lastInterventionReason}`);
      return; // matches run_fill() on the backend: never attempts to fill past this point
    }

    // Needed for trustedClick() on jsaction-gated widgets (e.g. Google
    // Forms' custom dropdown) — see the comment in background.js for why a
    // content script's own dispatchEvent() clicks don't work on these.
    await chrome.runtime.sendMessage({ type: "DEBUGGER_ATTACH" });

    showToast("Filling form...");
    console.log("[Tauzand Autofill] question blocks found:", document.querySelectorAll(config.questionSelector).length);

    const textFilledCount = await fillTextFields(document, config, profile);
    console.log("[Tauzand Autofill] text fields filled:", textFilledCount);

    showToast("Re-checking for CAPTCHA/login wall...");
    const captchaAppearedMidFill = await checkForCaptcha();
    const loginWallAppearedMidFill = !captchaAppearedMidFill && (await checkForLoginWall());
    if (captchaAppearedMidFill || loginWallAppearedMidFill) {
      showToast(`\u26A0\uFE0F Stopped after filling ${textFilledCount} fields — CAPTCHA/login appeared, please complete manually`);
      return;
    }

    const { filledCount: choiceFilledCount, flaggedForReview } = await fillChoiceFields(document, config, profile);

    const totalFilled = textFilledCount + choiceFilledCount;
    showToast(
      flaggedForReview > 0
        ? `\u2705 Filled ${totalFilled} fields — ${flaggedForReview} left for you to review`
        : `\u2705 Filled ${totalFilled} fields`
    );
  } catch (err) {
    // Previously an error here (e.g. a selector mismatch) would leave the
    // banner stuck on "Filling form..." forever with no visible sign of
    // why nothing got typed. Surfacing it directly makes the actual cause
    // diagnosable from the page instead of only from the console.
    console.error("[Tauzand Autofill] fill failed:", err);
    showToast(`\u274C Error: ${err.message || err}`);
  } finally {
    // Detach so Chrome's debugging infobar doesn't linger on the page after
    // the run finishes.
    chrome.runtime.sendMessage({ type: "DEBUGGER_DETACH" }).catch(() => {});
  }
}
