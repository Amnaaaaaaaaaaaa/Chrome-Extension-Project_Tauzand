# Tauzand Autofill — Technical Documentation

This document is the reference for how the project is built, why key decisions were made,
and how to navigate and extend it. Paired with `README.md` (quick start) and `DESIGN_DOC.md`
(the running edge-case log).

---

## 1. What this is

A Chrome extension + Flask backend that auto-fills job-application forms from a candidate's
Supabase profile. The extension is the primary, user-facing product — it detects a supported
job site, shows a one-click banner, scans the form, matches each question to a profile field,
and fills what it's confident about. Anything it can't confidently fill (consent checkboxes,
CAPTCHAs, low-confidence matches) is left for the user, with a visible highlight or an audio
alert rather than a silent skip.

The backend (Flask + Selenium) does the same job through a driven browser session instead of
a content script. It's the original checkpoint prototype and still serves the extension's
profile data (`GET /api/profile/<id>`) and the new AI-suggestion endpoint.

---

## 2. Folder structure

```
tauzand-autofill/
├── backend/
│   ├── app.py                     Flask routes — thin; logic lives in services/
│   ├── config.py                   All tunables (timing, confidence thresholds, keyword
│   │                                lists) in one place — .env values override these
│   ├── requirements.txt
│   └── services/
│       ├── supabase_client.py      Profile storage (Supabase)
│       ├── platform_configs.py     Per-platform selectors for the Selenium engine
│       ├── form_filler.py          Scan -> match -> fill logic (Selenium version)
│       ├── mistral_client.py       Job-description keyword extraction (existing feature)
│       ├── captcha_detector.py     CAPTCHA detection heuristics + OCR fallback
│       ├── ocr_service.py          Tesseract wrapper
│       ├── resume_service.py       Resume upload/storage/best-match selection
│       └── audio_alert.py          Cross-platform beep for "come intervene" moments
├── extension/                     Chrome extension (Manifest V3) — the primary product
│   ├── manifest.json               Site permissions, content-script matches, "debugger"
│   │                                permission (needed for trusted-click — see §6)
│   ├── content.js                  All scan/match/fill logic — runs inside the page itself
│   ├── background.js               Profile fetch + AI-suggestion fetch (CORS workaround,
│   │                                see the comment at the top of the file) + the
│   │                                chrome.debugger trusted-click service
│   ├── matcher.js                  Label -> profile-field matching, mirrors form_filler.py
│   ├── platform_selectors.js       One config block per supported platform — this is the
│   │                                file to touch when adding a new site or fixing a
│   │                                platform-specific selector
│   ├── popup.html / popup.js       Toolbar popup: set profile ID, manual "Fill Now" button
│   └── README.md                   Setup + per-platform notes and known gaps
├── frontend/                      Next.js dashboard (bare, no polish per brief)
├── schema_update.sql              All Supabase profile-table columns, with comments
│                                    explaining format/purpose for each
├── DESIGN_DOC.md                  Running architecture + edge-case log
└── DOCUMENTATION.md               This file
```

---

## 3. Platform support status

| Platform | Status | Notes |
|---|---|---|
| Google Forms | Done | Text/radio/checkbox/dropdown, legal-consent detection, CAPTCHA/login-wall detection |
| Ashby | Done | Custom (non-native) widgets, autocomplete location field, multi-select questions |
| Greenhouse | Done | react-select dropdowns, checkbox/radio question groups, legal-consent detection |
| Lever | Done | Native `<select>` dropdowns, checkbox groups, non-ARIA location autocomplete |
| Workday | Done | Multi-page apply flow, repeatable Education/Work Experience sections, type-to-search widgets, native spinbutton date fields |
| LinkedIn | Not attempted | LinkedIn's User Agreement prohibits automation on the platform, and their system actively detects it — this needs an explicit go/no-go decision, not a code change |

---

## 4. How autofill works (the pipeline)

For every platform, the same three-stage pipeline runs:

1. **Scan** — `document.querySelectorAll(config.questionSelector)` finds every question block
   on the (currently visible) page, using that platform's config in `platform_selectors.js`.
2. **Match** — each question's title text is fuzzy-matched against `FIELD_LABEL_HINTS`
   (`matcher.js` / `form_filler.py`) using a SequenceMatcher-ratio + substring-coverage-bonus
   score. A match below the confidence threshold is left for manual review rather than guessed.
3. **Fill** — depending on the field type (text input, radio, checkbox, native `<select>`,
   custom dropdown, search-combobox), a type-specific fill routine runs. Every routine that
   can't be sure it worked (no match found, click didn't register, unrecognized field type)
   flags the field for review instead of silently leaving it blank with no accounting.

Two dedicated pipelines run alongside the general one for repeatable sections that need
click-driven "Add" buttons rather than a flat scan — see §7.4 (Work Experience / Education).

---

## 5. Supabase schema

See `schema_update.sql` for the full, commented list. Grouped by purpose:

- **Identity/contact:** `full_name`, `first_name`, `email`, `phone`, `address`, `city`,
  `current_location`, `postal_code`, `linkedin_url`, `github_url`, `portfolio_url`
- **Work authorization:** `work_authorized_us`, `visa_sponsorship_status` (specific type:
  OPT/H1B/etc.), `requires_visa_sponsorship` (plain Yes/No — some companies ask it this way
  instead), `eu_efta_citizen`
- **Education (single-entry, legacy):** `school`, `degree_type`, `field_of_study`, `cgpa`,
  `graduation_date`, `education_start_year` — used by platforms with a flat, one-shot
  education question set (Greenhouse, Lever, Ashby, Google Forms)
- **Education (multi-entry):** `education` — JSON array, used by platforms with a repeatable
  Education section (currently Workday). See §7.4 for the format.
- **Work history (multi-entry):** `work_experience` — JSON array, same repeatable-section
  pattern as `education`. See §7.4.
- **Skills/languages:** `skills`, `languages` — comma-separated strings; every matching
  option gets selected (not priority-only)
- **Referral/EEO:** `referral_source` (priority-only — see §7.3), `gender`, `race`,
  `veteran_status`, `disability_status` — added per explicit instruction, since these are
  normally left manual by default
- **Misc:** `current_company`, `date_of_birth`, `willing_to_relocate`

---

## 6. Key technical decisions

### 6.1 Trusted clicks (`chrome.debugger`)
Several platforms gate their dropdown-open or option-select behavior on `event.isTrusted`.
A content script's own `dispatchEvent()` is always `isTrusted: false` — a real browser
security boundary, not something a different event sequence fixes. `background.js` runs a
small trusted-click service using the Chrome DevTools Protocol (`chrome.debugger` +
`Input.dispatchMouseEvent`), which dispatches genuinely trusted input — conceptually the same
mechanism Selenium/WebDriver relies on. This needs the `debugger` permission and shows
Chrome's "this extension is debugging this browser" infobar while attached.

### 6.2 Legal/consent checkboxes are never auto-checked
Any question whose title matches a consent/policy keyword (`LEGAL_CHECKBOX_KEYWORDS` in both
`matcher.js` and `form_filler.py`) is always left for the user, with an audio alert,
regardless of confidence. Agreeing to terms is categorically different from typing a name.

### 6.3 CAPTCHA/login walls stop the run
Detection is layered — DOM signals (visible `getComputedStyle`, not just `offsetParent`, so
`position: fixed` CAPTCHA widgets are still caught), specific text phrases (not bare
"captcha"/"recaptcha", which false-positives on legal footer text), and an OCR fallback on
the backend. On a hit, the run stops and hands off to the user rather than attempting to
bypass anything.

### 6.4 Text-matching normalization (and its limit)
`selectMatchingOption()` strips apostrophes/punctuation before comparing, so "Bachelor's" and
"Bachelors" compare as identical regardless of which format the profile uses. This is
deliberately **not** applied when either side, after normalization, is under 3 characters —
confirmed via testing that "C++" normalizes down to just "c", which then appears as a
substring in almost any word and wins the coverage bonus for completely unrelated options.

### 6.5 Multi-value (checkbox/multi-select) fields
Two different behaviors, controlled by `PRIORITY_ONLY_FIELDS`:
- **Default (skills, languages):** every comma-separated value that matches an option gets
  selected.
- **Priority-only (`referral_source`):** the first value that matches wins, and the rest are
  never attempted. Selecting multiple "how did you hear about us" sources looked broken on
  some widgets (the field appeared empty) rather than useful, unlike skills where selecting
  every match is the actually-wanted behavior.

### 6.6 Single-frame vs multi-frame pages
Most pages are single-frame — the banner shows immediately, no delay. Some pages (confirmed
on one Ashby "careers" wrapper page) embed the real application form in an iframe while the
top-level page is an empty shell, or vice versa. `content.js` only runs the (slower, polling)
frame-detection logic when the page actually contains an `<iframe>` at all — single-frame
pages skip straight to showing the banner, so the common case stays instant.

### 6.7 Workday's multi-page apply flow
Workday's application is a single-page app internally — moving between steps (My Information
→ My Experience → Education → …) doesn't change the URL in a way we could always detect, and
earlier steps' fields stay in the DOM but hidden rather than being removed. Two fixes:
- The scan is filtered to only currently-**visible** blocks (`isVisible()`), so hidden
  earlier-step fields don't get double-counted or re-scanned.
- The banner is a permanent watchdog (recreated every second if missing from the DOM) so it
  survives whatever internal re-navigation Workday does between steps.

---

## 7. Platform-specific notes

### 7.1 Google Forms
Selectors confirmed via live inspection early in the project; the most stable of all
platforms since Google Forms' structure doesn't vary between forms the way ATS platforms do.

### 7.2 Ashby
Question containers use two different tags depending on widget type — plain fields are
`<div class="...ashby-application-form-field-entry">`, but radio/checkbox-group fields are
`<fieldset class="..._fieldEntry_...">`. Matching on the shared `_fieldEntry_` hashed-class
substring (ignoring the exact hash suffix) covers both without special-casing the tag.

### 7.3 Greenhouse
The modern `job-boards.greenhouse.io` (Remix-based) redesign — the old `boards.greenhouse.io`
embed no longer exists; that URL now redirects to the same new system for every company.
Different field types use different (but stable, non-hashed) wrapper classes: text fields use
`input-wrapper`, react-select dropdowns use `select__container`, and checkbox/radio groups use
`fieldset.checkbox` / `fieldset.radio` — the last of which titles itself with a `<legend>`,
not a `<label>`.

### 7.4 Lever
Custom "additional questions" (anything with a `cards[...]` field name, e.g. Language
Skills, Graduation Date) are wrapped in a completely plain, unlabeled `<div>` — no
`application-question` class the way built-in fields (Name, Email) have. The
`:has(> .application-label)` CSS selector catches both patterns without needing to know each
container's specific class.

### 7.5 Workday
The most complex platform, for several reasons:
- **`data-automation-id` values are prefixed, not exact** (`formField-degree`, not
  `formField`) — selectors need `^=` (starts-with), not `=` (exact match).
- **Search-combobox widgets** (Field of Study, Skills, School, "How Did You Hear") require
  typing the value **and pressing Enter** — typing alone doesn't trigger Workday's real
  filter; without Enter, the shown "results" aren't actually filtered by the query at all.
- **Selected-item chips also carry `role="option"`**, identical to real dropdown options —
  the option-query selector explicitly excludes anything with an `id` starting `pill-`
  (`[role='option']:not([id^='pill-'])`) to avoid matching an already-selected chip instead of
  a real, unselected option.
- **Year-only spinbutton fields** (Education's From/To) need just the 4-digit year extracted
  from the profile value, not the full date string — a bare `role="spinbutton"` input with
  `aria-label="Year"` or `data-automation-id="dateSectionYear-input"` gets this treatment
  automatically.
- **Repeatable sections (Education, Work Experience)** have their own dedicated functions
  (`fillEducationSection()`, `fillWorkExperienceSection()`), not the generic scan-and-fill
  pipeline, because they need to click "Add"/"Add Another" once per profile entry and target
  each newly-created panel directly via `data-automation-id`, not fuzzy text-hint matching.
  `getOrCreatePanel()` handles both cases seen across tenants — some show "Entry 1" by default
  with no Add needed, others start completely empty. **Format:**
  ```json
  // profile.education
  [{"school": "...", "degree": "Bachelors", "field_of_study": "...", "cgpa": "3.7",
    "start_year": "2021", "end_year": "2025"}]

  // profile.work_experience
  [{"job_title": "...", "company": "...", "location": "...", "start_date": "MM/YYYY",
    "end_date": "MM/YYYY", "is_current": false, "description": "..."}]
  ```
  When `profile.education` is populated, the generic single-field scan defers entirely to
  `fillEducationSection()` **but only on pages that actually have a Workday-style repeatable
  Education section** (`[aria-labelledby="Education-section"]`) — this guard is scoped to
  avoid disabling the flat single-field education questions on other platforms just because
  the profile also has the newer array format filled in for Workday's sake.

---

## 8. AI features

### 8.1 AI Suggest (long-answer questions)
For `<textarea>` fields the confidence-matcher can't handle (e.g. "Best project you worked
on", "Expected CTC") — these will never match a fixed profile-field hint — a small
"✨ AI Suggest" button appears next to the field. Clicking it calls
`POST /api/llm/suggest-answer` (Flask) with the question text and a compact, relevant-only
profile summary (skills, education, work experience). Mistral generates a draft; the user
sees it in an editable popup and must explicitly click **Insert** — nothing is ever
auto-filled from this path.

### 8.2 Legal-section validation
Not yet built. Planned: analyze free-text the candidate writes (or drafts via §8.1) for
legally risky phrasing and suggest safer alternatives, using the same Mistral-backend pattern.

---

## 9. Setup

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_KEY, MISTRAL_API_KEY, etc.
python app.py           # http://localhost:5000

# Extension
# chrome://extensions -> Developer mode -> Load unpacked -> select extension/
# Copy the extension's ID, add it to CORS_ORIGINS in backend/.env, restart the backend

# Supabase
# Run schema_update.sql against your profiles table
```

---

## 10. Known limitations / pending

- **Country/dial-code fields** (e.g. Workday's "Country Phone Code") intentionally have no
  dedicated profile field — matching the full phone number against a dial-code-only option
  list would never succeed correctly, so this stays manual by design.
- **Education's "From" field on Workday** relies on a generic `"from"` hint, which is
  ambiguous with Work Experience's own "From" field on pages with both sections. This is
  currently accepted since Work Experience's dates are filled via exact `data-automation-id`
  matching (not this hint), so the risk is a re-run scenario only, not the first run.
- **CGPA on Workday's Education section** — its `data-automation-id` wasn't confirmed via
  live inspection; the code tries a couple of reasonable guesses, then falls back to a
  text-search within the panel for a "GPA"/"overall result" label.
- **LinkedIn** — deliberately out of scope; see §3.
