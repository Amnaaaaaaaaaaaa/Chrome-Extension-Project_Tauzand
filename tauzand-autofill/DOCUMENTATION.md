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
- **Compliance/screening questions:** `non_compete_restrictions`, `us_government_employee`,
  `export_control_restricted_country` — plain "Yes"/"No" fields for common Workday compliance
  questionnaire items
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

### 6.8 Trusted keyboard input (`chrome.debugger`, extended to typing)
Workday's date-spinbutton fields (Month/Day/Year) still showed "Invalid Date" even after
setting `.value` correctly via the React-safe native setter *and* dispatching `input`,
`change`, and `blur` — the validation logic needed genuinely trusted keystrokes, the same
`isTrusted` boundary that motivated trusted clicks (§6.1). `background.js` extends the CDP
service with `Input.dispatchKeyEvent`, sending real `keyDown`/`keyUp` pairs character by
character, with a short (~60ms) pause between characters — dispatching them back-to-back with
no gap caused corrupted values (e.g. "06" became "00"), apparently from event-queue collisions
on Workday's side.

### 6.9 Question titles aren't always `<label>`
Several Workday and Greenhouse questions title themselves with `<legend>` (Greenhouse's
`fieldset.checkbox`/`fieldset.radio`, and Workday questionnaire items like "Would you consider
relocating") instead of `<label>` — `questionTitleSelector` includes both, per platform, or a
block's title comes back empty and the whole question is silently skipped. Workday also has
free-text answers that use `<textarea>` rather than `<input>` (e.g. "Please enter your name"
signature fields) — `textInputSelector` includes `textarea` for the same reason.

### 6.10 Selected-item chips can share the same attributes as real options
Beyond the `role="option"` collision already noted in §7.5, Workday's chip *label* element
(the `<p>`/`<div>` showing the already-selected value, e.g. "JavaScript, press delete to
clear") also carries `data-automation-id="promptOption"` — the same attribute used for real,
selectable dropdown options — and often has **no `id` at all**, so a `:not([id^='pill-'])` CSS
exclusion alone doesn't catch it. The option-collection step also filters out anything that is
a *descendant* of a `[id^='pill-']` container via `.closest()`, which catches the chip's inner
label regardless of whether the label itself has an id.

### 6.11 Automation-id overrides for generically-titled questions
A small number of questions have a title too generic for any hint list to match confidently —
Workday's disability self-identification question is literally titled "Please check one of the
boxes below:" with no mention of "disability" anywhere in the visible text. For these, the
block's own `data-automation-id`/`id` (e.g. `disabilityStatus-CheckboxGroup`) is used as a
direct override to the matched profile key, bypassing the fuzzy title-matching path entirely
rather than trying to expand the hint list to cover an unrelated generic phrase.

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
  a real, unselected option. See §6.10 for the chip *label* variant of this same problem.
- **Date-section fields (Month/Day/Year) need trusted keystrokes**, not just a correct
  `.value` — see §6.8. `fillDateSectionInput()` handles this for all three of Workday's date
  contexts: Education's Year-only fields, Work Experience's Month+Year fields, and signature
  "today's date" fields (Month+Day+Year).
- **Year-only spinbutton fields** (Education's From/To) need just the 4-digit year extracted
  from the profile value, not the full date string — a bare `role="spinbutton"` input with
  `aria-label="Year"` or `data-automation-id="dateSectionYear-input"` gets this treatment
  automatically.
- **Not every question title is a `<label>`** — see §6.9.
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

## 8. AI architecture

Built around a **Question Processing Array**: every field on the page is scanned once and
classified into a category (`personal`, `education`, `experience`, `known_field`, `behavioral`,
`technical`, `legal`, or `unknown`) *before* any decision is made about how to fill it. This
happens in `classifyQuestion()` (`matcher.js`) + `buildQuestionProcessingArray()` (`content.js`),
and is the foundation everything else in this section is built on top of.

The core cost principle: **one Mistral call per form**, regardless of how many AI-assisted
fields that form has. Every category below that needs AI is collected into arrays first, then
sent together in a single `POST /api/llm/batch-generate-behavioral` request — never one call
per question. Confirmed via testing on a 6-behavioral-question form: `batched behavioral
answers ready: 6/6` from exactly one network request.

### 8.1 What gets classified where, and what happens to it

| Classification | Where it comes from | What happens |
|---|---|---|
| `personal` / `education` / `experience` / `known_field` | Matched a profile key above the fill threshold | Filled straight from Supabase — no AI involved (Step 3 of the pipeline: DB first) |
| `behavioral` | Textarea matching `BEHAVIORAL_KEYWORDS`, or any unmatched textarea as a catch-all | Sent to Mistral as an OPEN question (free-text answer) |
| `technical` | Textarea matching `TECHNICAL_KEYWORDS` (e.g. "describe your experience with", "technical challenge") | Sent to Mistral in the *same* batch as `behavioral` — identical generation treatment, kept as a distinct classification label per the requested category list |
| `legal` | Checkbox/radio/dropdown matching `LEGAL_CHECKBOX_KEYWORDS`, or textarea matching `LEGAL_TEXT_KEYWORDS` | Consent groups: **never auto-checked**, but analyzed for a plain-English breakdown (§8.4). Free-text legal questions: separate "Check for legal risk" feature (§8.6), unrelated to the batch call |
| `unknown` (radio/checkbox with real options) | No confident DB match, but the field has selectable options | Sent to Mistral as a CHOICE question — pick from the given options (§8.3) |
| `unknown` with a `profileValueHint` | Matched a DB key, but the stored value doesn't textually match any option (e.g. `gender: "Female"` vs. a form's "Man"/"Woman") | Also sent as a CHOICE question, with the stored value given as a translation hint — this is a synonym problem, not a missing-value problem |
| `unknown` (everything else — comboboxes, non-checkbox/radio fields) | No confident match, no usable option list | Left for manual review, same as before this AI work — see §10 for why this specific case (text-input-backed comboboxes) isn't covered yet |

### 8.2 The batched call (`POST /api/llm/batch-generate-behavioral`)

Despite the name (kept for backward compatibility), this single endpoint now handles three
independent kinds of work in one request:

```json
// Request
{
  "questions": ["Why do you want to join our company?", "..."],      // behavioral + technical
  "choiceQuestions": [
    {"question": "...", "options": ["Man", "Woman", "..."], "fieldKind": "radio",
     "profileValueHint": "Female"}
  ],
  "legalItems": ["I acknowledge that I have read and agree to the Privacy Policy..."],
  "profile": {...},     // PII-stripped — see below
  "jobContext": "Software Engineer Intern (Fall 2026) at cloudflare"
}
```

```json
// Response
{
  "success": true,
  "results": [{"question": "...", "answer": "...", "confidence": 0.9, "requires_review": false}],
  "choiceResults": [{"question": "...", "answer": "Woman", "confidence": 0.95, "requires_review": false}],
  "legalResults": [{"type": "legal_consent", "checkpoints": [...], "risk_flags": [...],
                     "recommended_action": "review", "requires_review": true}]
}
```

**PII exclusion** (explicit requirement): the profile summary built for the prompt only ever
includes skills, education, work experience, and current company — phone, email, GitHub, and
LinkedIn are never included in what's sent to Mistral, enforced in `app.py`'s
`profile_summary` construction, not left to the model to decide.

**Cache-key matching is by array position, not by text-matching Mistral's echoed question.**
Confirmed via testing: Mistral doesn't always repeat a question byte-for-byte (dropped a
trailing `*`, minor rewording), which broke a naive `cache.set(result.question, ...)` even
when the batch call itself succeeded. The cache is populated by matching `results[i]` to the
original `behavioralEntries[i]` by index instead.

**Token budget scales with content, not just count.** The batch endpoint's `max_tokens` is
computed as `500 * len(questions) + 150 * len(choiceQuestions) + 250 * len(legalItems)`.
Confirmed via testing that an earlier flat `200 * len(questions)` budget was too tight —
Mistral's response (which has to repeat each question plus write a 3-5 sentence answer) got
cut off mid-JSON, causing a parse failure (`Unterminated string...`) that silently fell back to
per-field calls instead of using the batch. The fix wasn't a smarter parser — it was giving the
model enough room to actually finish.

### 8.3 Choice-field AI assist ("unknown" and value-mismatch fields)

For radio/checkbox fields Mistral is asked to pick from a fixed option list — **never write
free text and never invent an option that isn't in the list** (e.g. answering "No preference"
or "N/A" when neither is a real option, confirmed as a failure mode during testing before this
constraint was added explicitly). Multi-select questions (marked `"fieldKind": "checkbox"` in
the request) may return more than one option separated by `" | "`; the accept-handler splits on
that separator and clicks each matched option in turn, rather than treating the whole combined
string as one option to search for (which would never match, since no real option literally
contains a pipe character).

Shown as a "✨ AI suggests: '...' — click to accept" button next to the field — clicking it
calls `selectMatchingOptionWithOthersFallback()` (§8.5) against the field's real options and
clicks the match. Below the confidence threshold in §8.7, this button is the only way the
suggestion gets applied; above it, it's applied automatically (§8.7).

### 8.4 Legal-consent structured breakdown

For legal-consent checkbox/radio/dropdown groups (never for free-text legal questions — those
have a separate feature, §8.6), Mistral analyzes the *actual consent text on the page* into:
`checkpoints` (2-4 short bullets on what it's actually asking for), `risk_flags` (anything
unusual or worth extra attention), and `recommended_action` (`"review"` or `"straightforward"`).
Displayed as an info box directly under the checkbox, explicitly labeled "AI summary of this
section — you still need to read and decide yourself." **The checkbox itself is never touched**
— this is purely informational, layered on top of the existing "always leave consent to the
user" rule (§6.2), not a replacement for it.

### 8.5 "Always check Others"

`selectMatchingOptionWithOthersFallback()` wraps the core `selectMatchingOption()` matcher: if
no exact or equivalent option is found, it looks for a standalone "Other"/"Others" option
(`/^others?\b/i` — matches "Other (please specify)", doesn't match "Another" or "otherwise")
and selects that instead of leaving an answerable question unfilled. Applied to every
**single-value, fixed-option-list** match site (native `<select>`, single-answer checkboxes,
radio groups, Workday's Degree button, the AI-suggestion accept flow) — deliberately **not**
applied to multi-value loops (Skills, Languages, comma-separated referral sources), where
falling back to "Others" for every individual unmatched item in a multi-select list would be
wrong, and not applied to typed-search comboboxes (School, Field of Study), where "Others"
wouldn't reliably appear among live search results for an unrelated query anyway.

### 8.6 Job/company context

`extractJobContext()` pulls the job title and company name into the prompt for behavioral/
technical answers, so "why do you want to join us" references the actual role instead of being
fully generic. Tries `og:title` → first `<h1>` → `document.title` for the job title, and
`og:site_name` → the URL's first path segment for the company name (Greenhouse, Lever, and
Ashby all put the company slug there — `greenhouse.io/cloudflare/...`,
`lever.co/quantco-/...`, `ashbyhq.com/Ashby/...`) as a fallback when the meta tag isn't present,
which is common on some postings.

### 8.7 Step 7 — auto-fill on high confidence

Deliberately conservative: `AI_AUTOFILL_CONFIDENCE_THRESHOLD = 0.85`, higher than
`MIN_TEXT_FIELD_CONFIDENCE` (0.75) used for plain DB matches, because AI-*generated* content
(vs. a straight profile lookup) carries more risk of being subtly wrong. When a behavioral/
technical/choice answer clears this bar **and** `requires_review` is `false`, the field is
filled or the option is clicked directly — no button click required — but always with a visible
"🤖 AI-filled — please review before submitting" marker next to it, so it's never mistaken for
a plain, unremarkable DB match and skipped over at review time. Below the threshold, the
original manual accept-button behavior is unchanged. **Legal-consent sections are excluded from
this entirely, at any confidence level** — see §8.4; a consent checkbox is never auto-checked
under any circumstance.

### 8.8 AI Suggest (long-answer questions, single-field fallback)

The original, still-live fallback path: if the batch call fails entirely (network error, parse
failure) or a field wasn't part of it for some reason, clicking "✨ AI Suggest" makes a live
`POST /api/llm/suggest-answer` call for just that one field instead. Same strict-JSON shape
(`answer`/`confidence`/`requires_review`) as the batch endpoint, same PII exclusion, shown in
the same editable-popup pattern requiring an explicit Insert click.

### 8.9 Legal-risk check (legal-sensitive free-text questions)

For `<textarea>` fields whose title matches a legal-sensitive keyword (`LEGAL_TEXT_KEYWORDS`
in `matcher.js` — "conviction", "lawsuit", "explain any", "non-compete", etc.), a
"⚖️ Check for legal risk" button appears whenever the candidate has already typed something
into the field. Clicking it calls `POST /api/llm/validate-legal-text` with the question and
the candidate's current text; Mistral analyzes it and returns a short risk note plus a
suggested revision that preserves the same facts but phrases them more carefully. Shown in the
same editable-popup, explicit-Insert pattern as §8.8 — the substance of what the candidate
wrote is never changed without them reviewing and accepting it.

This is distinct from `LEGAL_CHECKBOX_KEYWORDS` (§6.2) and the consent breakdown (§8.4), which
are about checkboxes that are never auto-checked at all — this feature is about free-text prose
the candidate writes themselves, which the two keyword lists (`LEGAL_CHECKBOX_KEYWORDS` vs
`LEGAL_TEXT_KEYWORDS`) keep separate on purpose.

### 8.10 Matching robustness: short strings after normalization
`selectMatchingOption()` normalizes punctuation before comparing (so "Bachelor's" and
"Bachelors" match), but this broke technical terms like "C++", which normalizes down to just
"c" — a single character that appears as a substring in almost any word, incorrectly winning
the coverage-bonus match against completely unrelated options (e.g. "TypeScript" matching
"C++"). The normalized-comparison path now only applies when both sides are at least 3
characters after normalization; shorter strings fall back to the raw (unnormalized)
comparison.

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
- **Pages where the real form is in an iframe on a page whose own domain isn't independently
  recognized** — the multi-frame detection (§6.6) waits for real fields to appear in whichever
  frame has them, but this was tuned against one specific Ashby wrapper page; a page with
  unusually slow third-party scripts could still exceed the poll window in rare cases.
- **"Unknown" fields that are text-input-backed comboboxes** (Greenhouse/Ashby/Workday
  dropdown-style questions rendered as a search input, not a native `<select>` or a visible
  radio/checkbox group — e.g. Greenhouse's "Are you Hispanic/Latino?") don't get the choice-AI
  treatment in §8.3, since their real options only exist once the widget is opened, which the
  classification pass doesn't do. A version of this was built and tested (opening each such
  field, reading its options, and sending them in a second batch call) but was reverted at the
  user's request to keep the "one call per form" guarantee exact rather than "one or two calls
  per form" — these fields fall back to plain manual review, same as before this AI work.
- **Dashboard-dependent pieces of Point 2 (Legal Consent)** — a signup-time preference for
  whether AI should analyze legal sections at all, and an explicit "exit automated flow, go
  fully manual" option, both require the Tauzand user dashboard (Next.js), which is a separate,
  not-yet-started phase. The AI analysis feature itself (§8.4) works today; what's missing is
  the *opt-out* control layer around it.
- **LinkedIn** — deliberately out of scope; see §3.