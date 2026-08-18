// background.js
//
// Runs in the background the whole time the extension is loaded. Two jobs:
//
// 1. The "soft" auto-popup signal: badge the toolbar icon when the current
//    tab is a supported recruiting site.
//
// 2. Fetching the profile from the backend on content.js's behalf.
//    IMPORTANT: a fetch() made directly inside a content script carries the
//    ORIGIN OF THE PAGE it's injected into (e.g. https://docs.google.com),
//    not chrome-extension://<id> — Manifest V3 content scripts share the
//    host page's network identity for this purpose. That's why adding
//    chrome-extension://<id> to CORS_ORIGINS alone didn't fix "could not
//    load profile": Flask was seeing requests from docs.google.com, which
//    isn't in the allow-list. Requests made from the background service
//    worker DO carry the real chrome-extension://<id> origin, which is what
//    CORS_ORIGINS was actually set up for — so the fetch has to happen here
//    instead of in content.js.

const BACKEND_URL = "http://localhost:5000"; // keep in sync with content.js

const SUPPORTED_HOST_FRAGMENTS = [
  "myworkday.com",
  "greenhouse.io",
  "ashbyhq.com",
  "docs.google.com",
];

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return SUPPORTED_HOST_FRAGMENTS.some((fragment) => host.includes(fragment));
  } catch (err) {
    return false;
  }
}

function updateBadgeForTab(tabId, url) {
  if (isSupportedUrl(url)) {
    chrome.action.setBadgeText({ tabId, text: "\u2022" }); // small dot
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#1F4E79" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    updateBadgeForTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => updateBadgeForTab(tabId, tab && tab.url));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_PROFILE") {
    fetch(`${BACKEND_URL}/api/profile/${message.profileId}`)
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "BATCH_GENERATE_BEHAVIORAL") {
    fetch(`${BACKEND_URL}/api/llm/batch-generate-behavioral`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: message.questions, profile: message.profile, jobContext: message.jobContext }),
    })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "LLM_VALIDATE_LEGAL_TEXT") {
    fetch(`${BACKEND_URL}/api/llm/validate-legal-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: message.question, current_text: message.currentText }),
    })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "LLM_SUGGEST") {
    fetch(`${BACKEND_URL}/api/llm/suggest-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: message.question, profile: message.profile }),
    })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "DEBUGGER_TYPE") {
    trustedType(sender.tab.id, message.text)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === "DEBUGGER_ATTACH") {
    attachDebugger(sender.tab.id)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === "DEBUGGER_CLICK") {
    trustedClick(sender.tab.id, message.x, message.y)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === "DEBUGGER_DETACH") {
    detachDebugger(sender.tab.id).then(() => sendResponse({ success: true }));
    return true;
  }
});

// ---------- Trusted-click service (Chrome DevTools Protocol) ----------
//
// Some jsaction-based widgets (confirmed on Google Forms' custom dropdown)
// check event.isTrusted before reacting, and every event a content script
// creates via dispatchEvent() is always isTrusted:false — a real browser
// security boundary, not something fixable with a different event sequence.
// chrome.debugger attaches at the DevTools Protocol level, below the page's
// JS sandbox, so mouse input dispatched through it IS treated as trusted —
// conceptually the same mechanism Selenium/WebDriver relies on for its
// clicks. This requires the "debugger" permission and shows Chrome's
// "this extension is debugging this browser" infobar while attached, which
// is why it's only used for the specific widgets that actually need it,
// not as the default click method everywhere.
const attachedTabs = new Set();

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  } catch (err) {
    const message = String(err);
    if (message.includes("Another debugger is already attached")) {
      // Two possible causes: (a) Chrome DevTools is open on this tab — a
      // real, unavoidable conflict, only one debugger client per tab is
      // allowed; or (b) this is actually OUR OWN earlier attachment, and
      // the background service worker simply restarted in between (Manifest
      // V3 workers can be evicted after a period of inactivity, which wipes
      // this in-memory Set even though the real CDP attachment can still be
      // alive). We can't tell which case it is from here, so proceed
      // optimistically — if it's actually DevTools, the click attempt right
      // after this will surface a clear error instead of silently doing
      // nothing.
      attachedTabs.add(tabId);
    } else {
      throw err;
    }
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    // Already detached (e.g. user dismissed Chrome's infobar manually) — fine.
  }
  attachedTabs.delete(tabId);
}

async function trustedClick(tabId, x, y) {
  await attachDebugger(tabId); // defensive — cheap no-op if already attached, self-heals a restarted service worker
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function trustedType(tabId, text) {
  await attachDebugger(tabId); // defensive — cheap no-op if already attached, self-heals a restarted service worker
  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
      unmodifiedText: char,
      key: char,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      text: char,
      unmodifiedText: char,
      key: char,
    });
    // Confirmed via testing that dispatching characters back-to-back with
    // no gap caused corrupted values (e.g. "06" became "00", "2024" became
    // "2200") — likely event-queue collisions on Workday's side. A short
    // pause between characters fixed it.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

// Keep the attachedTabs set clean if the user manually dismisses Chrome's
// "this extension is debugging this browser" infobar, or the tab closes.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));