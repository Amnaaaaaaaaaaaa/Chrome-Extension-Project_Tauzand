"""
Central configuration. Every tunable value used by the automation lives here so
nothing is hardcoded inside the actual logic files. Values are pulled from
environment variables with sane local-dev defaults.
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # --- Supabase ---
    SUPABASE_URL = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
    SUPABASE_PROFILES_TABLE = os.getenv("SUPABASE_PROFILES_TABLE", "profiles")
    SUPABASE_RUNS_TABLE = os.getenv("SUPABASE_RUNS_TABLE", "fill_runs")

    # --- Selenium / browser ---
    SELENIUM_HEADLESS = os.getenv("SELENIUM_HEADLESS", "false").lower() == "true"
    SELENIUM_IMPLICIT_WAIT_SECONDS = float(os.getenv("SELENIUM_IMPLICIT_WAIT_SECONDS", "2"))
    SELENIUM_PAGE_LOAD_TIMEOUT_SECONDS = float(os.getenv("SELENIUM_PAGE_LOAD_TIMEOUT_SECONDS", "20"))
    FIELD_TYPE_DELAY_MS = (int(os.getenv("FIELD_TYPE_DELAY_MIN_MS", "40")),
                            int(os.getenv("FIELD_TYPE_DELAY_MAX_MS", "120")))
    DOM_STABILIZE_WAIT_SECONDS = float(os.getenv("DOM_STABILIZE_WAIT_SECONDS", "1.5"))
    FORM_SCAN_TIMEOUT_SECONDS = float(os.getenv("FORM_SCAN_TIMEOUT_SECONDS", "15"))

    # --- CAPTCHA / human-intervention detection ---
    CAPTCHA_KEYWORDS = os.getenv(
        "CAPTCHA_KEYWORDS",
        "captcha,recaptcha,hcaptcha,not a robot,verify you are human,security check"
    ).split(",")
    LOGIN_KEYWORDS = os.getenv(
        "LOGIN_KEYWORDS",
        # Deliberately specific phrases only. A bare "sign in" false-positives on
        # Google Forms, which always shows an optional account-switch link even
        # when the form itself needs no login — discovered during checkpoint
        # testing. Password-field detection (see captcha_detector.py) is the
        # primary, more reliable signal; these keywords are a secondary backstop.
        "you must sign in,sign in to continue,sign in to submit this form,"
        "this form requires you to sign in,please log in to continue,"
        "your response could not be submitted"
    ).split(",")

    # --- Multiple-choice / checkbox / dropdown handling ---
    CHOICE_MATCH_MIN_CONFIDENCE = float(os.getenv("CHOICE_MATCH_MIN_CONFIDENCE", "0.7"))  # minimum similarity to auto-select an option
    # Legal/consent checkboxes ("I agree to the Terms", privacy policy consent,
    # etc.) are NEVER auto-checked, no matter how confident the label match is —
    # checking a real consent box on someone's behalf isn't the same kind of
    # action as filling in their name, since it represents them actually
    # agreeing to something. These are always left for the person to tick
    # themselves; see form_filler.classify_and_fill_choice_field.
    LEGAL_CHECKBOX_KEYWORDS = os.getenv(
        "LEGAL_CHECKBOX_KEYWORDS",
        "i agree,terms and conditions,terms of service,privacy policy,consent,"
        "i accept,i acknowledge,i certify,i confirm that,gdpr,i authorize"
    ).split(",")

    # --- Mistral API (job description analysis) ---
    MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "")
    MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "mistral-small-latest")  # small model is enough for keyword extraction; keeps cost down
    MISTRAL_API_URL = os.getenv("MISTRAL_API_URL", "https://api.mistral.ai/v1/chat/completions")
    MISTRAL_ENABLED = os.getenv("MISTRAL_ENABLED", "true").lower() == "true"
    # Cost-optimization: extracted keywords for a given job description are
    # cached in Supabase (job_description_keywords table) keyed by a hash of
    # the description text, so the same JD never triggers a second Mistral
    # call — this is the "store and reuse relevant keywords" approach.
    JD_KEYWORD_CACHE_ENABLED = os.getenv("JD_KEYWORD_CACHE_ENABLED", "true").lower() == "true"

    # --- Resume storage ---
    RESUME_MAX_SIZE_MB = int(os.getenv("RESUME_MAX_SIZE_MB", "8"))
    RESUME_ALLOWED_EXTENSIONS = os.getenv("RESUME_ALLOWED_EXTENSIONS", "pdf,doc,docx").split(",")

    # --- Audio alert ---
    AUDIO_ALERT_ENABLED = os.getenv("AUDIO_ALERT_ENABLED", "true").lower() == "true"
    AUDIO_ALERT_REPEAT_COUNT = int(os.getenv("AUDIO_ALERT_REPEAT_COUNT", "2"))

    # --- OCR ---
    OCR_ENABLED = os.getenv("OCR_ENABLED", "true").lower() == "true"
    TESSERACT_CMD = os.getenv("TESSERACT_CMD", "")  # optional override, e.g. Windows path

    # --- Flask ---
    FLASK_ENV = os.getenv("FLASK_ENV", "development")
    FLASK_PORT = int(os.getenv("FLASK_PORT", "5000"))
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
