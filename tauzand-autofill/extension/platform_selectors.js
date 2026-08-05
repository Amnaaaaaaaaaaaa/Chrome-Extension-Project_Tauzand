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
    // Confirmed via live DOM inspection (Cloudflare's posting on the
    // modern job-boards.greenhouse.io/Remix-based redesign — the old
    // embed-style .field/.application-question guess was for the legacy
    // system, which no longer exists; boards.greenhouse.io now redirects
    // to this same new system for every company). Different field types
    // use different (but semantically stable, not randomly hashed)
    // wrapper class names: text fields use "input-wrapper", react-select
    // dropdowns use "select__container", and checkbox/radio-group
    // questions use "fieldset.checkbox" / "fieldset.radio" — the last one
    // wasn't in the original selector at all, which is why the Privacy
    // Policy consent checkbox was never even scanned (no title captured,
    // no beep, not counted anywhere).
    questionSelector: "div.input-wrapper, div.select__container, fieldset.checkbox, fieldset.radio",
    // fieldset-based questions (checkbox/radio groups) title themselves
    // with a <legend>, not a <label> — e.g. the Privacy Policy question's
    // actual text ("Please review and acknowledge...") lives in a
    // <legend class="checkbox__description">, and the only <label> inside
    // that fieldset is the option's own "Acknowledge/Confirm" text, not
    // the question itself.
    questionTitleSelector: "label, legend",
    // Greenhouse's dropdowns (e.g. "Country") are react-select comboboxes —
    // a real <input type="text"> with role="combobox" and
    // aria-autocomplete="list", not a native <select>. This selector
    // matches it like any other text field; the role/aria-autocomplete
    // check already in fillTextFields() automatically routes it through
    // fillComboboxField() (the same logic built for Ashby's "Current
    // Location" field) instead of plain typing — no special-casing needed.
    textInputSelector: "input[type='text'], input[type='email'], input[type='tel'], textarea",
    // Not yet confirmed against a live radio/checkbox question on this
    // platform — this specific posting didn't have one. Reasonable
    // defaults for now; verify and adjust once one is found.
    radioSelector: "input[type='radio']",
    checkboxSelector: "input[type='checkbox']",
    selectSelector: "select",
  },

  workday: {
    matchHost: (host) => host.includes("myworkday.com") || host.includes("myworkdayjobs.com"),
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

  lever: {
    matchHost: (host) => host.includes("lever.co"),
    // Confirmed via live DOM inspection (a real Lever posting): there are
    // TWO different question-container patterns. Built-in fields (Name,
    // Email, "Current location") use <li class="application-question">.
    // But custom "additional questions" (Language Skills checkboxes,
    // Graduation Date dropdown, etc. — anything with a name like
    // "cards[...]") are wrapped in a completely plain, unlabeled <div>
    // with no distinguishing class at all — the original li/div.application-
    // question selector never matched these, so they were never scanned.
    // The one thing both patterns share: the question's title
    // (.application-label) is always a DIRECT child of whatever container
    // represents that question, regardless of that container's own tag or
    // class. ":has(> .application-label)" catches both without needing to
    // know each container's specific class.
    questionSelector: "*:has(> .application-label)",
    questionTitleSelector: ".application-label",
    textInputSelector: "input[type='text'], input[type='email'], input[type='tel'], textarea",
    radioSelector: "input[type='radio']",
    checkboxSelector: "input[type='checkbox']",
    selectSelector: "select",
  },

  ashby: {
    matchHost: (host) => host.includes("ashbyhq.com"),
    // Ashby is React-driven; values MUST be set via setReactValue() in
    // content.js, not a plain .value assignment, or the form will look
    // filled but submit empty/stale data.
    //
    // Confirmed via live DOM inspection (Notion's Ashby-hosted posting):
    // question containers use TWO different tags depending on widget type —
    // plain fields are <div class="... ashby-application-form-field-entry">,
    // but radio/checkbox-group fields are <fieldset class="_container_...
    // _fieldEntry_...">, which lacks the "ashby-application-form-field-entry"
    // class entirely. The old div-only selector meant every fieldset-based
    // question (Pronouns, "How did you hear", etc.) was never scanned at
    // all — the radio/checkbox selectors inside it were never even reached.
    // Both tag variants share the hashed class "_fieldEntry_..." regardless
    // of tag, so matching on that substring (ignoring the exact hash
    // suffix) covers both without needing to special-case the tag name.
    questionSelector: "[class*='_fieldEntry_']",
    questionTitleSelector: "label.ashby-application-form-question-title, label",
    // input[role='combobox'] added for autocomplete-style fields like
    // "Current Location" — confirmed via inspection that field has no
    // type="text" attribute at all (just role="combobox"
    // aria-autocomplete="list"), so input[type='text'] never matched it.
    // Typing into it will show suggestions same as a real user, but note:
    // some autocomplete widgets require an actual suggestion to be clicked
    // before the value is considered valid on submit — worth confirming
    // once this fills in visually.
    textInputSelector: "input[type='text'], input[type='email'], input[type='tel'], input[role='combobox'], textarea",
    // Confirmed via live DOM inspection: every choice option (Yes/No
    // buttons, Pronouns radios, "How did you hear" checkboxes) is wrapped
    // in an outer container — a <button> for the boolean Yes/No widget, a
    // <div> for the list-style radio/checkbox widget — whose class always
    // contains "_option_" (hash suffix varies by component/build). That
    // outer container is what Ashby's actual click handler is bound to;
    // clicking the inner <input> or <label> directly didn't register as a
    // real selection. Matching on "[class*='_option_']" regardless of tag
    // catches both patterns, and its .textContent already gives just the
    // visible option label (e.g. "LinkedIn"), so no special-casing is
    // needed for text extraction either.
    radioSelector: "[class*='_option_']",
    checkboxSelector: "[class*='_option_']",
    selectSelector: "select",
  },
};

function detectPlatform(hostname) {
  for (const [key, config] of Object.entries(PLATFORM_SELECTORS)) {
    if (config.matchHost(hostname)) return key;
  }
  return null;
}