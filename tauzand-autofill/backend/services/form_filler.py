"""
The actual auto-fill engine. Logic is deliberately split into small, named
functions (scan -> match -> fill) rather than one long procedure, so each stage
can be tested, replaced, or extended independently — e.g. swapping the
label-matching heuristic for a real NLP/LLM call later is a one-function change.

This talks to platform_configs.py for "where things are on this site" and to
captcha_detector.py for "should I stop and ask a human right now".
"""
import random
import re
import time
import uuid
from difflib import SequenceMatcher
from typing import Any

try:
    from selenium import webdriver  # type: ignore[import]
    from selenium.webdriver.chrome.options import Options  # type: ignore[import]
    from selenium.webdriver.common.by import By  # type: ignore[import]
    from selenium.webdriver.support.ui import WebDriverWait  # type: ignore[import]
    from selenium.webdriver.support import expected_conditions as EC  # type: ignore[import]
    from selenium.common.exceptions import (  # type: ignore[import]
        TimeoutException, NoSuchElementException, WebDriverException, StaleElementReferenceException,
    )
except Exception:  # pragma: no cover - allow tooling/linting environments without selenium installed
    # Provide light-weight fallbacks so static analysis / editors don't error
    webdriver = None

    class Options:  # type: ignore
        pass

    class By:  # type: ignore
        ID = "id"
        XPATH = "xpath"
        CSS_SELECTOR = "css selector"

    class WebDriverWait:  # type: ignore
        def __init__(self, *args, **kwargs):
            pass

        def until(self, *args, **kwargs):
            raise RuntimeError("selenium not available")

    class EC:  # type: ignore
        @staticmethod
        def presence_of_element_located(*args, **kwargs):
            return None
    # Provide exception names so code referencing them doesn't break when selenium
    # isn't installed (e.g. in static analysis / linting environments).
    TimeoutException = Exception
    NoSuchElementException = Exception
    WebDriverException = Exception
    StaleElementReferenceException = Exception
    # Minimal exception stubs so static analysis and runtime fallback work
    class TimeoutException(Exception):
        pass

    class NoSuchElementException(Exception):
        pass

    class WebDriverException(Exception):
        pass

    class StaleElementReferenceException(Exception):
        pass

    # Lightweight fallback exception classes so imports like
    # `from selenium.common.exceptions import TimeoutException` still work
    class TimeoutException(Exception):
        pass

    class NoSuchElementException(Exception):
        pass

    class WebDriverException(Exception):
        pass

    class StaleElementReferenceException(Exception):
        pass

from config import Config
from services import platform_configs
from services.captcha_detector import run_all_checks
from services.audio_alert import alert_human_intervention_needed


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
    "referral_source": ["how did you hear", "referral source", "how did you find", "how did you learn about"],
    "preferred_work_location": ["preferred work location", "work location", "work arrangement", "remote or on-site"],
    "skills": ["which skills", "select your skills", "skills do you have", "technical skills"],
}


def build_driver() -> Any:
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

        # Skip text-field detection entirely for radio/checkbox questions.
        # Google Forms renders an "Other, please specify" option as a real
        # <input type="text"> sitting inside the same question block as the
        # radio/checkbox options — scan_form's text_input_selector was
        # matching that box, tagging it with the question's title as its
        # label, and fill_fields was typing the matched profile value straight
        # into the Other box (which also auto-selects "Other"), instead of
        # letting scan_and_fill_choice_fields click the actual correct option. Found
        # during checkpoint testing: "How did you hear..." ended up answered
        # via "Other: Social Media" instead of the "Social Media" radio button.
        radio_selector = platform_configuration.get("radio_selector")
        checkbox_selector = platform_configuration.get("checkbox_selector")
        is_choice_question = (
            (radio_selector and question_block.find_elements(By.CSS_SELECTOR, radio_selector))
            or (checkbox_selector and question_block.find_elements(By.CSS_SELECTOR, checkbox_selector))
        )
        if is_choice_question:
            continue

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


def _select_matching_option(option_pairs: list[tuple[str, object]], target_value, min_ratio: float = 0.55):
    """
    Given a list of (option_display_text, option_element) pairs scraped from
    a radio/checkbox/dropdown group, find the pair whose visible text best
    matches target_value (a profile value like "Remote", "Python", "Female").
    Returns the best (text, element) pair, or None if nothing clears
    min_ratio — callers treat None as "no option matched profile value" and
    skip the question rather than guessing/clicking the wrong option.

    Was previously called from scan_and_fill_choice_fields but never
    defined anywhere in this file — every radio/checkbox/dropdown question
    that actually reached this call raised NameError, which isn't caught by
    the StaleElementReferenceException/WebDriverException handlers around
    it, so it either aborted the whole choice-field pass or surfaced as an
    unrelated-looking error further down. This is why radio buttons,
    checkboxes, and multiple-choice/dropdown questions were never getting
    filled. Uses the same SequenceMatcher + substring-coverage-bonus
    approach as _best_profile_match for consistency with the rest of the
    matching logic in this file.
    """
    if target_value is None:
        return None
    target_lower = str(target_value).strip().lower()
    if not target_lower:
        return None

    best_pair, best_score = None, 0.0
    for option_text, option_element in option_pairs:
        option_lower = option_text.strip().lower()
        if not option_lower:
            continue
        score = SequenceMatcher(None, option_lower, target_lower).ratio()
        if option_lower in target_lower or target_lower in option_lower:
            shorter_len = min(len(option_lower), len(target_lower))
            longer_len = max(len(option_lower), len(target_lower), 1)
            coverage_bonus = 0.25 * (shorter_len / longer_len)
            score = max(score, 0.70 + coverage_bonus)
        if score > best_score:
            best_pair, best_score = (option_text, option_element), score

    return best_pair if best_score >= min_ratio else None


def scan_and_fill_choice_fields(driver, platform_key: str, profile: dict) -> dict:
    """
    Combined scan+select pass for radio/checkbox/dropdown groups, one question
    at a time. Earlier versions scanned every choice question into a list
    first, then clicked them all in a separate pass afterward — the gap
    between "found this element" and "actually clicked it" was long enough
    for Google Forms' own re-rendering to invalidate the reference, so clicks
    were failing with StaleElementReferenceException even though the group
    had been detected correctly in the scan. Found during checkpoint testing.
    Deciding and clicking immediately after finding each question, one at a
    time, keeps that gap down to milliseconds instead of an entire extra pass.
    """
    platform_configuration = platform_configs.get_config(platform_key)
    question_selector = platform_configuration.get("question_selector")
    filled, skipped = [], []
    if not question_selector:
        return {"filled": filled, "skipped": skipped}

    total_question_blocks = len(driver.find_elements(By.CSS_SELECTOR, question_selector))

    for block_index in range(total_question_blocks):
        question_title = ""  # defined before the try block so exception handlers always have a safe value to report
        try:
            # Fresh fetch by index right before use — same reasoning as the
            # text-field stale-element fix: never hold a reference across
            # anything that might trigger a DOM re-render.
            current_question_blocks = driver.find_elements(By.CSS_SELECTOR, question_selector)
            if block_index >= len(current_question_blocks):
                break
            question_block = current_question_blocks[block_index]

            title_selector = platform_configuration.get("question_title_selector")
            if title_selector:
                try:
                    question_title = question_block.find_element(By.CSS_SELECTOR, title_selector).text.strip()
                except NoSuchElementException:
                    pass

            # Google Forms also tags some non-question elements (nested
            # option wrappers, the "* Indicates required question" note,
            # section-description blocks) with role='listitem'. A real
            # question on this platform always has a heading title, so a
            # blank title here means this block isn't an actual question —
            # skip it before it gets scanned as a choice field. This is what
            # was showing up as duplicate blank-label "low_confidence_or_unmapped"
            # / "requires_manual_review_legal_consent" entries alongside the
            # real ones. Found during checkpoint testing.
            if title_selector and not question_title:
                continue

            radio_selector = platform_configuration.get("radio_selector")
            checkbox_selector = platform_configuration.get("checkbox_selector")
            select_selector = platform_configuration.get("select_selector")

            radio_options = [el for el in question_block.find_elements(By.CSS_SELECTOR, radio_selector) if el.is_displayed()] if radio_selector else []
            checkbox_options = [el for el in question_block.find_elements(By.CSS_SELECTOR, checkbox_selector) if el.is_displayed()] if checkbox_selector else []
            dropdown_triggers = [el for el in question_block.find_elements(By.CSS_SELECTOR, select_selector) if el.is_displayed()] if select_selector else []

            if not radio_options and not checkbox_options and not dropdown_triggers:
                continue  # not a choice question — scan_form already handled any real text field here

            all_option_texts = [_option_text_for(el) for el in (radio_options + checkbox_options)]
            if _is_legal_consent_group(question_title, all_option_texts):
                skipped.append({"label": question_title, "reason": "requires_manual_review_legal_consent"})
                # Same "please look at this yourself" moment as a CAPTCHA/login
                # wall — the alert fires so the user notices and ticks it
                # themselves instead of the skip happening silently.
                alert_human_intervention_needed(f"Legal/consent checkbox requires manual review: {question_title}")
                continue

            profile_key, confidence = _best_profile_match(question_title)
            profile_value = profile.get(profile_key)
            if confidence < Config.CHOICE_MATCH_MIN_CONFIDENCE or profile_key == "unknown" or not profile_value:
                skipped.append({
                    "label": question_title,
                    "reason": "profile_value_missing" if profile_key != "unknown" and confidence >= Config.CHOICE_MATCH_MIN_CONFIDENCE
                              else "low_confidence_or_unmapped",
                })
                continue

            # The "skills" column (and similar fields) in Supabase is stored
            # as plain text, e.g. "JavaScript, TypeScript, Python, React,
            # Flask" — not a Postgres array. Without this, isinstance(...,
            # list) was False, so a checkbox group fell through to the
            # single-match branch below and matched the whole string against
            # each option, which only ever selects the one option that
            # happens to score highest (e.g. just "JavaScript") and ignores
            # the rest. Split it into a real list first so every skill gets
            # its own checkbox click.
            if checkbox_options and isinstance(profile_value, str) and re.search(r"[,;]", profile_value):
                profile_value = [item.strip() for item in re.split(r"[,;]", profile_value) if item.strip()]

            if checkbox_options and isinstance(profile_value, list):
                # Multi-select: every list item that matches an available
                # option gets its own checkbox clicked, not just one.
                #
                # Bug fixed after checkpoint testing: checkbox_options was
                # captured once before this loop, then reused across every
                # click. Clicking one checkbox can make Google Forms
                # re-render the question block (aria-checked state update),
                # which invalidates the remaining element references — so a
                # multi-select like "skills" would click the first matching
                # item fine, then throw StaleElementReferenceException on the
                # second and lose every item after that, including the one
                # already clicked being reported as if the whole question
                # failed. Fixed by catching the stale reference per-item and
                # re-fetching fresh checkbox elements just for that retry,
                # instead of letting it escape to the outer per-question
                # except block.
                option_pairs = list(zip((_option_text_for(el) for el in checkbox_options), checkbox_options))
                selected_any = False
                for value_item in profile_value:
                    match = _select_matching_option(option_pairs, value_item)
                    if not match:
                        continue
                    try:
                        match[1].click()
                        selected_any = True
                        filled.append({"label": question_title, "profile_key": profile_key, "selected_option": match[0], "confidence": round(confidence, 2)})
                    except StaleElementReferenceException:
                        fresh_checkboxes = [el for el in question_block.find_elements(By.CSS_SELECTOR, checkbox_selector) if el.is_displayed()]
                        fresh_pairs = list(zip((_option_text_for(el) for el in fresh_checkboxes), fresh_checkboxes))
                        retry = _select_matching_option(fresh_pairs, value_item)
                        if retry:
                            try:
                                retry[1].click()
                                selected_any = True
                                filled.append({"label": question_title, "profile_key": profile_key, "selected_option": retry[0], "confidence": round(confidence, 2)})
                            except StaleElementReferenceException:
                                pass  # give up on this one item only; the rest of the loop still continues
                if not selected_any:
                    skipped.append({"label": question_title, "reason": "no_option_matched_profile_value"})

            elif radio_options or checkbox_options:
                option_pairs = list(zip((_option_text_for(el) for el in (radio_options + checkbox_options)), radio_options + checkbox_options))
                match = _select_matching_option(option_pairs, profile_value)
                if not match:
                    skipped.append({"label": question_title, "reason": "no_option_matched_profile_value"})
                else:
                    match[1].click()
                    filled.append({"label": question_title, "profile_key": profile_key, "selected_option": match[0], "confidence": round(confidence, 2)})

            elif dropdown_triggers:
                dropdown_element = dropdown_triggers[0]
                dropdown_element.click()  # opens the options panel
                time.sleep(0.4)  # let the options panel render before we search for options
                open_options = dropdown_element.parent.find_elements(By.CSS_SELECTOR, "[role='option']")
                option_pairs = [(_option_text_for(el), el) for el in open_options if el.is_displayed()]
                match = _select_matching_option(option_pairs, profile_value)
                if not match:
                    dropdown_element.click()  # close the panel again rather than leaving it open
                    skipped.append({"label": question_title, "reason": "no_option_matched_profile_value"})
                else:
                    match[1].click()
                    filled.append({"label": question_title, "profile_key": profile_key, "selected_option": match[0], "confidence": round(confidence, 2)})

        except StaleElementReferenceException:
            skipped.append({"label": question_title, "reason": "stale_element_could_not_recover"})
            continue
        except WebDriverException as exc:
            skipped.append({"label": question_title, "reason": f"injection_failed: {exc}"})
            continue

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
_open_drivers: dict[str, Any] = {}


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
        # here reduces how often that re-render lands mid-scan for the choice
        # fields that come next.
        time.sleep(Config.DOM_STABILIZE_WAIT_SECONDS)

        choice_result = scan_and_fill_choice_fields(driver, platform_key, profile)

        # Re-check after filling in case a CAPTCHA appears post-interaction
        events.extend(run_all_checks(driver))

        return {
            "success": True,
            "platform": platform_key,
            "driver_id": driver_id,
            "fields_detected": len(fields) + len(choice_result["filled"]) + len(choice_result["skipped"]),
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
#     already-fetched question_block go stale mid-scan. Fixed with a
#     DOM_STABILIZE_WAIT_SECONDS pause before scanning choice fields, plus
#     re-fetching each question_block fresh right before use (by index) rather
#     than holding one list of references for the whole loop — questions later
#     in a longer form (checkbox, dropdown, legal-consent) were silently
#     vanishing from the scan entirely because of this, found during
#     checkpoint testing when they didn't appear in either filled or skipped.
# 12. Checkbox group backed by a list-valued profile field (e.g. skills) ->
#     every matching list item gets its own checkbox clicked, instead of only
#     selecting one option and leaving the rest unchecked.
# 13. A radio/checkbox question's "Other, please specify" free-text box is a
#     real <input type="text"> sitting inside the same question block. Found
#     during checkpoint testing: scan_form was treating that box as if it were
#     a genuine text-answer field (using the question's title as its label),
#     and typing the matched profile value straight into the Other box —
#     which also auto-selects "Other" — instead of leaving the question to
#     scan_and_fill_choice_fields to click the actual right option.
#     Fixed by having scan_form skip any question block that also contains
#     radio/checkbox option elements.
# 14. Legal/consent checkbox skip now fires the same audio alert used for
#     CAPTCHA/login-wall events, since it's the same kind of "please look at
#     this yourself" moment — previously it only appeared silently in the
#     skipped list with no notification.
# 15. Choice questions were being detected correctly (no longer vanishing)
#     but clicking the matched option still failed with
#     StaleElementReferenceException, because the old code scanned every
#     choice question into a list first and clicked them all in a separate
#     pass afterward — leaving a long enough gap for Google Forms to
#     re-render and invalidate the reference before the click happened.
#     Fixed by merging scan and select into one function
#     (scan_and_fill_choice_fields) that decides and clicks each question
#     immediately after finding it, one at a time, instead of two passes.
# 16. Multi-select checkbox groups (list-valued profile fields like "skills")
#     clicked the first matching option fine but silently lost every option
#     after it once Google Forms re-rendered the block on the first click,
#     invalidating the remaining cached checkbox element references. Fixed by
#     catching StaleElementReferenceException per-item inside the multi-select
#     loop and re-fetching fresh checkbox elements for just that retry, rather
#     than letting it escape to the outer per-question exception handler
#     (which would have marked the whole question skipped even though earlier
#     items had already been clicked successfully).
# 17. _select_matching_option was called from three places in
#     scan_and_fill_choice_fields but was never actually defined anywhere in
#     this file (or imported from elsewhere) — every radio/checkbox/dropdown
#     question that reached the point of trying to select an option raised
#     NameError, which the surrounding except clauses (scoped to
#     StaleElementReferenceException/WebDriverException) do not catch. This
#     was the root cause of radio buttons, checkboxes, and multiple-choice/
#     dropdown fields never being filled. Fixed by adding the function back
#     in, using the same fuzzy-match approach as _best_profile_match.