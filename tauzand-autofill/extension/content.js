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
console.log("[Tauzand Autofill] content script loaded on:", window.location.href, "| detected platform:", platformKey, "| top frame:", window.self === window.top);
if (platformKey) {
  const hasIframes = document.querySelectorAll("iframe").length > 0;
  if (!hasIframes) {
    // The common case — no iframes on this page at all, so there's no
    // ambiguity about which frame should show the banner. Show it
    // immediately, same as the original behavior, instead of waiting.
    initAutofill();
  } else {
    // This page has at least one iframe — the actual form content could be
    // in the top frame, in an iframe, or (rarely) both, so poll for real
    // fields in THIS frame before deciding whether to show a banner here.
    // Confirmed via testing that this is genuinely needed on some pages
    // (Ashby's careers-page embed) and that render timing varies a lot —
    // some pages load several slow third-party scripts (gsap, FullStory,
    // Clearbit) that delay the real form's React render by several seconds.
    (async () => {
      const config = PLATFORM_SELECTORS[platformKey];
      let hasAnyFields = false;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 6000) {
        if (config && document.querySelectorAll(config.questionSelector).length > 0) {
          hasAnyFields = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (hasAnyFields) {
        console.log("[Tauzand Autofill] real fields found in this frame — showing banner here");
        initAutofill();
      } else {
        console.log("[Tauzand Autofill] no matching fields in this frame after waiting — skipping banner here");
      }
    })();
  }
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
let watchdogStarted = false;

function injectBanner(onClick) {
  createBanner(onClick);

  // Set up the persistent watchdog + MutationObserver exactly once, no
  // matter how many times injectBanner()/createBanner() itself gets called
  // afterward by the watchdog re-creating a missing banner — otherwise each
  // recreation would add ANOTHER interval and observer on top of the
  // existing ones, stacking up over time instead of just doing the job once.
  if (watchdogStarted) return;
  watchdogStarted = true;

  const bodyObserver = new MutationObserver(() => {
    if (!document.getElementById("tauzand-autofill-banner")) {
      console.log("[Tauzand Autofill] banner was removed from the page (likely a re-render) — re-injecting");
      createBanner(onClick);
    }
  });
  bodyObserver.observe(document.documentElement, { childList: true });

  // The banner keeps disappearing entirely from the DOM (confirmed via
  // console: document.getElementById('tauzand-autofill-banner') returns
  // null after a few seconds) — Greenhouse's Remix app appears to trigger
  // repeated internal navigations/reloads after the initial load (visible
  // in DevTools as "Navigated to ..." markers), each of which can tear down
  // the whole document context the banner and MutationObserver were
  // attached to. Rather than chase the exact cause further, this is a
  // permanent watchdog: check every second, for as long as the page is
  // open, and recreate the banner from scratch if it's missing. This is
  // robust regardless of why it disappeared, since it doesn't depend on
  // catching a specific removal event that a full context teardown could
  // also wipe out along with everything else.
  //
  // Also tracks the URL: Workday's multi-page apply flow (My Information ->
  // My Experience -> Application Questions -> ...) is a single-page app —
  // the banner element itself survives page-to-page, but its text was
  // staying stuck on the PREVIOUS page's result ("Filled 11 fields...")
  // instead of resetting to the fresh prompt, which looked broken/confusing
  // even though clicking it still worked. Detecting a URL change and
  // resetting the banner's text fixes this.
  let lastKnownUrl = window.location.href;
  setInterval(() => {
    if (!document.getElementById("tauzand-autofill-banner")) {
      createBanner(onClick);
      lastKnownUrl = window.location.href;
      return;
    }
    if (window.location.href !== lastKnownUrl) {
      console.log("[Tauzand Autofill] URL changed (new page/step) — resetting banner to fresh prompt");
      lastKnownUrl = window.location.href;
      const statusLine = document.getElementById("tauzand-autofill-banner-status");
      if (statusLine) statusLine.textContent = "\u26A1 Autofill this form";
    }
  }, 1000);
}

function createBanner(onClick) {
  if (document.getElementById("tauzand-autofill-banner")) return; // avoid double-inject

  const banner = document.createElement("div");
  banner.id = "tauzand-autofill-banner";
  Object.assign(banner.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    background: "#1F4E79",
    color: "#ffffff",
    padding: "16px 20px",
    borderRadius: "12px",
    fontFamily: "system-ui, sans-serif",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
    width: "300px",
  });

  // Separate status line — this is what showToast() updates, so the
  // disclaimer below it survives every status change instead of being
  // wiped out along with the message text.
  const statusLine = document.createElement("div");
  statusLine.id = "tauzand-autofill-banner-status";
  statusLine.textContent = "\u26A1 Autofill this form";
  Object.assign(statusLine.style, {
    fontSize: "16px",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "normal",
  });
  banner.appendChild(statusLine);

  // Persistent disclaimer — required per Chawal's instructions. A subtle
  // divider + extra spacing + softer color separates it visually from the
  // status line above, instead of the two running together.
  const disclaimer = document.createElement("div");
  disclaimer.id = "tauzand-autofill-banner-disclaimer";
  Object.assign(disclaimer.style, {
    fontSize: "11.5px",
    fontWeight: "400",
    marginTop: "10px",
    paddingTop: "10px",
    borderTop: "1px solid rgba(255,255,255,0.25)",
    color: "rgba(255,255,255,0.75)",
    lineHeight: "1.5",
    whiteSpace: "normal",
  });
  disclaimer.innerHTML =
    'Always verify the content before final submitting. ' +
    '<a href="https://www.tauzand.in/terms-and-conditions" target="_blank" rel="noopener noreferrer" style="color:#ffffff;text-decoration:underline;">Terms &amp; Conditions</a>';
  // Stop the click from bubbling up to the banner's own click handler —
  // otherwise clicking the T&C link would also trigger autofill.
  disclaimer.addEventListener("click", (e) => e.stopPropagation());
  banner.appendChild(disclaimer);

  banner.addEventListener("click", onClick);
  document.documentElement.appendChild(banner);
  console.log("[Tauzand Autofill] banner appended to page, present in DOM:", !!document.getElementById("tauzand-autofill-banner"));
}

function showToast(message) {
  // Targets just the status line, not the whole banner, so the persistent
  // disclaimer below it isn't wiped out on every status update.
  const statusLine = document.getElementById("tauzand-autofill-banner-status");
  if (statusLine) statusLine.textContent = message;
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

// Same React-safe principle as setFieldValue(), but for <select> elements.
// A plain `select.value = x` can be silently ignored (or reverted on the
// next render) if the select is React-controlled, same underlying issue
// text inputs had.
function setSelectValue(select, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  nativeSetter.call(select, value);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

// Clicks the associated <label> instead of a bare radio/checkbox <input>
// directly, when one exists. Confirmed via Ashby's Pronouns question: the
// visible "_checked_" styling and (very likely) the actual click handler
// live on the <label for="...">, not the underlying input — clicking the
// raw input wasn't registering as a real selection even though it's a
// genuine native radio element.
function clickOption(element) {
  // Find the underlying native input, if this option has one, so we can
  // VERIFY a click actually did something instead of just assuming success
  // because .click() didn't throw. Confirmed necessary via testing: the
  // extension was reporting fields as filled while nothing visibly changed
  // on Ashby's checkbox/radio-group questions — the outer container's
  // click() was firing without error, but wasn't actually toggling
  // Ashby's real (React-managed) selected state.
  const input = element.matches("input") ? element : element.querySelector("input[type='radio'], input[type='checkbox']");

  if (!input) {
    // No native input to verify against — e.g. the plain Yes/No button
    // widget, which has no nested input at all and already works fine
    // with a direct click.
    element.click();
    return;
  }

  const wasChecked = input.checked;

  // Strategy 1: click whatever element was matched (could be the outer
  // container, a <label>, or the input itself depending on the caller).
  element.click();
  if (input.checked !== wasChecked) {
    console.log("[Tauzand Autofill] clickOption: strategy 1 (direct click) worked");
    return;
  }

  // Strategy 2: click the associated <label for="id">.
  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label) {
      label.click();
      if (input.checked !== wasChecked) {
        console.log("[Tauzand Autofill] clickOption: strategy 2 (label click) worked");
        return;
      }
    }
  }

  // Strategy 3: click the inner wrapping <span> one level in (Ashby wraps
  // the actual input in a styled <span class="_container_..."> alongside a
  // decorative circle/checkmark icon — the real click handler may live
  // there instead of on the outer element).
  const innerSpan = element.querySelector("span");
  if (innerSpan) {
    innerSpan.click();
    if (input.checked !== wasChecked) {
      console.log("[Tauzand Autofill] clickOption: strategy 3 (inner span click) worked");
      return;
    }
  }

  // Last resort: directly toggle the native input's checked state via the
  // React-safe native property setter (same principle as setFieldValue()
  // for text inputs), then fire both click and change events so React's
  // controlled-component tracking picks up the change even if nothing
  // else above found the real handler.
  console.log("[Tauzand Autofill] clickOption: falling back to direct checked-property toggle");
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
  nativeSetter.call(input, !wasChecked);
  input.dispatchEvent(new Event("click", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Falls back to a related field when the requested one is empty — e.g.
// there's no separate "city" value in Supabase, only "current_location", so
// a "City" question reuses that instead of being left blank/manual.
function resolveProfileValue(profile, profileKey) {
  let value = profile[profileKey];
  if (!value && profileKey === "city") {
    value = profile.current_location;
  }
  return typeof value === "string" ? value.trim() : value;
}

function optionTextFor(element) {
  const ariaLabel = (element.getAttribute("aria-label") || "").trim();
  if (ariaLabel) return ariaLabel;

  // Bare <input type="radio"/"checkbox"> elements always have empty
  // textContent — their visible label (e.g. "He/Him") lives in a separate
  // <label>, associated either via a matching for="id" or by wrapping the
  // input directly. Without this, every such radio/checkbox option came
  // back as an empty string and could never match anything (confirmed via
  // Ashby's Pronouns question, which uses this exact pattern).
  if (element.tagName === "INPUT") {
    if (element.id) {
      const associatedLabel = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (associatedLabel && associatedLabel.textContent.trim()) return associatedLabel.textContent.trim();
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel && wrappingLabel.textContent.trim()) return wrappingLabel.textContent.trim();
    const parent = element.parentElement;
    if (parent && parent.textContent.trim()) return parent.textContent.trim();
    return (element.value || "").trim();
  }

  return (element.textContent || element.value || "").trim();
}

// Asks background.js to click a real screen position through the Chrome
// DevTools Protocol (see background.js's trusted-click service comment for
// why this is needed instead of a plain element.click()).
async function trustedClick(element) {
  // Confirmed via testing: fields further down a long form (Gender,
  // Veteran Status, Graduation Date) were reliably failing to open while
  // earlier fields on the same page (Location, Sponsorship) worked fine —
  // the click coordinates are computed from getBoundingClientRect(), which
  // is relative to the current scroll position, so an element sitting
  // below the visible viewport gets clicked at the wrong on-screen spot
  // (or nothing at all). Scrolling it into view first fixes this.
  element.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(150); // let the scroll (and any resulting layout/animation) settle before measuring position

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

// For these profile fields, a comma-separated value list means "try in
// priority order, stop at the first one that matches" — not "select every
// matching one". Confirmed via testing on Workday: selecting "Social Media"
// then searching for "LinkedIn" (which doesn't exist as a separate option
// on that company's form) left the field looking empty/broken instead of
// keeping the first successful pick. referral_source is a priority list by
// nature (how did you hear about us — pick the best single answer), unlike
// "skills" or "languages" where selecting every match is actually wanted.
const PRIORITY_ONLY_FIELDS = new Set(["referral_source"]);

async function typeIntoField(element, value) {
  const text = String(value);
  element.focus();
  let typedSoFar = "";
  for (const char of text) {
    typedSoFar += char;
    // Some autocomplete widgets (confirmed on Lever's plain-JS "Current
    // Location" field, as opposed to Ashby/Greenhouse's React-based
    // comboboxes) trigger their search specifically off real keyboard
    // events, not just a value/input change — dispatching keydown/keyup
    // alongside the value change covers both cases without affecting
    // widgets that only needed the input/change events already being sent.
    element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
    setFieldValue(element, typedSoFar);
    element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    const delay = TYPE_DELAY_MIN_MS + Math.random() * (TYPE_DELAY_MAX_MS - TYPE_DELAY_MIN_MS);
    await sleep(delay);
  }
}

// For ARIA-combobox autocomplete inputs (role="combobox",
// aria-autocomplete="list") — confirmed via testing that typing alone
// isn't enough: Ashby's "Current Location" field resets back to blank if
// no suggestion is actually selected from the dropdown that opens while
// typing, the same underlying issue as Google Forms' custom dropdown
// (a plain typed value never becomes a "real" selection in the widget's
// own state). Types the value, waits for the suggestion list to render,
// then clicks the best-matching suggestion (or the first one, if nothing
// scores well — usually still the most relevant result for a location
// search). Returns true if a suggestion was clicked, false if none
// appeared at all (e.g. too short/generic a query, or a network hiccup).
// For multi-select comboboxes (e.g. "How did you hear" when the profile
// value is a comma-separated list) — selects one option per value in
// sequence, reusing a single debugger attachment for the whole field
// instead of attaching/detaching per value.
async function fillMultiComboboxField(input, values, profileKey) {
  let selectedAny = false;
  try {
    for (const value of values) {
      await trustedClick(input);
      await sleep(200);
      await typeIntoField(input, value);
      await sleep(250);

      let optionElements = [];
      let previousCount = -1;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 1500) {
        await sleep(150);
        optionElements = [...document.querySelectorAll("[role='option']:not([id^='pill-']), [class*='__option'], .dropdown-results > *")].filter(isVisible);
        if (optionElements.length > 0 && optionElements.length === previousCount) break;
        previousCount = optionElements.length;
      }
      console.log(`[Tauzand Autofill] multi-combobox suggestions found for "${value}":`, optionElements.map(optionTextFor));

      if (optionElements.length > 0) {
        const optionPairs = optionElements.map((el) => ({ text: optionTextFor(el), element: el }));
        const match = selectMatchingOption(optionPairs, value);
        if (match) {
          await trustedClick(match.element);
          selectedAny = true;
          await sleep(CHOICE_CLICK_DELAY_MS);
          if (PRIORITY_ONLY_FIELDS.has(profileKey)) break; // e.g. referral_source: first match wins, don't try the rest
        }
      }
      // Clear the input text before the next value, in case the menu
      // stayed open with leftover query text from this attempt.
      setFieldValue(input, "");
    }
    return selectedAny;
  } catch (err) {
    console.warn(`[Tauzand Autofill] multi-combobox fill failed:`, err);
    return selectedAny;
  }
}

async function fillComboboxField(input, value) {
  try {
    // Confirmed via testing: react-select's menu does not open from
    // synthetic focus()/typing alone — the same underlying issue as Google
    // Forms' jsaction-gated dropdown (the widget's open-trigger appears to
    // require a genuinely trusted mousedown/click, which a content
    // script's own dispatchEvent() can never produce). A real click via
    // chrome.debugger fixes it.
    await trustedClick(input);
    await sleep(200);

    // Type the full value first — our own fuzzy matching (selectMatchingOption)
    // below picks the closest option from whatever renders, rather than
    // needing an exact match. Only if the FULL value renders zero options
    // at all (react-select's own filter found nothing containing it — e.g.
    // "Undergraduate/Bachelors" typed against an option that's just
    // "Bachelors" is not a substring match either way) do we retry once
    // with a shorter piece of it, just to get *some* options on screen to
    // fuzzy-match against.
    async function pollForOptions() {
      let elements = [];
      let previousCount = -1;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 1500) {
        await sleep(150);
        // "[class*='__option']" added alongside role='option' — react-select
        // (used by both Ashby and Greenhouse's dropdowns) commonly names its
        // option elements with a BEM-style "{prefix}__option" class.
        elements = [...document.querySelectorAll("[role='option']:not([id^='pill-']), [class*='__option'], .dropdown-results > *")].filter(isVisible);
        if (elements.length > 0 && elements.length === previousCount) break;
        previousCount = elements.length;
      }
      return elements;
    }

    await typeIntoField(input, value);
    await sleep(300);
    let optionElements = await pollForOptions();

    if (optionElements.length === 0) {
      const parts = String(value).trim().split(/[\s/]+/).filter(Boolean);
      const shorterQuery = parts.length > 1 ? parts[parts.length - 1] : null; // e.g. "Bachelors" from "Undergraduate/Bachelors", or "2027" from "June 2027"
      if (shorterQuery) {
        console.log(`[Tauzand Autofill] combobox: full value "${value}" showed no options, retrying with "${shorterQuery}"`);
        setFieldValue(input, "");
        await sleep(100);
        await typeIntoField(input, shorterQuery);
        await sleep(300);
        optionElements = await pollForOptions();
      }
    }

    console.log(`[Tauzand Autofill] combobox suggestions found for "${value}":`, optionElements.map(optionTextFor));
    if (optionElements.length === 0) return false;

    const optionPairs = optionElements.map((el) => ({ text: optionTextFor(el), element: el }));
    const match = selectMatchingOption(optionPairs, value);
    const chosen = match || { element: optionElements[0] }; // fall back to the top suggestion if nothing scored well
    console.log(`[Tauzand Autofill] combobox best match for "${value}":`, optionTextFor(chosen.element));

    await trustedClick(chosen.element);
    await sleep(300);

    // Verify the selection actually registered — confirmed via testing
    // that a matched, clicked option can still leave the field empty (the
    // menu closes but the widget's displayed value never updates). Check
    // the control's visible "single value" text; if it doesn't show what
    // was just clicked, try a plain element.click() as a second attempt
    // before giving up.
    const control = input.closest(".select__control, [class*='__control']");
    const displayedValueFromControl = control?.querySelector(".select__single-value, [class*='__single-value']")?.textContent?.trim() || "";
    const displayedValueFromInput = (input.value || "").trim();
    const displayedValue = displayedValueFromControl || displayedValueFromInput;
    console.log(`[Tauzand Autofill] combobox displayed value after click: "${displayedValue}"`);
    if (!displayedValue) {
      console.log(`[Tauzand Autofill] selection didn't stick, retrying with a plain click`);
      chosen.element.click();
      await sleep(300);
    }

    return true;
  } catch (err) {
    console.warn(`[Tauzand Autofill] combobox fill failed for "${value}":`, err);
    return false;
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
// ---------- 3b. AI Suggest for long-answer (textarea) fields ----------
// Per instructions: for long-answer questions the confidence-matching
// system was never going to handle (e.g. "Best project you worked on",
// "Expected CTC"), offer an AI-drafted answer instead of leaving the field
// blank — but always require the user to review/edit and explicitly click
// Insert. Nothing from this path is ever auto-filled.
function addAiSuggestButton(textareaEl, questionTitle, profile) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "\u2728 AI Suggest";
  btn.dataset.tauzandAiButton = "true";
  Object.assign(btn.style, {
    display: "inline-block",
    marginTop: "6px",
    padding: "5px 12px",
    fontSize: "12px",
    fontWeight: "600",
    fontFamily: "system-ui, sans-serif",
    background: "#1F4E79",
    color: "#ffffff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  });

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const originalLabel = btn.textContent;
    btn.textContent = "Thinking...";
    btn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LLM_SUGGEST",
        question: questionTitle,
        profile,
      });
      if (response && response.success) {
        showSuggestionPopup(textareaEl, btn, response.suggestion);
      } else {
        alert(`Couldn't get an AI suggestion: ${(response && response.error) || "unknown error"}`);
      }
    } catch (err) {
      console.error("[Tauzand Autofill] AI suggest failed:", err);
      alert("Couldn't reach the backend for an AI suggestion — check it's running.");
    } finally {
      btn.textContent = originalLabel;
      btn.disabled = false;
    }
  });

  textareaEl.insertAdjacentElement("afterend", btn);
}

function showSuggestionPopup(textareaEl, anchorBtn, suggestion) {
  const existing = document.getElementById("tauzand-ai-suggestion-popup");
  if (existing) existing.remove();

  const popup = document.createElement("div");
  popup.id = "tauzand-ai-suggestion-popup";
  Object.assign(popup.style, {
    marginTop: "8px",
    padding: "12px",
    background: "#F0F6FF",
    border: "2px solid #1F4E79",
    borderRadius: "8px",
    fontFamily: "system-ui, sans-serif",
  });

  const label = document.createElement("div");
  label.textContent = "AI suggestion — edit as needed, then click Insert:";
  Object.assign(label.style, { fontSize: "12px", fontWeight: "600", marginBottom: "6px", color: "#1F4E79" });
  popup.appendChild(label);

  const editArea = document.createElement("textarea");
  editArea.value = suggestion;
  Object.assign(editArea.style, {
    width: "100%",
    minHeight: "110px",
    fontFamily: "inherit",
    fontSize: "13px",
    padding: "8px",
    borderRadius: "6px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
  });
  popup.appendChild(editArea);

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, { marginTop: "8px", display: "flex", gap: "8px" });

  const insertBtn = document.createElement("button");
  insertBtn.type = "button";
  insertBtn.textContent = "Insert";
  Object.assign(insertBtn.style, {
    padding: "6px 14px",
    fontSize: "13px",
    fontWeight: "600",
    background: "#1F4E79",
    color: "#ffffff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  });
  insertBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setFieldValue(textareaEl, editArea.value);
    popup.remove();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  Object.assign(cancelBtn.style, {
    padding: "6px 14px",
    fontSize: "13px",
    fontWeight: "600",
    background: "#ffffff",
    color: "#1F4E79",
    border: "1px solid #1F4E79",
    borderRadius: "6px",
    cursor: "pointer",
  });
  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    popup.remove();
  });

  btnRow.appendChild(insertBtn);
  btnRow.appendChild(cancelBtn);
  popup.appendChild(btnRow);

  (anchorBtn || textareaEl).insertAdjacentElement("afterend", popup);
}

async function fillTextFields(container, config, profile) {
  // Filtered to only currently-visible blocks — confirmed necessary on
  // Workday: its multi-page apply flow (My Information -> My Experience ->
  // ...) keeps EARLIER pages' fields in the DOM but hidden rather than
  // removing them, so an unfiltered scan was picking up stale fields from
  // steps already completed and inflating/corrupting the filled/flagged
  // counts shown on the banner.
  const blocks = [...container.querySelectorAll(config.questionSelector)].filter(isVisible);
  let filledCount = 0;
  let flaggedForReview = 0;

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
    if (!textInput) {
      // Real question, but not a text field we know how to fill (e.g. a
      // resume/cover-letter upload button). Never auto-filled — uploading a
      // file on someone's behalf is a much bigger risk than typing text —
      // but it's still a real field the user needs to handle, so it should
      // count as "left for review" instead of silently vanishing from every
      // total, which is what was happening before.
      const fileInput = block.querySelector("input[type='file']");
      if (fileInput) flaggedForReview++;
      continue;
    }

    const { profileKey, score } = bestProfileMatch(questionTitle);
    console.log(`[Tauzand Autofill] text question "${questionTitle}" -> matched key "${profileKey}" (score: ${score.toFixed(2)}, need >= ${MIN_TEXT_FIELD_CONFIDENCE})`);
    if (score < MIN_TEXT_FIELD_CONFIDENCE) {
      flaggedForReview++; // real text field, but couldn't confidently match it to a profile key
      // Long-answer questions (e.g. "Best project you worked on",
      // "Expected CTC") never match our fixed profile-field hints — offer
      // an AI-drafted answer instead of just leaving it blank. Scoped to
      // <textarea> only, per instructions.
      if (textInput.tagName === "TEXTAREA") {
        addAiSuggestButton(textInput, questionTitle, profile);
      }
      continue;
    }
    // "from" is a bare, generic hint (shared by Education's "From" field
    // and Work Experience's "From" field) — safe on a first run since Work
    // Experience's fields don't exist yet at this point, but on a second
    // run (after fillWorkExperienceSection has already created panels) this
    // guard stops a Work Experience "From" from being wrongly matched to
    // education_start_year, since Work Experience's own dates are filled
    // separately via exact data-automation-id matching, not this hint.
    if (profileKey === "education_start_year" && block.closest('[aria-labelledby*="Work-Experience"]')) {
      flaggedForReview++;
      continue;
    }
    // If the flexible multi-entry "education" array is populated, defer
    // entirely to fillEducationSection() for these fields — letting this
    // generic flat-field scan also touch the same Education panel risks
    // conflicting/duplicate fills (e.g. opening the same dropdown twice).
    const EDUCATION_ARRAY_FIELDS = new Set(["school", "degree_type", "field_of_study", "cgpa", "graduation_date", "education_start_year"]);
    const hasWorkdayEducationSection = !!document.querySelector('[aria-labelledby="Education-section"]');
    if (EDUCATION_ARRAY_FIELDS.has(profileKey) && profile.education && hasWorkdayEducationSection) {
      flaggedForReview++;
      continue;
    }
    const value = resolveProfileValue(profile, profileKey);
    if (!value) {
      // Matched a profile key correctly, but that field is empty in
      // Supabase — this used to be silently dropped from both counts,
      // which is why "4 left for review" was undercounting how many
      // fields actually needed manual attention.
      flaggedForReview++;
      continue;
    }

    showToast(`Typing: ${questionTitle}`);
    // Two signals for "this needs suggestion-selection, not just typing":
    // the ARIA combobox pattern (Ashby/Greenhouse's react-select widgets),
    // or a nearby dropdown-suggestions container without ARIA markers
    // (confirmed via inspection: Lever's location-input field has a
    // sibling .dropdown-container/.dropdown-results element but no
    // role="combobox" or aria-autocomplete attribute at all — typing alone
    // filled the visible text but Lever's own JS resets it back to blank
    // unless a suggestion is actually clicked, same underlying issue as
    // the ARIA comboboxes, just without the accessibility hooks to detect
    // it the same way).
    const isAriaCombobox = textInput.getAttribute("role") === "combobox" && textInput.getAttribute("aria-autocomplete") === "list";
    const hasDropdownSuggestions = !!block.querySelector("[class*='dropdown-container'], [class*='dropdown-results']");
    if (isAriaCombobox || hasDropdownSuggestions) {
      // A profile value like "Social Media, LinkedIn" is a multi-select
      // answer stored as a comma-separated string — same convention as
      // "skills" elsewhere. Previously this whole string was typed as a
      // single query into the combobox, which never matches any option
      // (no option is literally labeled "Social Media, LinkedIn"), so the
      // field silently stayed empty even though a value existed.
      const isMultiValue = typeof value === "string" && /[,;]/.test(value);
      let success;
      if (isMultiValue) {
        const values = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        success = await fillMultiComboboxField(textInput, values, profileKey);
      } else {
        success = await fillComboboxField(textInput, value);
      }
      if (success) filledCount++;
      else {
        flaggedForReview++;
        highlightForManualReview(textInput, questionTitle);
      }
    } else {
      // A bare Year spinbutton (e.g. Education's "To"/"From" fields, which
      // — unlike Work Experience's start/end dates — have no separate
      // Month input) needs just the 4-digit year, not the full profile
      // value (which might be a full date string like "1 June 2027").
      const isYearOnlySpinbutton =
        textInput.getAttribute("role") === "spinbutton" &&
        (textInput.getAttribute("data-automation-id") === "dateSectionYear-input" || textInput.getAttribute("aria-label") === "Year");
      let valueToType = value;
      if (isYearOnlySpinbutton) {
        const yearMatch = String(value).match(/\d{4}/);
        if (yearMatch) {
          valueToType = yearMatch[0];
          console.log(`[Tauzand Autofill] year-only spinbutton "${questionTitle}" — extracted "${valueToType}" from "${value}"`);
        } else {
          console.warn(`[Tauzand Autofill] year-only spinbutton "${questionTitle}" — couldn't find a 4-digit year in "${value}", flagging for review instead`);
          flaggedForReview++;
          highlightForManualReview(textInput, questionTitle);
          continue;
        }
      }
      await typeIntoField(textInput, valueToType);
      filledCount++;
    }
  }
  return { filledCount, flaggedForReview };
}

// ---------- 5. Scan + fill choice fields (radio / checkbox / dropdown) ----------
async function fillChoiceFields(container, config, profile) {
  // Same visibility filter as fillTextFields — see the comment there.
  const blocks = [...container.querySelectorAll(config.questionSelector)].filter(isVisible);
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
    console.log(`[Tauzand Autofill] choice question "${questionTitle}" -> matched key "${profileKey}" (score: ${score.toFixed(2)}, need >= ${CHOICE_MATCH_MIN_CONFIDENCE})`);
    if (score < CHOICE_MATCH_MIN_CONFIDENCE) {
      flaggedForReview++;
      continue;
    }
    // If the flexible multi-entry "education" array is populated, defer
    // entirely to fillEducationSection() for these fields — see the same
    // guard in fillTextFields for the full explanation.
    const EDUCATION_ARRAY_FIELDS_CHOICE = new Set(["school", "degree_type", "field_of_study", "cgpa", "graduation_date", "education_start_year"]);
    const hasWorkdayEducationSectionChoice = !!document.querySelector('[aria-labelledby="Education-section"]');
    if (EDUCATION_ARRAY_FIELDS_CHOICE.has(profileKey) && profile.education && hasWorkdayEducationSectionChoice) {
      flaggedForReview++;
      continue;
    }
    let profileValue = resolveProfileValue(profile, profileKey);
    if (!profileValue) {
      flaggedForReview++; // matched a profile key correctly, but it's empty in Supabase — still needs the user's attention
      continue;
    }

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
        console.log(`[Tauzand Autofill] checkbox question "${questionTitle}" — clicking "${match.text}" for value "${valueItem}"`);
        clickOption(match.element);
        alreadySelectedTexts.add(match.text);
        filledCount++;
        await sleep(CHOICE_CLICK_DELAY_MS);
        if (PRIORITY_ONLY_FIELDS.has(profileKey)) break; // e.g. referral_source: first match wins, don't try the rest
      }
    } else if (radioOptions.length) {
      const optionPairs = radioOptions.map((el) => ({ text: optionTextFor(el), element: el }));
      const match = selectMatchingOption(optionPairs, profileValue);
      if (match) {
        clickOption(match.element);
        filledCount++;
        await sleep(CHOICE_CLICK_DELAY_MS);
      }
    } else if (dropdownTriggers.length) {
      let dropdown = dropdownTriggers[0];
      if (dropdown.tagName === "SELECT") {
        const optionPairs = [...dropdown.options].map((opt) => ({ text: opt.textContent, element: opt }));
        console.log(`[Tauzand Autofill] native <select> "${questionTitle}" options:`, optionPairs.map((p) => p.text), "| target value:", profileValue);
        const match = selectMatchingOption(optionPairs, profileValue);
        console.log(`[Tauzand Autofill] native <select> best match:`, match ? match.text : "none found");
        if (match) {
          setSelectValue(dropdown, match.element.value);
          filledCount++;
          await sleep(CHOICE_CLICK_DELAY_MS);
        } else {
          flaggedForReview++;
          highlightForManualReview(dropdown, questionTitle);
        }
      } else {
        // Custom (non-<select>) dropdown — Google Forms renders this as a
        // div[role='listbox'] gated by jsaction, which ignores synthetic
        // (untrusted) clicks. trustedClick() routes through chrome.debugger
        // (CDP) instead of dispatchEvent(), so this actually opens it.
        //
        // Attach/detach are scoped tightly around just this interaction
        // (not held for the whole run) so Chrome's "debugging this browser"
        // infobar only flashes for a second or two here, instead of staying
        // visible for the entire fill.
        const cleanedValue = String(profileValue).trim();
        console.log(`[Tauzand Autofill] opening dropdown for "${questionTitle}", target value: "${cleanedValue}"`);

        try {
          await trustedClick(dropdown);
          await sleep(200);
          console.log(`[Tauzand Autofill] dropdown aria-expanded after trusted click:`, dropdown.getAttribute("aria-expanded"));

          // Confirmed via inspection: this can be a type-to-search widget
          // (placeholder="Search") — clicking alone only shows a default/
          // empty-state set of options, not real filtered results. If a
          // search input exists inside (or is) the trigger, type into it.
          function findSearchInput() {
            if (dropdown.tagName === "INPUT") return dropdown;
            return dropdown.querySelector("input");
          }

          async function pollForVisibleOptions() {
            let elements = [];
            let previousCount = -1;
            const pollStart = Date.now();
            while (Date.now() - pollStart < 1500) {
              await sleep(120);
              // "[data-automation-id='promptOption']" added alongside
              // role='option' — confirmed via inspection that Workday's open
              // dropdown options use this data attribute instead of an ARIA
              // role.
              elements = [...document.querySelectorAll("[role='option']:not([id^='pill-']), [data-automation-id='promptOption']")].filter(isVisible);
              if (elements.length > 0 && elements.length === previousCount) break;
              previousCount = elements.length;
            }
            return elements;
          }

          async function searchAndPoll(query) {
            const searchInput = findSearchInput();
            console.log(`[Tauzand Autofill] search input for "${query}":`, searchInput ? `<${searchInput.tagName} id="${searchInput.id}" placeholder="${searchInput.placeholder}">` : "NONE FOUND (dropdown itself:", dropdown.outerHTML.slice(0, 150) + ")");
            if (searchInput) {
              setFieldValue(searchInput, ""); // clear any leftover text from a previous value first
              await sleep(80);
              await typeIntoField(searchInput, query);
              await sleep(200);
              // Confirmed via testing: Workday's search filter only
              // properly applies once Enter is pressed — without this, the
              // "results" shown weren't actually filtered by the typed
              // query at all (e.g. searching "Software Engineering" was
              // returning unrelated options like "Aerospace Engineering").
              searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
              searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
              await sleep(300);
              console.log(`[Tauzand Autofill] search input value after typing "${query}":`, searchInput.value);
            }
            const result = await pollForVisibleOptions();
            console.log(`[Tauzand Autofill] options after searching "${query}":`, result.map(optionTextFor).join(" | "));
            return result;
          }

          const isMultiValue = /[,;]/.test(cleanedValue);
          if (isMultiValue) {
            // e.g. "Social Media, LinkedIn" — click each match in turn.
            // Only clicks the dropdown open when no options are currently
            // visible — checking dropdown.getAttribute("aria-expanded")
            // instead was unreliable here (confirmed via testing: it's
            // always null on this widget, so that check always forced a
            // redundant re-click, which toggled an already-open menu
            // closed right when searching for the next value, making every
            // value after the first fail to find any options at all).
            const values = cleanedValue.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
            let selectedAny = false;
            for (const val of values) {
              // Re-fetch fresh each time — confirmed via testing that after
              // selecting one match, the widget re-renders and detaches the
              // old dropdown/input reference, so reusing it for later
              // values silently types into a disconnected element.
              const freshDropdown = block.querySelector(config.selectSelector);
              if (freshDropdown) dropdown = freshDropdown;

              // Always click before searching — confirmed via testing that
              // checking "are options already visible" first gives a false
              // positive once one value has been selected: the selected
              // item's own chip/pill element also matches the generic
              // option selector, so the check thought the menu was already
              // open and skipped reopening it.
              //
              // Click the promptIcon (the chevron toggle) specifically —
              // confirmed via testing that clicking the input directly, and
              // separately clicking the outer wrapper, both failed
              // identically (every search after the first kept returning
              // only the already-selected item's own chip, never real
              // results). This suggests the widget's "open/reopen the
              // dropdown" logic isn't bound to focusing the input at all —
              // promptIcon is a distinct toggle element present in this
              // same widget pattern elsewhere (e.g. Degree's caret-down).
              const promptIcon = dropdown.querySelector('[data-automation-id="promptIcon"]') || block.querySelector('[data-automation-id="promptIcon"]');
              const searchInputForClick = findSearchInput();
              const clickTarget = promptIcon || searchInputForClick || dropdown;
              console.log(`[Tauzand Autofill] clicking for "${val}":`, promptIcon ? "promptIcon" : searchInputForClick ? "search input" : "dropdown wrapper");
              await trustedClick(clickTarget);
              await sleep(200);
              if (searchInputForClick) searchInputForClick.focus();
              const currentOptions = await searchAndPoll(val);
              const currentPairs = currentOptions.map((el) => ({ text: optionTextFor(el), element: el }));
              const currentMatch = selectMatchingOption(currentPairs, val);
              console.log(`[Tauzand Autofill] multi-value match for "${val}" (${currentOptions.length} option(s): ${currentPairs.map((p) => p.text).join(" | ")}):`, currentMatch ? currentMatch.text : "none found");
              if (currentMatch) {
                await trustedClick(currentMatch.element);
                selectedAny = true;
                filledCount++;
                await sleep(CHOICE_CLICK_DELAY_MS);
                if (PRIORITY_ONLY_FIELDS.has(profileKey)) break; // e.g. referral_source: first match wins, don't try the rest
              }
            }
            if (!selectedAny) {
              highlightForManualReview(dropdown, questionTitle);
              flaggedForReview++;
            }
          } else {
            const optionElements = await searchAndPoll(cleanedValue);
            console.log(`[Tauzand Autofill] found ${optionElements.length} visible option(s):`, optionElements.map(optionTextFor));

            const optionPairs = optionElements.map((el) => ({ text: optionTextFor(el), element: el }));
            const match = selectMatchingOption(optionPairs, cleanedValue);
            console.log(`[Tauzand Autofill] best match for "${cleanedValue}":`, match ? match.text : "none found");
            if (match) {
              await trustedClick(match.element);
              filledCount++;
            } else {
              await trustedClick(document.body); // close the dropdown again so it isn't left open
              highlightForManualReview(dropdown, questionTitle);
              flaggedForReview++;
            }
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
// ---------- 6. Work Experience (repeatable section) ----------
// Confirmed via live DOM inspection (Workday): each entry's fields carry a
// stable data-automation-id (formField-jobTitle, formField-companyName,
// formField-location, formField-currentlyWorkHere, formField-startDate,
// formField-endDate, formField-roleDescription) that's unique to this
// section — Education's date fields use different automation-ids
// (formField-firstYearAttended / formField-lastYearAttended), so there's no
// risk of cross-matching between the two sections the way there would be
// with generic text-label hints (both sections show a bare "From"/"To"
// label). This lets us skip fuzzy hint-matching entirely for this section
// and query directly instead.
// Gets the panel at position `index` (0-based) within a repeatable section,
// clicking the section's "Add" button first ONLY if that panel doesn't
// already exist. Handles both cases seen across different Workday tenants:
// some show "Entry 1" by default with no Add needed, others start
// completely empty and need Add clicked even for the first entry.
async function getOrCreatePanel(section, panelSelector, addButtonSelector, index) {
  let panels = section.querySelectorAll(panelSelector);
  if (panels.length > index) return panels[index]; // already exists — no click needed

  const addButton = section.querySelector(addButtonSelector);
  if (!addButton) return null;
  addButton.click();

  // Poll instead of a fixed wait — confirmed via testing that the first
  // "Add" click can take noticeably longer than later ones to render the
  // new panel.
  const pollStart = Date.now();
  while (panels.length <= index && Date.now() - pollStart < 2500) {
    await sleep(150);
    panels = section.querySelectorAll(panelSelector);
  }
  return panels.length > index ? panels[index] : null;
}

async function fillEducationSection(profile) {
  let entries = profile.education;
  console.log("[Tauzand Autofill] profile.education raw value:", entries, "| type:", typeof entries, "| is array:", Array.isArray(entries));
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
      console.log("[Tauzand Autofill] parsed education string into:", entries);
    } catch (err) {
      console.warn("[Tauzand Autofill] education was a string but not valid JSON:", err);
      entries = null;
    }
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.log("[Tauzand Autofill] no education entries to fill — skipping this section");
    return { filledCount: 0, flaggedForReview: 0 };
  }

  const section = document.querySelector('[aria-labelledby="Education-section"]');
  if (!section) {
    console.log("[Tauzand Autofill] no Education section found on this page — skipping");
    return { filledCount: 0, flaggedForReview: 0 };
  }

  let filledCount = 0;
  let flaggedForReview = 0;
  const panelSelector = '[aria-labelledby^="Education-"][aria-labelledby$="-panel"]';

  async function pollOptions() {
    let options = [];
    let previousCount = -1;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 1500) {
      await sleep(150);
      options = [...document.querySelectorAll("[role='option']:not([id^='pill-']), [data-automation-id='promptOption']")].filter(isVisible);
      if (options.length > 0 && options.length === previousCount) break;
      previousCount = options.length;
    }
    return options;
  }

  // School and Field of Study are search-type comboboxes — same widget as
  // the platform-wide "Field of Study"/"How Did You Hear" pattern, so this
  // reuses the same type + Enter + poll + match approach proven working
  // there.
  async function fillSearchCombobox(panel, fieldName, value) {
    if (!value) return false;
    const wrapper = panel.querySelector(`[data-automation-id="formField-${fieldName}"]`);
    if (!wrapper) {
      console.warn(`[Tauzand Autofill] Education field "${fieldName}" not found in panel`);
      return false;
    }
    const input = wrapper.querySelector("input");
    if (!input) return false;
    await trustedClick(input);
    await sleep(200);
    setFieldValue(input, "");
    await sleep(80);
    await typeIntoField(input, value);
    await sleep(200);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    await sleep(300);

    const options = await pollOptions();
    if (options.length === 0) return false;
    const pairs = options.map((el) => ({ text: optionTextFor(el), element: el }));
    const match = selectMatchingOption(pairs, value);
    if (!match) return false;
    await trustedClick(match.element);
    return true;
  }

  // Degree is a button that opens a listbox.
  async function fillDegreeButton(panel, value) {
    if (!value) return false;
    const wrapper = panel.querySelector('[data-automation-id="formField-degree"]');
    if (!wrapper) return false;
    const button = wrapper.querySelector("button[aria-haspopup='listbox']");
    if (!button) return false;
    await trustedClick(button);
    await sleep(300);
    const options = await pollOptions();
    if (options.length === 0) return false;
    const pairs = options.map((el) => ({ text: optionTextFor(el), element: el }));
    const match = selectMatchingOption(pairs, value);
    if (!match) return false;
    await trustedClick(match.element);
    return true;
  }

  const fillYear = (panel, fieldName, yearStr) => {
    if (!yearStr) return false;
    const yearMatch = String(yearStr).match(/\d{4}/);
    if (!yearMatch) return false;
    const wrapper = panel.querySelector(`[data-automation-id="formField-${fieldName}"]`);
    if (!wrapper) return false;
    const yearInput = wrapper.querySelector('[data-automation-id="dateSectionYear-input"]');
    if (!yearInput) return false;
    setFieldValue(yearInput, yearMatch[0]);
    return true;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const newPanel = await getOrCreatePanel(section, panelSelector, '[data-automation-id="add-button"]', i);
    if (!newPanel) {
      console.warn(`[Tauzand Autofill] Education entry ${i + 1} panel not found/created — skipping`);
      flaggedForReview++;
      continue;
    }
    console.log("[Tauzand Autofill] filling Education entry:", entry.school || "(no school)", "-", entry.degree || "(no degree)");

    if (await fillSearchCombobox(newPanel, "school", entry.school)) filledCount++;
    else flaggedForReview++;

    if (await fillDegreeButton(newPanel, entry.degree)) filledCount++;
    else flaggedForReview++;

    if (entry.field_of_study) {
      if (await fillSearchCombobox(newPanel, "fieldOfStudy", entry.field_of_study)) filledCount++;
    }

    if (fillYear(newPanel, "firstYearAttended", entry.start_year)) filledCount++;
    if (fillYear(newPanel, "lastYearAttended", entry.end_year)) filledCount++;

    if (entry.cgpa) {
      // Automation-id for this field wasn't confirmed via inspection —
      // try a couple of reasonable guesses, then fall back to a text
      // search within the panel for a "GPA"/"overall result" label.
      let cgpaField = newPanel.querySelector(
        '[data-automation-id="formField-cgpa"] input, [data-automation-id="formField-gpa"] input, [data-automation-id="formField-overallResult"] input'
      );
      if (!cgpaField) {
        const candidates = [...newPanel.querySelectorAll('[data-automation-id^="formField-"]')];
        const cgpaWrapper = candidates.find((el) => /gpa|overall result/i.test(el.textContent));
        cgpaField = cgpaWrapper ? cgpaWrapper.querySelector("input") : null;
      }
      if (cgpaField) {
        setFieldValue(cgpaField, entry.cgpa);
        filledCount++;
      } else {
        console.warn("[Tauzand Autofill] couldn't find a CGPA field in this Education panel — automation-id may differ, needs live inspection");
        flaggedForReview++;
      }
    }

    await sleep(CHOICE_CLICK_DELAY_MS);
  }

  return { filledCount, flaggedForReview };
}

async function fillWorkExperienceSection(profile) {
  let entries = profile.work_experience;
  console.log("[Tauzand Autofill] profile.work_experience raw value:", entries, "| type:", typeof entries, "| is array:", Array.isArray(entries));
  // Confirmed via testing: this comes through as a JSON string, not an
  // already-parsed array (the backend/Supabase client isn't auto-parsing
  // the JSONB column) — parse it defensively here regardless of the exact
  // upstream cause.
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
      console.log("[Tauzand Autofill] parsed work_experience string into:", entries);
    } catch (err) {
      console.warn("[Tauzand Autofill] work_experience was a string but not valid JSON:", err);
      entries = null;
    }
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.log("[Tauzand Autofill] no work experience entries to fill — skipping this section");
    return { filledCount: 0, flaggedForReview: 0 };
  }

  const section = document.querySelector('[aria-labelledby="Work-Experience-section"]');
  if (!section) {
    console.log("[Tauzand Autofill] no Work Experience section found on this page — skipping");
    return { filledCount: 0, flaggedForReview: 0 };
  }

  let filledCount = 0;
  let flaggedForReview = 0;

  const panelSelector = '[aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"]';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const newPanel = await getOrCreatePanel(section, panelSelector, '[data-automation-id="add-button"]', i);
    if (!newPanel) {
      console.warn(`[Tauzand Autofill] Work Experience entry ${i + 1} panel not found/created — skipping`);
      flaggedForReview++;
      continue;
    }
    console.log("[Tauzand Autofill] filling Work Experience entry:", entry.job_title || "(no title)", "at", entry.company || "(no company)");

    const fillByAutomationId = (fieldName, value) => {
      if (!value) return false;
      const field = newPanel.querySelector(`[data-automation-id="formField-${fieldName}"] input, [data-automation-id="formField-${fieldName}"] textarea`);
      if (!field) {
        console.warn(`[Tauzand Autofill] Work Experience field "${fieldName}" not found in new panel`);
        return false;
      }
      setFieldValue(field, value);
      return true;
    };

    if (fillByAutomationId("jobTitle", entry.job_title)) filledCount++;
    else flaggedForReview++;
    if (fillByAutomationId("companyName", entry.company)) filledCount++;
    else flaggedForReview++;
    if (entry.location && fillByAutomationId("location", entry.location)) filledCount++;
    if (entry.description && fillByAutomationId("roleDescription", entry.description)) filledCount++;

    const checkbox = newPanel.querySelector('[data-automation-id="formField-currentlyWorkHere"] input[type="checkbox"]');
    if (checkbox && entry.is_current && !checkbox.checked) {
      checkbox.click();
      await sleep(150);
      filledCount++;
    }

    // Each date field splits into separate Month/Year spinbutton inputs —
    // "MM/YYYY" in the profile value needs to be split apart to fill both.
    const fillDate = (fieldName, dateStr) => {
      if (!dateStr) return false;
      const parts = String(dateStr).split("/").map((s) => s.trim());
      if (parts.length !== 2) {
        console.warn(`[Tauzand Autofill] Work Experience date "${dateStr}" for "${fieldName}" isn't in MM/YYYY format — skipping`);
        return false;
      }
      const [month, year] = parts;
      const wrapper = newPanel.querySelector(`[data-automation-id="formField-${fieldName}"]`);
      if (!wrapper) return false;
      const monthInput = wrapper.querySelector('[data-automation-id="dateSectionMonth-input"]');
      const yearInput = wrapper.querySelector('[data-automation-id="dateSectionYear-input"]');
      let didFill = false;
      if (monthInput) {
        setFieldValue(monthInput, month.padStart(2, "0"));
        didFill = true;
      }
      if (yearInput) {
        setFieldValue(yearInput, year);
        didFill = true;
      }
      return didFill;
    };

    if (fillDate("startDate", entry.start_date)) filledCount++;
    else flaggedForReview++;
    if (!entry.is_current) {
      if (fillDate("endDate", entry.end_date)) filledCount++;
      else flaggedForReview++;
    }

    await sleep(CHOICE_CLICK_DELAY_MS);
  }

  return { filledCount, flaggedForReview };
}

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

    // Attach the debugger ONCE for the whole fill, not per-field.
    // Confirmed via testing: repeated rapid attach/detach cycles across
    // many combobox fields in a row (Location, sponsorship, graduation
    // date, degree, gender, veteran status, disability...) became
    // unreliable partway through — later fields silently found zero
    // options even though the same field type worked fine earlier in the
    // same run, with no error thrown to explain it. A single stable
    // attachment for the whole run fixes this, at the cost of Chrome's
    // "debugging this browser" infobar staying visible for the full fill
    // instead of flashing briefly per field.
    await chrome.runtime.sendMessage({ type: "DEBUGGER_ATTACH" });

    showToast("Filling form...");
    console.log("[Tauzand Autofill] question blocks found:", document.querySelectorAll(config.questionSelector).length);

    const { filledCount: textFilledCount, flaggedForReview: textFlaggedForReview } = await fillTextFields(document, config, profile);
    console.log("[Tauzand Autofill] text fields filled:", textFilledCount, "| flagged for review:", textFlaggedForReview);

    showToast("Re-checking for CAPTCHA/login wall...");
    const captchaAppearedMidFill = await checkForCaptcha();
    const loginWallAppearedMidFill = !captchaAppearedMidFill && (await checkForLoginWall());
    if (captchaAppearedMidFill || loginWallAppearedMidFill) {
      showToast(`\u26A0\uFE0F Stopped after filling ${textFilledCount} fields — CAPTCHA/login appeared, please complete manually`);
      return;
    }

    const { filledCount: choiceFilledCount, flaggedForReview: choiceFlaggedForReview } = await fillChoiceFields(document, config, profile);

    showToast("Filling education...");
    const { filledCount: eduFilledCount, flaggedForReview: eduFlaggedForReview } = await fillEducationSection(profile);

    showToast("Filling work experience...");
    const { filledCount: workExpFilledCount, flaggedForReview: workExpFlaggedForReview } = await fillWorkExperienceSection(profile);

    const totalFilled = textFilledCount + choiceFilledCount + eduFilledCount + workExpFilledCount;
    const totalFlagged = textFlaggedForReview + choiceFlaggedForReview + eduFlaggedForReview + workExpFlaggedForReview;
    showToast(
      totalFlagged > 0
        ? `\u2705 Filled ${totalFilled} fields — ${totalFlagged} left for you to review`
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