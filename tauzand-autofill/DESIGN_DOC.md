# Tauzand Auto-Apply — Execution Checkpoint: Design Notes

*Paste this whole doc into the shared Google Doc requested in the task email. Sections
below map directly to what the task asked for.*

## 1. Architecture Summary

```
Next.js (frontend)  --REST/JSON-->  Flask (backend)  --Selenium-->  Real Chrome session
                                          |
                                          +--> Supabase (candidate profile + run logs)
                                          +--> Tesseract OCR (local, hardcoded, no paid API)
                                          +--> Audio alert (system beep) on CAPTCHA/login wall
```

- **`platform_configs.py`** holds all per-site selectors. Adding a new platform is a config
  entry, not a code change — this is what "editable, no hardcoded values" means in practice
  here.
- **`form_filler.py`** is the pipeline: `scan_form()` (find + label fields) →
  `fill_fields()` (match to profile, inject) → orchestrated by `run_fill()`. Each stage is a
  separate function so any one of them (e.g. the label-matching heuristic) can later be
  swapped for a real LLM call without touching the rest.
- **`captcha_detector.py`** runs three layered checks — DOM selectors, visible-text
  keywords, OCR-on-canvas fallback — and never attempts to solve anything it finds. It only
  ever hands off to a human via `audio_alert.py`.
- The backend **never auto-submits** a form. It fills fields and leaves the browser open for
  the user to review and click Submit themselves — same principle as the "never auto-submit"
  rule in the original proposal, kept intentionally even at prototype stage.

## 2. Why Google Forms as the checkpoint reference target

Workday and LinkedIn both sit behind auth walls and active bot-detection; using them for a
*first* checkpoint demo would make the video flaky for reasons unrelated to whether the
fill logic works. Google Forms has no auth wall and a stable DOM, so it's the cleanest way
to prove out field-detection + injection + latency measurement. Workday/LinkedIn configs are
already stubbed in `platform_configs.py` so extending to them is additive.

## 3. Edge cases covered in this checkpoint (and how)

| Edge case | Handling |
|---|---|
| CAPTCHA present | `captcha_detector.check_for_captcha` — DOM selector scan → keyword scan → OCR-on-canvas fallback. Fires `audio_alert` and halts the run rather than guessing. |
| "Not a robot" checkbox | Covered by the same CAPTCHA selectors (`recaptcha`/`hcaptcha` iframes render this checkbox). |
| Login / auth wall | `captcha_detector.check_for_login_wall` — looks for password fields and sign-in copy before attempting to fill. |
| Ambiguous / duplicate field labels | `_best_profile_match` returns a confidence score; anything below `min_confidence` (default 0.75) is left unfilled and reported in `skipped`, not guessed at. |
| Async-loaded fields | `DOM_STABILIZE_WAIT_SECONDS` pause + `WebDriverWait` on the form container before scanning, matching Edge Case 1 in the original proposal. |
| Missing profile data | If a matched field's profile value is empty/None, it's skipped with reason `profile_value_missing` rather than injecting a blank/garbage value. |
| DOM injection failure | Wrapped in try/except per field; one field failing doesn't abort the whole run. |
| False-positive login detection on pages with a harmless "sign in" link (e.g. Google Forms' optional account-switch link) | **Found during checkpoint testing.** Narrowed `LOGIN_KEYWORDS` to specific phrases ("sign in to continue", "sign in to submit this form", etc.) instead of a bare "sign in", and made password-field presence the primary signal, keyword scan a backstop only. See `config.py` and `captcha_detector.check_for_login_wall`. |
| Field labels coming back empty on Google Forms | **Found during checkpoint testing.** `platform_configs.py` already defined per-platform `question_selector`/`question_title_selector` but `scan_form()` wasn't using them — it only ran a generic label-lookup that assumes standard `<label for>`/`aria-label` wiring, which Google Forms doesn't use. Fixed by scoping detection to each question block and reading its heading text directly. |
| Chrome window closing itself a short time after a fill completed | **Found during checkpoint testing.** The `driver` object had no reference left once `run_fill()` returned, so Python's garbage collector eventually tore down the chromedriver subprocess. Fixed with an `_open_drivers` registry in `form_filler.py` that keeps a strong reference until `/api/close-session/<driver_id>` is explicitly called. |
| Ambiguous field labels matched to the wrong profile key (e.g. "Last Name" filled from `full_name` instead of `last_name`; "Email Address" filled from `address` instead of `email`) | **Found during checkpoint testing.** The substring-match scorer gave every hint a flat 0.9 regardless of how much of the label it actually explained, so a short generic hint ("name") tied with a more specific one ("last name") and won on dict order alone; separately, "address" being a literal substring of "Email Address" out-scored "email" itself. Fixed by (1) scoring substring matches by how much of the label the hint covers, so more specific/longer hints win, and (2) adding explicit compound hints like "email address" so common two-word labels resolve to the right key instead of colliding with a shorter, unrelated hint. See `_best_profile_match` in `form_filler.py` for the full explanation. |
| Bot-detection via typing pattern | `_human_type` types character-by-character with randomized delay (40–120ms), not an instant `send_keys()`. |
| Canvas/image-only CAPTCHA (no usable DOM text) | OCR fallback (`ocr_service.looks_like_captcha_image`) flags canvas elements that OCR to garbage/short strings. |

*(Full 10–15 edge case list from the Phase 1 proposal still applies going forward —
multi-step workflows, file uploads, iframes, OAuth flows, etc. — those are documented in the
Phase 1 proposal PDF and are Phase 2 scope; this checkpoint focuses on demonstrating the core
fill mechanism plus the intervention-detection edge cases above.)*

## 4. Latency measurement approach

`form_filler.run_fill()` times the whole run (`time.time()` at start/end) and returns
`duration_ms` in the API response; this is also logged to Supabase's `fill_runs` table per
run so latency can be tracked across multiple demo runs, not just eyeballed once on camera.

**What to report in the video:** page-load-to-first-field-detected time, and total
detect+fill duration, both read directly off the `/api/fill-form` response.

## 5. Demo script (for the video)

1. Show `README.md` and the repo structure — narrate the architecture summary above.
2. Start backend (`python app.py`) and frontend (`npm run dev`).
3. Open the frontend, paste a real Google Form URL + `demo-user-1` profile ID, click **Run
   Auto-Fill**.
4. Narrate as Chrome opens: form detection, field labels being matched, values being typed
   with human-like delay.
5. Show the JSON result in the UI: filled fields with confidence scores, skipped fields with
   reasons, `duration_ms`.
6. Trigger the CAPTCHA/login path deliberately (e.g. point it at a Google Form that requires
   sign-in, or a page with a reCAPTCHA test badge) — show the audio alert firing and the run
   halting instead of guessing.
7. Close by pointing at `platform_configs.py` and explaining how Workday would be added
   without touching the fill engine.

## 6. Known limitations at this checkpoint (intentionally out of scope per the task email)

- No auth/rate limiting/monitoring — per the brief's instruction to keep it simple.
- Workday/LinkedIn are configured but not demoed live (auth walls — see §2).
- Label-matching is a local fuzzy-match heuristic, not yet the Mistral-based classifier from
  the Phase 1 proposal; that swap is a single function (`_best_profile_match`) once an API
  key/budget is approved.

## 7. Expanded scope (per Chawala's checkpoint-approval reply)

Three additions on top of the original text-field-only checkpoint:

**Radio buttons, checkboxes, dropdowns.** `scan_choice_fields()` / `fill_choice_fields()` in
`form_filler.py` mirror the text-field pipeline (scan → match → fill) but work on option
groups instead of typed values. Matching reuses the same `_best_profile_match` heuristic
against the question's title, then fuzzy-matches the profile's value against the group's
available option text.

**One hard safety rule: legal/consent checkboxes are never auto-checked.** Any radio or
checkbox group whose question text or options mention terms/consent/agreement language
(`LEGAL_CHECKBOX_KEYWORDS` in `config.py`) is *always* routed to manual review, regardless of
confidence score. This is a deliberate design decision, not a missing feature: ticking "I
agree to the Terms and Conditions" on someone's behalf represents them actually agreeing to
something, which is a different kind of action than typing their name into a text box.
`_is_legal_consent_group()` documents the reasoning inline.

**Mistral for job-description analysis — cache-first, not full RAG.** `mistral_client.py`
extracts keywords from a job description with a single Mistral call, then caches the result
in Supabase (`job_description_keywords`, keyed by a hash of the description text) so the same
posting never triggers a second paid call. This is the lightweight version of "storing and
reusing relevant keywords" from the brief — full vector-DB RAG felt like more infrastructure
than a checkpoint needs; this checkpoint's version is closer to "cached extraction +
keyword-overlap scoring," which is cheap, fast, and already covers the concrete use case
(picking the right resume for a job).

**Resume upload & selection.** `resume_service.py` stores user-uploaded resumes (never
auto-generated) per profile, fires the same audio-alert mechanism on a successful upload, and
picks the best-matching saved resume for a job description by scoring each resume's
label/filename against the cached keyword list. Matching against full resume *text* (via
OCR/parsing) is flagged as Phase 2 scope — this checkpoint matches on the label/filename the
user provides at upload time, which is zero-cost and sufficient to prove the mechanism.

## 8. Open question back to Chawala

Worth confirming before Phase 2: should legal/consent checkboxes ever be auto-checked once a
user has explicitly pre-approved a *specific* checkbox wording in their profile settings, or
should the "always manual" rule stay permanent regardless of any future settings toggle? This
checkpoint assumes the latter (always manual) since it's the safer default.
