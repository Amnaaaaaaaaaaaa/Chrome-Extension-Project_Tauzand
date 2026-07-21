"""
Detects — but never attempts to bypass — CAPTCHAs, "I'm not a robot" checks,
and login walls. On a hit, this hands off to audio_alert so a human can step
in. This mirrors Edge Case 3 in the proposal: automatic bypass is out of scope
by design (platform ToS + technical infeasibility), so this module's whole job
is fast, reliable detection, not evasion.

Detection is layered:
  1. DOM/selector signals (cheap, fast, most reliable)
  2. Visible-text keyword scan (catches custom/non-standard widgets)
  3. OCR fallback on a screenshot of a flagged element (catches canvas/image-only
     challenges that have no usable DOM text)
"""
from selenium.webdriver.common.by import By
from selenium.common.exceptions import NoSuchElementException, WebDriverException

from config import Config
from services import ocr_service
from services.audio_alert import alert_human_intervention_needed

_CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "div.g-recaptcha",
    "#captcha",
    "[class*='captcha']",
    "[id*='captcha']",
]

_LOGIN_SELECTORS = [
    "input[type='password']",
    "button[data-automation-id='signInLink']",
]


def _page_text_lower(driver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, "body").text.lower()
    except (NoSuchElementException, WebDriverException):
        return ""


def check_for_captcha(driver) -> dict | None:
    """Returns an alert event dict if a CAPTCHA is detected, else None."""
    for selector in _CAPTCHA_SELECTORS:
        elements = driver.find_elements(By.CSS_SELECTOR, selector)
        if elements:
            return alert_human_intervention_needed(
                f"CAPTCHA widget detected via selector '{selector}'"
            )

    page_text = _page_text_lower(driver)
    for keyword in Config.CAPTCHA_KEYWORDS:
        if keyword.strip() and keyword.strip() in page_text:
            return alert_human_intervention_needed(
                f"CAPTCHA-related text detected on page: '{keyword.strip()}'"
            )

    # OCR fallback: only run if something visually CAPTCHA-shaped exists but
    # produced no DOM/text signal above (e.g. a canvas-rendered challenge).
    if ocr_service.is_available():
        canvas_elements = driver.find_elements(By.TAG_NAME, "canvas")
        for element in canvas_elements:
            try:
                png = element.screenshot_as_png
                if ocr_service.looks_like_captcha_image(png):
                    return alert_human_intervention_needed(
                        "Canvas element flagged as a likely CAPTCHA by OCR heuristic"
                    )
            except WebDriverException:
                continue

    return None


def check_for_login_wall(driver) -> dict | None:
    """
    Returns an alert event dict if the page appears to require login, else None.

    Password-field presence is the primary signal (a real auth wall always has
    one). The keyword scan is a narrow backstop for auth walls that don't use a
    password field (e.g. SSO/redirect-based flows) — it deliberately uses
    specific phrases like "sign in to continue" rather than a bare "sign in",
    because Google Forms shows an optional, harmless account-switch link on
    every page and a broad keyword match false-positived on it during testing.
    """
    for selector in _LOGIN_SELECTORS:
        if driver.find_elements(By.CSS_SELECTOR, selector):
            return alert_human_intervention_needed(
                f"Login/auth field detected via selector '{selector}' — manual sign-in required"
            )

    page_text = _page_text_lower(driver)
    for keyword in Config.LOGIN_KEYWORDS:
        if keyword.strip() and keyword.strip() in page_text:
            return alert_human_intervention_needed(
                f"Login-related text detected on page: '{keyword.strip()}'"
            )
    return None


def run_all_checks(driver) -> list[dict]:
    """Runs every human-intervention check once and returns all events fired."""
    events = []
    for check in (check_for_captcha, check_for_login_wall):
        event = check(driver)
        if event:
            events.append(event)
    return events
