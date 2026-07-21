"""
Hardcoded OCR wrapper, per the brief's tech stack instructions ("For OCR: hardcode
a solution — search GitHub for available models"). This uses pytesseract (a
Python wrapper around the open-source Tesseract OCR engine — no paid API, no
training required, works fully offline).

IMPORTANT: This is used only to help *detect* CAPTCHA-like images and to read
plain on-page text that isn't in the DOM (e.g. text baked into an image). It is
never used to read or solve a CAPTCHA's challenge text — see captcha_detector.py
for why that line is not crossed.
"""
import io
from config import Config

try:
    import pytesseract
    from PIL import Image
    if Config.TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = Config.TESSERACT_CMD
    _OCR_AVAILABLE = True
except ImportError:
    _OCR_AVAILABLE = False


def is_available() -> bool:
    return _OCR_AVAILABLE and Config.OCR_ENABLED


def extract_text_from_png_bytes(png_bytes: bytes) -> str:
    """
    Run OCR over a screenshot/element image and return whatever text Tesseract
    finds. Returns '' if OCR isn't installed/enabled rather than raising, so a
    missing OCR dependency degrades gracefully instead of crashing a fill run.
    """
    if not is_available():
        return ""
    try:
        image = Image.open(io.BytesIO(png_bytes))
        return pytesseract.image_to_string(image).strip()
    except Exception:
        return ""


def looks_like_captcha_image(png_bytes: bytes) -> bool:
    """
    Cheap heuristic: distorted CAPTCHA challenge text usually OCRs to garbage
    (very short, mostly non-dictionary strings) or to nothing at all, while
    normal UI screenshots OCR to readable sentences/labels. Combined with the
    DOM/keyword checks in captcha_detector.py, this is only a secondary signal.
    """
    text = extract_text_from_png_bytes(png_bytes)
    if text == "":
        return True  # no readable text at all is itself a signal on a flagged element
    alpha_chars = [c for c in text if c.isalpha()]
    return len(alpha_chars) > 0 and len(alpha_chars) < 6
