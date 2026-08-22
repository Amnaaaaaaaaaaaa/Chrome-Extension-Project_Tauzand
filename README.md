Tauzand Auto-Apply — Chrome Extension + Backend

This repo has two working pieces now:

A Chrome extension (extension/) that auto-detects a supported job-application page, shows a one-click "Autofill this form" banner, and fills the form directly in the browser tab — this is the primary, user-facing way the tool actually gets used.
A Flask + Selenium backend (backend/) that does the same job-filling logic through a driven browser session instead of a content script. It started as the original checkpoint prototype and is still useful for testing/reference, and it's what the extension's profile data and AI features are served from.
Both read the same candidate profile from Supabase and share the same core idea: scan the form, match each question to a profile field, fill what it's confident about, and always leave consent/CAPTCHA/login situations for a human.

What's in here
tauzand-autofill/
├── backend/                    Flask app + Selenium fill engine
│   ├── app.py                   REST routes (profile fetch, resume upload, LLM features, etc.)
│   ├── config.py                 All tunables in one place (timing, thresholds, keyword lists)
│   ├── requirements.txt
│   ├── services/
│   │   ├── supabase_client.py    Profile storage (Supabase, free tier)
│   │   ├── platform_configs.py   Per-platform selectors/config for the Selenium engine
│   │   ├── form_filler.py        Selenium-driven field detection + fill engine
│   │   ├── mistral_client.py     Job-description keyword extraction
│   │   ├── captcha_detector.py   Heuristics + OCR hook to detect (never solve) CAPTCHAs
│   │   ├── ocr_service.py        Tesseract OCR wrapper
│   │   └── audio_alert.py        Cross-platform beep for "come intervene" moments
│   └── README.md                 Backend-specific setup instructions
├── extension/                  Chrome extension (Manifest V3) — the real product
│   ├── manifest.json             Site permissions + which pages the content script runs on
│   ├── content.js                 Scan/match/fill logic, runs in the page itself — also the
│   │                              AI Suggest / legal-risk-check button UI (see below)
│   ├── background.js              Profile fetch (CORS) + the chrome.debugger trusted-click AND
│   │                              trusted-keyboard-typing service + LLM-endpoint fetch calls
│   ├── matcher.js                 Label -> profile-field matching (mirrors form_filler.py's logic)
│   ├── platform_selectors.js      Per-platform DOM selectors, one config block per site
│   ├── popup.html / popup.js      Toolbar popup: set profile ID, manual "Fill Now" button
│   └── README.md                  Setup + per-platform notes and known gaps
├── frontend/                   Next.js + TS + Tailwind dashboard (bare, no polish per brief)
│   ├── app/
│   └── lib/api.ts                Talks to the Flask REST routes
├── schema_update.sql           All Supabase profile-table columns, with comments explaining
│                                the format/purpose of each
├── DESIGN_DOC.md               Architecture notes + edge case log — mirrors the shared
│                                Google Doc used as the ongoing communication channel
└── DOCUMENTATION.md            Fuller technical reference: full folder structure, the
                                 scan-match-fill pipeline, every platform-specific quirk
                                 found so far, and why each fix works the way it does

Platform support status
Platform	Status
Google Forms	Done — text fields, radio/checkbox, dropdowns, legal-consent detection, CAPTCHA/login-wall detection
Ashby	Done — including custom (non-native) button/checkbox widgets, autocomplete "Current Location" field, multi-select questions
Greenhouse	Done — text fields, react-select dropdowns, checkbox/radio question groups, legal-consent detection
Lever	Done — text fields, native <select> dropdowns, checkbox groups, non-ARIA location autocomplete
Workday	Done — multi-page apply flow, repeatable Education/Work Experience sections (multiple entries, not just one), type-to-search widgets (Skills, Field of Study, School), native spinbutton date fields, and a range of compliance/questionnaire question types
LinkedIn	Deliberately not attempted — LinkedIn's User Agreement prohibits automation on the platform, and their system actively detects it. Doing this on a real account risks a restriction or ban, so this needs an explicit decision before any work starts on it, not a code change

New: AI-assisted features
Two features, both extension-side, both built on the same rule — nothing from either path is ever submitted or inserted without the candidate explicitly clicking a button to accept it.

AI Suggest — for long-answer <textarea> questions the confidence-matcher was never going to handle (e.g. "Best project you've worked on", "Expected CTC"), an "✨ AI Suggest" button appears next to the field. It calls the backend, which asks Mistral to draft a recruiter-friendly answer using the candidate's real profile (skills, education, work history) as context, and shows it in an editable popup.
Legal risk check — for free-text questions with real legal weight (explaining a conviction, a dispute, etc. — detected via a separate keyword list from the consent-checkbox one below), a "⚖️ Check for legal risk" button analyzes whatever the candidate has already typed and suggests more careful phrasing, without changing the substance of what they said.
Both endpoints live in backend/app.py (/api/llm/suggest-answer, /api/llm/validate-legal-text) and are called through background.js the same way profile fetches are, for the same CORS reason described below.

The extension's banner also now carries a permanent disclaimer — "Always verify the content before final submitting." — linking to the Terms & Conditions page, shown on every form regardless of what got filled.

Design decisions worth knowing
Legal/consent checkboxes are never auto-checked. Any question matching a consent/policy keyword (config.py's LEGAL_CHECKBOX_KEYWORDS / the same list in matcher.js) is always left for the user, with an audio alert, regardless of confidence. This is a separate keyword list from the one that triggers the legal-risk-check button above — one is about checkboxes never being touched at all, the other is about free text the candidate writes themselves.
CAPTCHA/login walls stop the run, not bypass it. Detection is layered (DOM signals, text keywords, OCR fallback on the backend); on a hit, the run stops and hands off to the user.
Some widgets need a genuinely trusted click — or a genuinely trusted keystroke. A handful of sites (Google Forms' custom dropdown, Greenhouse/Ashby's react-select comboboxes) gate their open/select behavior on event.isTrusted, which a content script's own dispatchEvent() can never satisfy. Workday's date-spinbutton fields turned out to need the same treatment for typing, not just clicking — setting .value correctly (even with input/change/blur events dispatched) still left the field showing "Invalid Date" until real keystrokes were sent. Both routes go through chrome.debugger (Chrome DevTools Protocol) — see background.js's trustedClick() / trustedType() and the corresponding comments in content.js.
Not every question titles itself with a <label>, and not every free-text field is an <input>. Some Greenhouse and Workday questions use <legend> for their title instead; some Workday free-text answers (signature/name fields) use <textarea> instead of <input>. Both selectors account for this per platform — see platform_selectors.js and DOCUMENTATION.md §6.9 for the specific cases that surfaced this.
A generically-titled question sometimes needs an automation-id override instead of a better hint. Workday's disability self-identification question is titled "Please check one of the boxes below:" with no mention of "disability" anywhere visible — no hint list could ever match that confidently, so the block's own data-automation-id is used as a direct override for that one specific case.
.env always overrides config.py defaults. When changing a timing/behavior setting on the backend, check both files — a value set in .env silently wins over a code default.

Quick start
# Backend
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_KEY / MISTRAL_API_KEY / etc.
python app.py           # runs on http://localhost:5000

# Extension
# chrome://extensions -> enable Developer mode -> Load unpacked -> select extension/
# then add the extension's ID to CORS_ORIGINS in backend/.env and restart the backend

# Supabase
# Run schema_update.sql against your profiles table

# Frontend (optional dashboard)
cd frontend
npm install
npm run dev              # runs on http://localhost:3000

SOP compliance notes (Tauzand internal dev standards)
Data access (SOP §5): the frontend defaults to the hardcoded sample JSON in frontend/data/sampleData.json, not the live backend — there's a checkbox on the page to switch to live mode, which you'd only do for the mentor-approved emergency case the SOP describes.
Naming/comments (SOP §3.2–3.4): variables use full descriptive names with inline same-line comments explaining purpose; the shared matching dictionary (FIELD_LABEL_HINTS, present in both form_filler.py and matcher.js) has a comment directly above it explaining the scoring approach.
Edge cases (SOP §3.5): content.js, form_filler.py, and platform_selectors.js each carry inline comments documenting the specific bug/edge case that shaped each fix (fieldset vs div containers, trusted-click/trusted-type gating, React-controlled inputs, chip-vs-option collisions, etc.); DESIGN_DOC.md and DOCUMENTATION.md have the fuller running record.
Color palette (SOP §4.2): frontend/tailwind.config.ts restricts to Sapphire Veil (blue, primary actions/confident results) and Imperial Topaz (amber, attention/skipped states) plus neutral grays and rose instead of pure red.
Env vars (SOP §3.7): backend reads everything through config.py from .env; frontend reads the API base from NEXT_PUBLIC_API_BASE. No secrets are hardcoded in the repo — .gitignore excludes backend/.env and frontend/.env.local.
AI disclosure (SOP §2): this repo was built with AI assistance throughout (backend, extension, and debugging) and each change was tested against a real, live posting on the target platform before being considered done — not just that it runs, but that it's been seen working on an actual form.

Reference platforms used so far
Google Forms, Ashby, Greenhouse, and Lever were chosen first because they allow guest/unauthenticated applications, so they could be tested end-to-end without needing a company account. Workday sits behind tenant-specific auth in general, but enough public "Apply Manually" postings exist to test against directly, and it's now fully supported — see the platform table above and DOCUMENTATION.md §7.5 for the full set of Workday-specific quirks (repeatable sections, search-combobox typing, date-field structure, and more) that came out of that work. platform_selectors.js (extension) and platform_configs.py (backend) are both written so a new platform is a config addition, not a rewrite.