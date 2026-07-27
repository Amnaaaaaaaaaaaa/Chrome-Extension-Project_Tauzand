// platform_selectors.js
//
// Mirrors the idea of backend/services/platform_configs.py, but this is the
// version content.js actually uses, since filling now happens in the
// browser tab itself instead of through Selenium.
//
// IMPORTANT: the Greenhouse, Workday, and Ashby selectors below are
// starting points based on each platform's common/typical markup, NOT
// verified against a live posting yet. Before relying on any of them:
//   1. Open a real job application on that platform.
//   2. Right-click a field -> Inspect, and confirm the selector actually
//      matches (or update it here if it doesn't).
// Google Forms' selectors ARE already verified (carried over from the
// backend, which was tested against a live form).

const PLATFORM_SELECTORS = {
  google_forms: {
    matchHost: (host) => host.includes("docs.google.com"),
    questionSelector: "div[role='listitem']",
    questionTitleSelector: "div[role='heading']",
    textInputSelector: "input[type='text'], textarea",
    radioSelector: "div[role='radio']",
    checkboxSelector: "div[role='checkbox']",
    selectSelector: "div[role='listbox']",
  },

  greenhouse: {
    matchHost: (host) => host.includes("greenhouse.io"),
    // Greenhouse's standard embed wraps each question in a .field container
    // with a <label> and native <input>/<select>/<textarea> — much closer
    // to a plain HTML form than Google Forms or Workday.
    questionSelector: ".field, .application-question",
    questionTitleSelector: "label",
    textInputSelector: "input[type='text'], input[type='email'], input[type='tel'], textarea",
    radioSelector: "input[type='radio']",
    checkboxSelector: "input[type='checkbox']",
    selectSelector: "select",
  },

  workday: {
    matchHost: (host) => host.includes("myworkday.com"),
    // Workday tags most interactive elements with data-automation-id, but
    // the exact values vary by tenant/version — VERIFY on the real tenant
    // you're testing against and adjust these.
    questionSelector: "[data-automation-id='formField']",
    questionTitleSelector: "label, [data-automation-id='label']",
    textInputSelector: "input[data-automation-id='textInputBox'], input[type='text']",
    radioSelector: "input[data-automation-id='radioInput'], input[type='radio']",
    checkboxSelector: "input[data-automation-id='checkboxInput'], input[type='checkbox']",
    selectSelector: "[data-automation-id='multiSelectContainer'], select",
    // Workday often renders the actual application form inside an <iframe>.
    // manifest.json's "all_frames": true means this content script also
    // runs inside that iframe automatically, so no extra wiring is needed
    // here — but if fields still aren't found, confirm the frame content.js
    // is running in is the one that actually contains the form (log
    // window.location.href from content.js to check).
  },

  ashby: {
    matchHost: (host) => host.includes("ashbyhq.com"),
    // Ashby is React-driven; values MUST be set via setReactValue() in
    // content.js, not a plain .value assignment, or the form will look
    // filled but submit empty/stale data.
    questionSelector: "[class*='_container_'], .ashby-application-form-field",
    questionTitleSelector: "label",
    textInputSelector: "input[type='text'], input[type='email'], input[type='tel'], textarea",
    radioSelector: "input[type='radio']",
    checkboxSelector: "input[type='checkbox']",
    selectSelector: "select",
  },
};

function detectPlatform(hostname) {
  for (const [key, config] of Object.entries(PLATFORM_SELECTORS)) {
    if (config.matchHost(hostname)) return key;
  }
  return null;
}
