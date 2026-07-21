"""
The actual auto-fill engine. Logic is deliberately split into small, named
functions (scan -> match -> fill) rather than one long procedure, so each stage
can be tested, replaced, or extended independently — e.g. swapping the
label-matching heuristic for a real NLP/LLM call later is a one-function change.

This talks to platform_configs.py for "where things are on this site" and to
captcha_detector.py for "should I stop and ask a human right now".
"""
import random
import time
import uuid
from difflib import SequenceMatcher

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    TimeoutException, NoSuchElementException, WebDriverException, StaleElementReferenceException,
)

from config import Config
from services import platform_configs
from services.captcha_detector import run_all_checks


# Maps common profile keys -> label fragments we'd expect a form to use.
# This is the "local heuristic" layer described in the proposal (section 2.3,
# Stage 2) that runs before/instead of an LLM call, and is what this checkpoint
# demonstrates end-to-end without needing a paid AI API key.
# Using a dict (hash map) instead of a linear list-of-tuples scan so a lookup
# by profile key is a direct hash access rather than a scan of every hint.
# TC: O(1) average to fetch a profile key's hint list | SC: O(k) for k known profile keys
FIELD_LABEL_HINTS = {
    "full_name": ["full name", "your name", "name"],
    "first_name": ["first name", "given name"],
    "last_name": ["last name", "surname", "family name"],
    # "email address" listed before the bare "email" so a label like "Email
    # Address" scores higher on this specific compound than on the generic
    # "address" key it happens to contain as a substring (found during
    # checkpoint testing — see _best_profile_match docstring for the general
    # coverage-scoring fix this relies on).
    "email": ["email address", "email"],
    "phone": ["phone", "mobile", "contact number"],
    "address": ["home address", "street address", "mailing address", "address", "street"],
    "city": ["city"],
    "linkedin_url": ["linkedin"],
    "portfolio_url": ["portfolio", "website"],
}


def build_driver() -> webdriver.Chrome:
    options = Options()
    if Config.SELENIUM_HEADLESS:
        options.add_argument("--headless=new")
    options.add_argument("--disable-blink-features=AutomationControlled")
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(Config.SELENIUM_PAGE_LOAD_TIMEOUT_SECONDS)
    driver.implicitly_wait(Config.SELENIUM_IMPLICIT_WAIT_SECONDS)
    return driver


def _label_for(driver, element) -> str:
    """Best-effort label text for an input: <label for>, aria-label, placeholder, then nearby text."""
    try:
        el_id = element.get_attribute("id")
        if el_id:
            labels = driver.find_elements(By.CSS_SELECTOR, f"label[for='{el_id}']")
            if labels:
                return labels[0].text.strip()
    except WebDriverException:
        pass

    for attr in ("aria-label", "placeholder"):
        value = element.get_attribute(attr)
        if value:
            return value.strip()

    try:
        parent = element.find_element(By.XPATH, "./ancestor::div[1]")
        text = parent.text.strip()
        if text:
            return text.split("\n")[0]
    except (NoSuchElementException, WebDriverException):
        pass

    return ""


def _best_profile_match(label: str) -> tuple[str, float]:
    """
    Fuzzy-match a field label against known profile keys. Returns (key, score).

    Bug fixed after checkpoint testing: a bare substring match used to score a
    flat 0.9 regardless of how much of the label it actually covered, so the
    generic "name" hint under full_name (which matches "Last Name", "First
    Name", AND "Full Name" — they all contain the word "name") tied with the
    more specific "last name" hint under last_name, and the tie was silently
    won by whichever profile_key happened to come first in the dict. Scoring
    substring matches by how much of the label the hint covers fixes this:
    "last name" (9 chars) covers more of "last name *" than "name" (4 chars)
    does, so last_name now correctly outscores full_name.
    """
    label_lower = label.lower()
    best_key, best_score = "unknown", 0.0
    for profile_key, hints in FIELD_LABEL_HINTS.items():
        for hint in hints:
            score = SequenceMatcher(None, hint, label_lower).ratio()
            if hint in label_lower:
                coverage_bonus = 0.25 * (len(hint) / max(len(label_lower), 1))  # rewards hints that explain more of the label
                score = max(score, 0.70 + coverage_bonus)
            if score > best_score:
                best_key, best_score = profile_key, score
    return best_key, best_score


def scan_form(driver, platform_key: str) -> list[dict]:
    """
    Stage 1 (proposal 2.2): find visible text-input-like fields inside the
    platform's form container and return field metadata — no filling yet.

    Scoped per-question using the platform's question_selector /
    question_title_selector (Google Forms wraps each question in a
    div[role='listitem'] with a role='heading' title — reading the title
    directly like this is far more reliable than the generic label-guessing
    in _label_for, which came back empty on Google Forms during testing
    because its inputs don't use <label for> or aria-label the way a plain
    HTML form does).
    """
    platform_configuration = platform_configs.get_config(platform_key)  # per-site selectors, so this function has zero hardcoded selectors of its own

    try:
        WebDriverWait(driver, Config.FORM_SCAN_TIMEOUT_SECONDS).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, platform_configuration["form_container_selector"]))
        )
    except TimeoutException:
        return []

    time.sleep(Config.DOM_STABILIZE_WAIT_SECONDS)  # let async-rendered fields settle

    question_selector = platform_configuration.get("question_selector")
    question_blocks = driver.find_elements(By.CSS_SELECTOR, question_selector) if question_selector else [driver]

    fields = []
    for question_block in question_blocks:
        question_title = ""  # the question's heading text, e.g. "First Name" — preferred label source
        title_selector = platform_configuration.get("question_title_selector")
        if title_selector:
            try:
                question_title = question_block.find_element(By.CSS_SELECTOR, title_selector).text.strip()
            except NoSuchElementException:
                pass

        inputs = question_block.find_elements(By.CSS_SELECTOR, platform_configuration["text_input_selector"])
        for element in inputs:
            if not element.is_displayed():
                continue
            label = question_title or _label_for(driver, element)  # fall back to generic detection if no question title found
            profile_key, confidence = _best_profile_match(label)
            fields.append({
                "element": element,
                "label": label,
                "profile_key": profile_key,
                "confidence": round(confidence, 2),
            })
    return fields


def _human_type(element, value: str):
    """Types character-by-character with jitter, matching the anti-bot-detection
    behaviour described in the proposal's CAPTCHA edge case, rather than one
    instant .send_keys() call."""
    minimumDelayMs, maximumDelayMs = Config.FIELD_TYPE_DELAY_MS  # per-character typing delay bounds, read from config (SOP 3.7: no hardcoded values)
    for character in value:
        element.send_keys(character)
        time.sleep(random.randint(minimumDelayMs, maximumDelayMs) / 1000)


def _is_legal_consent_group(question_title: str, option_texts: list[str]) -> bool:
    """
    True if a radio/checkbox group looks like a legal/consent question ("I
    agree to the Terms", privacy consent, certification statements, etc).

    This check exists to gate a hard rule, not a confidence score: legal
    checkboxes are NEVER auto-selected by this tool, no matter how well a
    profile value might seem to match. Ticking "I agree to the Terms and
    Conditions" on someone's behalf is a materially different action than
    typing their name into a text box — it represents them actually agreeing
    to something — so this one category always goes to manual review,
    deliberately overriding the normal confidence-based fill/skip logic below.
    """
    combined_text = f"{question_title} {' '.join(option_texts)}".lower()
    return any(keyword.strip() in combined_text for keyword in Config.LEGAL_CHECKBOX_KEYWORDS if keyword.strip())


def _option_text_for(option_element) -> str:
    """Best-effort display text for a single radio/checkbox/dropdown option element."""
    for attribute in ("aria-label", "data-value"):
        value = option_element.get_attribute(attribute)
        if value:
            return value.strip()
    return option_element.text.strip()


def scan_choice_fields(driver, platform_key: str) -> list[dict]:
    """
    Stage 1b: find radio-button groups, checkbox groups, and dropdowns inside
    each question block. Separate from scan_form() (which only handles free-text
    inputs) because choice fields need their available options collected up
    front — there's nothing to "type", only an option to select.
    """
    platform_configuration = platform_configs.get_config(platform_key)
    question_selector = platform_configuration.get("question_selector")
    if not question_selector:
        return []  # platform has no per-question structure defined yet — nothing to scope choice detection to

    question_blocks = driver.find_elements(By.CSS_SELECTOR, question_selector)
    choice_groups = []

    for question_block in question_blocks:
        # Each question_block is wrapped in its own try/except: Google Forms can
        # re-render parts of the DOM in reaction to the text fields we just
        # filled (validation state, conditional-field reveals, etc.), which
        # invalidates ("stales") element references fetched before that
        # re-render. One stale question shouldn't crash the whole scan — we
        # just skip it and move on to the next, same as any other detection
        # miss (a fully-stale form would just come back with fewer groups).
        try:
            title_selector = platform_configuration.get("question_title_selector")
            question_title = ""
            if title_selector:
                try:
                    question_title = question_block.find_element(By.CSS_SELECTOR, title_selector).text.strip()
                except NoSuchElementException:
                    pass

            for field_type, selector_key in (("radio", "radio_selector"), ("checkbox", "checkbox_selector")):
                selector = platform_configuration.get(selector_key)
                if not selector:
                    continue
                option_elements = [element for element in question_block.find_elements(By.CSS_SELECTOR, selector) if element.is_displayed()]
                if not option_elements:
                    continue
                option_texts = [_option_text_for(element) for element in option_elements]
                choice_groups.append({
                    "field_type": field_type,
                    "label": question_title,
                    "options": list(zip(option_texts, option_elements)),
                    "is_legal_consent": _is_legal_consent_group(question_title, option_texts),
                })

            select_selector = platform_configuration.get("select_selector")
            if select_selector:
                dropdown_elements = [element for element in question_block.find_elements(By.CSS_SELECTOR, select_selector) if element.is_displayed()]
                for dropdown_element in dropdown_elements:
                    choice_groups.append({
                        "field_type": "dropdown",
                        "label": question_title,
                        "dropdown_trigger": dropdown_element,
                        "is_legal_consent": _is_legal_consent_group(question_title, []),
                    })
        except StaleElementReferenceException:
            continue

    return choice_groups


def _select_matching_option(option_pairs: list[tuple], target_value: str) -> tuple | None:
    """Fuzzy-matches a profile value (e.g. 'Yes') against a list of (text, element)
    option pairs and returns the best pair if it clears CHOICE_MATCH_MIN_CONFIDENCE."""
    target_lower = str(target_value).lower()
    best_pair, best_score = None, 0.0
    for option_text, option_element in option_pairs:
        score = SequenceMatcher(None, option_text.lower(), target_lower).ratio()
        if target_lower in option_text.lower() or option_text.lower() in target_lower:
            score = max(score, 0.9)
        if score > best_score:
            best_pair, best_score = (option_text, option_element), score
    if best_pair and best_score >= Config.CHOICE_MATCH_MIN_CONFIDENCE:
        return best_pair
    return None


def fill_choice_fields(choice_groups: list[dict], profile: dict) -> dict:
    """
    Stage 2b: select radio/checkbox options and open+pick dropdown options
    where a confident profile match exists. Legal-consent groups are always
    routed to `skipped` regardless of any match — see _is_legal_consent_group.
    """
    filled, skipped = [], []

    for group in choice_groups:
        if group["is_legal_consent"]:
            skipped.append({
                "label": group["label"],
                "reason": "requires_manual_review_legal_consent",
            })
            continue

        profile_key, confidence = _best_profile_match(group["label"])
        profile_value = profile.get(profile_key)
        if confidence < Config.CHOICE_MATCH_MIN_CONFIDENCE or profile_key == "unknown" or not profile_value:
            skipped.append({
                "label": group["label"],
                "reason": "profile_value_missing" if profile_key != "unknown" and confidence >= Config.CHOICE_MATCH_MIN_CONFIDENCE
                          else "low_confidence_or_unmapped",
            })
            continue

        try:
            if group["field_type"] in ("radio", "checkbox"):
                match = _select_matching_option(group["options"], profile_value)
                if not match:
                    skipped.append({"label": group["label"], "reason": "no_option_matched_profile_value"})
                    continue
                match[1].click()
                filled.append({"label": group["label"], "profile_key": profile_key, "selected_option": match[0]})

            elif group["field_type"] == "dropdown":
                group["dropdown_trigger"].click()  # opens the options panel
                time.sleep(0.4)  # let the options panel render before we search for options
                open_options = group["dropdown_trigger"].parent.find_elements(By.CSS_SELECTOR, "[role='option']")
                option_pairs = [(_option_text_for(element), element) for element in open_options if element.is_displayed()]
                match = _select_matching_option(option_pairs, profile_value)
                if not match:
                    group["dropdown_trigger"].click()  # close the panel again rather than leaving it open
                    skipped.append({"label": group["label"], "reason": "no_option_matched_profile_value"})
                    continue
                match[1].click()
                filled.append({"label": group["label"], "profile_key": profile_key, "selected_option": match[0]})
        except WebDriverException as exc:
            skipped.append({"label": group["label"], "reason": f"injection_failed: {exc}"})

    return {"filled": filled, "skipped": skipped}


def fill_fields(fields: list[dict], profile: dict, min_confidence: float = 0.75) -> dict:
    """
    Stage 2: inject values for fields with a confident profile match; leave
    low-confidence/unmapped fields untouched and reported back for review,
    mirroring the "requires_review" behaviour from the proposal's Mistral
    integration section — here driven by the local heuristic instead.
    """
    filled, skipped = [], []
    for field in fields:
        if field["confidence"] < min_confidence or field["profile_key"] == "unknown":
            skipped.append({"label": field["label"], "reason": "low_confidence_or_unmapped",
                             "confidence": field["confidence"]})
            continue

        value = profile.get(field["profile_key"])
        if not value:
            skipped.append({"label": field["label"], "reason": "profile_value_missing"})
            continue

        try:
            field["element"].clear()
            _human_type(field["element"], str(value))
            filled.append({"label": field["label"], "profile_key": field["profile_key"],
                            "confidence": field["confidence"]})
        except WebDriverException as exc:
            skipped.append({"label": field["label"], "reason": f"injection_failed: {exc}"})

    return {"filled": filled, "skipped": skipped}


# Registry of open browser sessions, keyed by a driver_id. Without this, the
# `driver` object returned by build_driver() had no reference left after
# run_fill() returned, so Python's garbage collector would eventually clean it
# up — which tears down the chromedriver subprocess and silently closes the
# Chrome window a short while after the API response was already sent. Keeping
# a strong reference here is what makes the window stay open for manual
# review/submission as intended.
# TC: O(1) average insert/lookup/delete per driver_id | SC: O(n) for n open sessions
_open_drivers: dict[str, webdriver.Chrome] = {}


def close_driver(driver_id: str) -> bool:
    """Closes and forgets a previously opened browser session. Returns False if unknown."""
    driver = _open_drivers.pop(driver_id, None)
    if driver is None:
        return False
    try:
        driver.quit()
    except WebDriverException:
        pass
    return True


def run_fill(url: str, profile: dict) -> dict:
    """
    End-to-end orchestration used by the /api/fill-form route:
    open page -> platform detect -> human-intervention checks -> scan -> fill.
    Returns everything the frontend/video narration needs, including latency.
    """
    start = time.time()
    platform_key = platform_configs.detect_platform(url)
    if platform_key is None:
        return {"success": False, "error": f"Unsupported platform for URL: {url}"}

    driver = build_driver()
    driver_id = str(uuid.uuid4())  # lets the caller close this exact browser session later via /api/close-session
    _open_drivers[driver_id] = driver  # keep a strong reference so GC doesn't silently close the window
    events = []
    try:
        driver.get(url)
        events.extend(run_all_checks(driver))
        if events:
            # A human-intervention event stops the auto-fill; the caller decides
            # whether to resume once the user has cleared the CAPTCHA/login step.
            return {
                "success": False,
                "platform": platform_key,
                "driver_id": driver_id,
                "events": events,
                "duration_ms": int((time.time() - start) * 1000),
            }

        fields = scan_form(driver, platform_key)
        text_result = fill_fields(fields, profile)

        # Filling text fields can trigger Google Forms to re-render parts of the
        # DOM (validation state, conditional-field reveals) — pausing briefly
        # here, on top of the stale-element handling inside scan_choice_fields,
        # reduces how often that re-render lands mid-scan in the first place.
        time.sleep(Config.DOM_STABILIZE_WAIT_SECONDS)

        choice_groups = scan_choice_fields(driver, platform_key)
        choice_result = fill_choice_fields(choice_groups, profile)

        # Re-check after filling in case a CAPTCHA appears post-interaction
        events.extend(run_all_checks(driver))

        return {
            "success": True,
            "platform": platform_key,
            "driver_id": driver_id,
            "fields_detected": len(fields) + len(choice_groups),
            "filled": text_result["filled"] + choice_result["filled"],
            "skipped": text_result["skipped"] + choice_result["skipped"],
            "events": events,
            "duration_ms": int((time.time() - start) * 1000),
        }
    finally:
        # Deliberately not calling driver.quit() here — the brief wants the user
        # to see + manually submit the filled form, same as the extension's
        # "never auto-submit" rule in the proposal. The window is kept alive via
        # _open_drivers above; call close_driver(driver_id) — wired to
        # /api/close-session in app.py — once the user is done with it.
        pass


# Edge Cases Handled (SOP 3.5):
# 1. Unsupported platform URL -> detect_platform() returns None; run_fill()
#    short-circuits with success=False before ever opening a browser.
# 2. CAPTCHA or login wall present on initial load -> run_all_checks() fires
#    before scan_form() is called at all, so no fields are touched.
# 3. Form container never appears within FORM_SCAN_TIMEOUT_SECONDS ->
#    scan_form() returns an empty field list rather than raising.
# 4. Field label can't be matched to any known profile key -> confidence stays
#    low/0, field goes to "skipped" with reason low_confidence_or_unmapped
#    instead of guessing.
# 5. Matched profile key exists but the profile value is empty/None -> skipped
#    with reason profile_value_missing rather than injecting a blank string.
# 6. A single field's DOM injection throws (stale element, read-only field,
#    etc.) -> caught per-field so one bad field doesn't abort the whole run.
# 7. CAPTCHA appears only after interacting with the form (not on initial
#    load) -> run_all_checks() is called a second time after fill_fields().
# 8. Radio/checkbox/dropdown group looks like a legal/consent question ("I
#    agree to the Terms") -> ALWAYS routed to skipped with reason
#    requires_manual_review_legal_consent, regardless of confidence — see
#    _is_legal_consent_group. This is a hard rule, not a scored decision.
# 9. Dropdown option panel doesn't contain a matching option -> the dropdown
#    is clicked again to close it before moving on, so the form isn't left
#    with a stray open panel covering other fields.
# 10. A choice group's label matches a known profile key but the profile has
#     no value for it -> skipped with profile_value_missing, same convention
#     as text fields, rather than picking an arbitrary option.
# 11. Google Forms re-renders part of the DOM after text fields are filled
#     (validation state, conditional-field reveals), which can make an
#     already-fetched question_block go stale mid-scan. **Found during
#     checkpoint testing** as an unhandled 500 error. Fixed with a
#     DOM_STABILIZE_WAIT_SECONDS pause before scanning choice fields, plus a
#     try/except StaleElementReferenceException around each question block so
#     one stale block is skipped instead of crashing the whole fill run.
