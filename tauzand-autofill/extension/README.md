# Tauzand Autofill — Chrome Extension

This folder goes at the same level as `backend/` and `frontend/` in the repo:

```
tauzand-autofill/
├── backend/
├── frontend/
└── extension/   <- this folder
```

## 1. Load it into Chrome
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension/` folder
4. Note the **extension ID** Chrome shows you — you'll need it in the next step

## 2. Allow the extension to call your backend (CORS)
In `backend/.env`, add the extension's origin to `CORS_ORIGINS`:
```
CORS_ORIGINS=http://localhost:3000,chrome-extension://<paste-the-id-here>
```
Restart the Flask backend after saving.

## 3. Set your profile
1. Click the extension icon in the Chrome toolbar
2. Paste your Supabase profile ID, click **Save**

## 4. Test it
Open a supported site (Google Forms first — it's the one already fully verified):
- A blue "⚡ Autofill this form" banner should appear top-right automatically
- Click it (or use "Fill This Form Now" in the popup) to run a fill

### If you see "Could not load profile — check backend is running" even though the backend IS running
This means the profile fetch is being blocked by the browser as a cross-origin
request, not that Flask is actually down (check the Flask terminal — if you
see `GET /api/profile/... 200`, the request did reach it fine, the browser
just wouldn't hand the response back to the extension's JS).

Fixed in this version by moving the fetch into `background.js` instead of
`content.js` — a content script's fetch() carries the origin of the *page*
it's injected into (e.g. `https://docs.google.com`), not the extension's own
`chrome-extension://<id>` origin, so it never actually matched what
`CORS_ORIGINS` in `.env` was allow-listing. If you pulled an older copy of
this extension folder, re-download it or apply the same fix: move the
`fetch(.../api/profile/...)` call out of `content.js` and into a
`chrome.runtime.onMessage` handler in `background.js`, then call it from
`content.js` via `chrome.runtime.sendMessage(...)` instead of `fetch()`
directly.

After updating the code, remember to reload the extension itself —
`chrome://extensions` → the refresh icon on the Tauzand Autofill card —
code changes don't apply to an already-loaded extension until you do this.

## Before testing on Workday / Greenhouse / Ashby
The selectors in `platform_selectors.js` for these three are **best-guess
starting points**, not yet verified against a live posting (unlike Google
Forms, which was already tested through the backend). For each platform:

1. Open a real job application page on that platform
2. Right-click a field → **Inspect**
3. Compare the actual HTML against what's in `platform_selectors.js` for
   that platform's `questionSelector` / `textInputSelector` / etc.
4. Update the selectors in `platform_selectors.js` if they don't match
5. Recommended order: **Greenhouse first** (plain HTML forms, easiest),
   then **Ashby** (React — double check `setFieldValue()` in `content.js`
   is actually being used everywhere), then **Workday last** (often runs
   the form inside an `<iframe>`, and `data-automation-id` values vary by
   Workday tenant/version)

## Files
| File | What it does |
|---|---|
| `manifest.json` | Declares which sites the extension activates on |
| `background.js` | Shows a toolbar badge on supported sites |
| `content.js` | Injects the banner, scans the form, fills it — the core logic |
| `matcher.js` | Label ↔ profile-field matching (JS port of the backend's matching logic) |
| `platform_selectors.js` | Per-site CSS selectors — **update these after inspecting each live platform** |
| `popup.html` / `popup.js` | Toolbar popup: save profile ID, manual "Fill Now" button |

## Known gaps / next steps
- Custom (non-`<select>`) dropdowns on non-Google-Forms platforms aren't
  clicked automatically yet (`content.js` flags them for manual review) —
  needs each platform's actual open/select markup to implement.
- `matcher.js`'s `similarityRatio()` is a reasonable equivalent of Python's
  `difflib.SequenceMatcher.ratio()`, not a byte-for-byte port. If matching
  behaves noticeably differently from the backend on the same label, this
  is the first place to check.
- CAPTCHA detection covers DOM selectors + text keywords, same as the
  backend's first two detection layers. The backend's third layer (OCR on
  canvas-only, text-free challenges via `ocr_service.py`) is **not** ported —
  doing that client-side would need a library like tesseract.js, which is a
  meaningfully heavier addition than the rest of this extension.

## What changed most recently
- **Human-like typing**: text fields now type character-by-character with a
  randomized 40–120ms delay per character (`typeIntoField()` in
  `content.js`), instead of setting the whole value instantly. Mirrors
  `_human_type()` in the backend.
- **Audio alert**: a real beep (via the Web Audio API, since a content
  script can't shell out to `afplay`/`paplay`/`winsound` like the backend
  does) now fires when a legal/consent checkbox is skipped, and when a
  CAPTCHA or login wall is detected. Mirrors
  `alert_human_intervention_needed()`.
- **CAPTCHA / login-wall detection**: this didn't exist in the extension at
  all before — `content.js` now checks for both *before* filling starts and
  *again* after text fields are filled (a challenge can appear mid-fill),
  and stops the whole run if either is found, same as `run_fill()` on the
  backend.

## Most recent fixes (typing speed, beep count, dropdown skip)
- **Speed**: typing delay bumped from 40-120ms/char to 90-220ms/char, and a
  350ms pause was added after every radio/checkbox/dropdown click - choice
  fields were being clicked through instantly with no pacing at all before.
- **Legal-consent beep only firing once**: creating a brand-new
  AudioContext for every beep, right after an await sleep(...), can lose
  the browser's transient user-activation window and get silently muted for
  everything after the first one. Now a single shared AudioContext is
  reused across all beeps in a run, and the repeat count is 3 (was 2).
- **"Preferred work location" (or any custom dropdown) always skipped**:
  Google Forms renders dropdowns as a clickable div[role='listbox'], not a
  native <select> - the extension only handled real <select> elements
  and flagged everything else for manual review without even trying. It now
  clicks the dropdown open, reads the div[role='option'] list Google Forms
  renders, matches, and clicks the right one (closing the menu back up if
  nothing matched).

## Round 2 fixes (dropdown still skipping, beep still once)
- **isVisible() was the real reason "Preferred work location" kept getting
  skipped**: it checked `element.offsetParent !== null`, but that's always
  null for `position: fixed` elements even when they're genuinely on
  screen — and Google Forms renders an open dropdown's option list as a
  fixed-position floating menu. Every option was being filtered out as
  "not visible" before matching ever got a chance. Fixed by checking
  computed `visibility`/`display`/`opacity` instead of `offsetParent`.
- **Beep still only firing once**: switched from a Web Audio API
  oscillator/AudioContext to a single reused `<audio>` element playing an
  embedded beep sound. Re-creating an `AudioContext` on each beep (even a
  shared one being resumed) was still landing outside the browser's
  user-activation window after the async gaps between beeps; a plain
  `<audio>` element doesn't have that same per-call restriction once the
  page has already played sound once.

## Google Forms dropdown: a real browser-security limitation, not a bug
"Preferred work location" (and any Google Forms dropdown, since they all
use the same widget) cannot be opened by a content script's simulated
click/mousedown/pointerdown events. Confirmed via testing: the dropdown's
`jsaction` attribute is Google's own Closure/jsaction event framework, and
`aria-expanded` never flips to `true` no matter what synthetic event
sequence gets dispatched.

The underlying reason: every event a content script creates via
`dispatchEvent()` has `isTrusted: false` - a real, unforgeable browser
security flag that only genuine user input (or genuine OS-level automation
like Selenium/WebDriver) can set to `true`. jsaction-based widgets appear to
gate opening on trusted events. This is also exactly why the Selenium-driven
backend CAN fill this same field - WebDriver clicks are real OS-level input,
not JS-simulated ones.

Current behavior: the extension detects this (aria-expanded stays "false"
after the attempt) and highlights the dropdown with a red outline + scrolls
it into view, instead of silently leaving it blank or pretending to search
an option menu that never opened.

If fully automating this specific interaction is a hard requirement, the
real path forward is the `chrome.debugger` API (Chrome DevTools Protocol),
which dispatches input at a level the page can't distinguish from genuine
user input - conceptually the same trick Selenium relies on. It requires
the `debugger` permission and shows Chrome's "this extension is debugging
this browser" banner while active, which is a meaningfully bigger UX/scope
change than the rest of this extension, so it wasn't added by default here.

## chrome.debugger — full automation for jsaction-gated dropdowns
Added the trusted-click service so Google Forms' custom dropdown (and any
other jsaction-gated widget requiring a real, trusted click) can actually
be opened and selected automatically, instead of only being highlighted for
manual review.

**What changed:**
- `manifest.json`: added the `"debugger"` permission.
- `background.js`: new trusted-click service using `chrome.debugger` +
  Chrome DevTools Protocol's `Input.dispatchMouseEvent` — this dispatches
  mouse input at a level the page can't distinguish from genuine user
  input, which is why it works where a content script's `dispatchEvent()`
  didn't.
- `content.js`: `trustedClick(element)` asks background.js to click an
  element's on-screen position through the debugger service. The custom
  dropdown branch in `fillChoiceFields()` now uses this to open the
  dropdown and click the matched option.

**What the user will see:** while a fill is running, Chrome shows an
infobar at the top of the window reading `"Tauzand Autofill" is debugging
this browser`. This is unavoidable — it's Chrome's own indicator that a
`chrome.debugger`-attached extension is active, not a bug. It appears when
`DEBUGGER_ATTACH` runs (start of every fill) and disappears when
`DEBUGGER_DETACH` runs (end of every fill, success or failure, via a
`finally` block in `runAutofill()`).

**Fallback behavior:** if the trusted-click service fails for any reason
(e.g. debugger permission was denied, or attach failed), the dropdown falls
back to the manual-review highlight instead of leaving the field in an
unclear state.
