"""
Per-platform configuration. Adding support for a new site means adding an entry
here — form_filler.py never needs a code change for a new platform, which is
the "editable / future-proof" requirement from the brief.

Each entry describes how to find the form container and how form questions are
structured on that platform, in generic-enough terms that the shared
field-detection logic in form_filler.py can consume it.
"""

PLATFORM_CONFIGS = {
    "google_forms": {
        "match_domains": ["docs.google.com"],
        "match_path_contains": "/forms/",
        "form_container_selector": "form",
        # Google Forms wraps each question in a div with role="listitem"
        "question_selector": "div[role='listitem']",
        "question_title_selector": "[role='heading']",
        "text_input_selector": "input[type='text'], textarea",
        "radio_selector": "div[role='radio']",
        "checkbox_selector": "div[role='checkbox']",
        "select_selector": "div[role='listbox']",
        "submit_button_text": ["Submit"],
        "notes": "No auth wall by default; ideal reference target for the demo video.",
    },
    "workday": {
        "match_domains": ["myworkdayjobs.com", "workday.com"],
        "match_path_contains": None,
        "form_container_selector": "[data-automation-id='jobApplication']",
        "question_selector": "[data-automation-id*='formField']",
        "question_title_selector": "label",
        "text_input_selector": "input[type='text'], input[type='email'], input[type='tel'], textarea",
        "radio_selector": "input[type='radio']",
        "checkbox_selector": "input[type='checkbox']",
        "select_selector": "[data-automation-id='selectWidget']",
        "submit_button_text": ["Next", "Submit", "Review"],
        "notes": (
            "Requires login (auth wall) and is multi-step. Not used for the checkpoint "
            "video; wired up here so Phase 2 is a config change, not a rewrite."
        ),
    },
    "linkedin_easy_apply": {
        "match_domains": ["linkedin.com"],
        "match_path_contains": "/jobs/",
        "form_container_selector": "div.jobs-easy-apply-content",
        "question_selector": "div.fb-dash-form-element",
        "question_title_selector": "label",
        "text_input_selector": "input[type='text'], textarea",
        "radio_selector": "input[type='radio']",
        "checkbox_selector": "input[type='checkbox']",
        "select_selector": "select",
        "submit_button_text": ["Submit application", "Review", "Next"],
        "notes": "Requires LinkedIn auth; extension cannot automate the OAuth step itself.",
    },
    "captcha_detection_test": {
        "match_domains": ["google.com"],
        "match_path_contains": "/recaptcha/api2/demo",
        "form_container_selector": "body",
        "question_selector": None,
        "question_title_selector": None,
        "text_input_selector": "input[type='text']",
        "radio_selector": None,
        "checkbox_selector": None,
        "select_selector": None,
        "submit_button_text": ["Submit"],
        "notes": (
            "Not a real target platform. This is Google's own public reCAPTCHA "
            "demo page (https://www.google.com/recaptcha/api2/demo) — used only "
            "to genuinely trigger and demonstrate the CAPTCHA-detection + audio "
            "alert path for the checkpoint video, since real job platforms don't "
            "reliably show a CAPTCHA on every visit."
        ),
    },
}


def detect_platform(url: str) -> str | None:
    """Return the platform key that matches this URL, or None if unsupported."""
    for platform_key, platform_configuration in PLATFORM_CONFIGS.items():
        for domain in platform_configuration["match_domains"]:
            if domain in url:
                if platform_configuration["match_path_contains"] is None or platform_configuration["match_path_contains"] in url:
                    return platform_key
    return None


def get_config(platform_key: str) -> dict:
    if platform_key not in PLATFORM_CONFIGS:
        raise KeyError(f"No config for platform '{platform_key}'")
    return PLATFORM_CONFIGS[platform_key]
