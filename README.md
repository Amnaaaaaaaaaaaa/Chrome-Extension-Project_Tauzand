# Tauzand Auto-Apply — Chrome Extension + Backend

This repo has two working pieces now:

1. A **Chrome extension** (`extension/`) that auto-detects a supported job-application page,
   shows a one-click "Autofill this form" banner, and fills the form directly in the browser
   tab — this is the primary, user-facing way the tool actually gets used.
2. A **Flask + Selenium backend** (`backend/`) that does the same job-filling logic through a
   driven browser session instead of a content script. It started as the original checkpoint
   prototype and is still useful for testing/reference, and it's what the extension's profile
   data is served from (`GET /api/profile/<id>`).

Both read the same candidate profile from Supabase and share the same core idea: scan the
form, match each question to a profile field, fill what it's confident about, and always leave
consent/CAPTCHA/login situations for a human.

## What's in here

```
tauzand-autofill/
├── backend/                    Flask app + Selenium fill engine
│   ├── app.py                   REST routes (profile fetch, resume upload, etc.)
│   ├── config.py                 All tunables in one place (timing, thresholds, keyword lists)
│   ├── requirements.txt
│   ├── services/
│   │   ├── supabase_client.py    Profile storage (Supabase, free tier)
│   │   ├── platform_configs.py   Per-platform selectors/config for the Selenium engine
│   │   ├── form_filler.py        Selenium-driven field detection + fill engine
│   │   ├── captcha_detector.py   Heuristics + OCR hook to detect (never solve) CAPTCHAs
│   │   ├── ocr_service.py        Tesseract OCR wrapper
│   │   └── audio_alert.py        Cross-platform beep for "come intervene" moments
│   └── README.md                 Backend-specific setup instructions
├── extension/                  Chrome extension (Manifest V3) — the real product
│   ├── manifest.json             Site permissions + which pages the content script runs on
│   ├── content.js                 Scan/match/fill logic, runs in the page itself
│   ├── background.js              Profile fetch (CORS) + chrome.debugger trusted-click service
│   ├── matcher.js                 Label -> profile-field matching (mirrors form_filler.py's logic)
│   ├── platform_selectors.js      Per-platform DOM selectors, one config block per site
│   ├── popup.html / popup.js      Toolbar popup: set profile ID, manual "Fill Now" button
│   └── README.md                  Setup + per-platform notes and known gaps
├── frontend/                   Next.js + TS + Tailwind dashboard (bare, no polish per brief)
│   ├── app/
│   └── lib/api.ts                Talks to the Flask REST routes
└── DESIGN_DOC.md               Architecture notes + edge case log — mirrors the shared
                                 Google Doc used as the ongoing communication channel
DOCUMENTATION.md                 Full technical reference — AI architecture, per-platform
                                 quirks, and the reasoning behind every non-obvious decision
```

## Platform support status

| Platform | Status |
|---|---|
| Google Forms | Done — text fields, radio/checkbox, dropdowns, legal-consent detection, CAPTCHA/login-wall detection |
| Ashby | Done — including custom (non-native) button/checkbox widgets, autocomplete "Current Location" field, multi-select questions |
| Greenhouse | Done — text fields, react-select dropdowns, checkbox/radio question groups, legal-consent detection |
| Lever | Done — text fields, native `<select>` dropdowns, checkbox groups, non-ARIA location autocomplete |
| Workday | Done — multi-page apply flow, repeatable Education/Work Experience sections, type-to-search widgets, native spinbutton date fields, trusted-keystroke date entry, compliance questionnaire handling |
| LinkedIn | Deliberately not attempted — LinkedIn's User Agreement prohibits automation on the platform, and their system actively detects it. Doing this on a real account risks a restriction or ban, so this needs an explicit decision before any work starts on it, not a code change |

## AI features

Built around a **Question Processing Array**: every field gets classified (`personal`,
`education`, `experience`, `known_field`, `behavioral`, `technical`, `legal`, or `unknown`)
before any fill decision is made — see `DOCUMENTATION.md` §8 for the full breakdown. The
headline design principle: **one Mistral call per form**, no matter how many AI-assisted fields
that form has.

- **Behavioral & technical questions** (e.g. "Why do you want to join us?", "Describe your
  experience with Python") — Mistral drafts an answer grounded in the candidate's real
  resume/profile and the job/company context extracted from the page, never inventing facts.
- **"Unknown" choice fields** (radio/checkbox with no confident DB match, or a DB value that
  doesn't textually match any option — e.g. `gender: "Female"` vs. a form's "Man"/"Woman") get
  the same AI treatment: Mistral picks from the field's *real* options only, never inventing one
  ("No preference" when that isn't an actual option was an observed failure mode, now
  explicitly forbidden in the prompt).
- **Legal-consent sections** get a plain-English AI breakdown (what it's asking for, risk
  flags, whether it's required) shown next to the checkbox — purely informational; the checkbox
  itself is never auto-checked, at any confidence level, under any circumstance.
- **High-confidence AI answers auto-fill directly** (0.85+ confidence, `requires_review: false`)
  instead of requiring a manual click — always with a visible "🤖 AI-filled — please review"
  marker, since the banner's disclaimer promise ("always review before submitting") has to stay
  true even when nothing needed clicking.
- **PII is never sent to Mistral.** Phone, email, GitHub, and LinkedIn are excluded from every
  AI prompt by construction (`app.py`'s profile-summary builder), not left to the model.
- **"Always check Others."** When no exact/equivalent option exists, an "Other"/"Others" option
  on the form is used as a fallback before giving up — applied to single-value matches only,
  not multi-select fields like Skills.

## Design decisions worth knowing

- **Legal/consent checkboxes are never auto-checked.** Any question matching a consent/policy
  keyword (`config.py`'s `LEGAL_CHECKBOX_KEYWORDS` / the same list in `matcher.js`) is always
  left for the user, with an audio alert, regardless of confidence.
- **CAPTCHA/login walls stop the run, not bypass it.** Detection is layered (DOM signals, text
  keywords, OCR fallback on the backend); on a hit, the run stops and hands off to the user.
- **Some widgets need a genuinely trusted click.** A handful of sites (Google Forms' custom
  dropdown, Greenhouse/Ashby's react-select comboboxes) gate their open/select behavior on
  `event.isTrusted`, which a content script's own `dispatchEvent()` can never satisfy. The
  extension routes those specific interactions through `chrome.debugger` (Chrome DevTools
  Protocol) instead, which dispatches genuinely trusted input — see `background.js` and the
  `trustedClick()` comments in `content.js` for the detail.
- **`.env` always overrides `config.py` defaults.** When changing a timing/behavior setting on
  the backend, check both files — a value set in `.env` silently wins over a code default.

## Quick start

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_KEY / etc.
python app.py           # runs on http://localhost:5000

# Extension
# chrome://extensions -> enable Developer mode -> Load unpacked -> select extension/
# then add the extension's ID to CORS_ORIGINS in backend/.env and restart the backend

# Frontend (optional dashboard)
cd frontend
npm install
npm run dev              # runs on http://localhost:3000
```

## SOP compliance notes (Tauzand internal dev standards)

- **Data access (SOP §5):** the frontend defaults to the hardcoded sample JSON in
  `frontend/data/sampleData.json`, not the live backend — there's a checkbox on the page
  to switch to live mode, which you'd only do for the mentor-approved emergency case the
  SOP describes.
- **Naming/comments (SOP §3.2–3.4):** variables use full descriptive names with inline
  same-line comments explaining purpose; the shared matching dictionary
  (`FIELD_LABEL_HINTS`, present in both `form_filler.py` and `matcher.js`) has a comment
  directly above it explaining the scoring approach.
- **Edge cases (SOP §3.5):** `content.js`, `form_filler.py`, and `platform_selectors.js` each
  carry inline comments documenting the specific bug/edge case that shaped each fix (fieldset
  vs div containers, trusted-click gating, React-controlled inputs, etc.); `DESIGN_DOC.md` has
  the fuller running table.
- **Color palette (SOP §4.2):** `frontend/tailwind.config.ts` restricts to Sapphire Veil
  (blue, primary actions/confident results) and Imperial Topaz (amber, attention/skipped
  states) plus neutral grays and `rose` instead of pure red.
- **Env vars (SOP §3.7):** backend reads everything through `config.py` from `.env`;
  frontend reads the API base from `NEXT_PUBLIC_API_BASE`. No secrets are hardcoded in the
  repo — `.gitignore` excludes `backend/.env` and `frontend/.env.local`.
- **AI disclosure (SOP §2):** this repo was built with AI assistance throughout (backend,
  extension, and debugging) and each change was tested against a real, live posting on the
  target platform before being considered done — not just that it runs, but that it's been
  seen working on an actual form.

## Reference platforms used so far

Google Forms, Ashby, Greenhouse, and Lever were chosen because they allow guest/unauthenticated
applications, so they can be tested end-to-end without needing a company account. Workday and
most enterprise ATS platforms sit behind tenant-specific auth walls, which makes them a
separate, later effort. `platform_selectors.js` (extension) and `platform_configs.py` (backend)
are both written so a new platform is a config addition, not a rewrite.