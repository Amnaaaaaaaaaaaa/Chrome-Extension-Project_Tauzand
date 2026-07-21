"""
Resume storage + selection. Per Chawala's email: resumes are user-uploaded
(never auto-generated), stored so the extension can pick the right one per
job description, with an alert firing once an upload completes.

Matching a resume to a job description reuses the keyword list from
mistral_client.py (already cached per job description) — so choosing the best
of, say, 3 saved resumes costs zero additional Mistral calls; it's a plain
keyword-overlap score against text we already extracted once.
"""
import base64
import binascii

from config import Config
from services import supabase_client
from services.audio_alert import alert_human_intervention_needed


class ResumeValidationError(ValueError):
    pass


def _validate_resume_upload(filename: str, file_size_bytes: int) -> None:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in Config.RESUME_ALLOWED_EXTENSIONS:
        raise ResumeValidationError(
            f"'.{extension}' isn't an allowed resume type — use one of: "
            f"{', '.join(Config.RESUME_ALLOWED_EXTENSIONS)}"
        )
    max_size_bytes = Config.RESUME_MAX_SIZE_MB * 1024 * 1024
    if file_size_bytes > max_size_bytes:
        raise ResumeValidationError(
            f"File is too large ({file_size_bytes / 1024 / 1024:.1f}MB) — "
            f"max is {Config.RESUME_MAX_SIZE_MB}MB"
        )


def save_resume(profile_id: str, filename: str, file_content_base64: str, label: str = "") -> dict:
    """
    Stores a resume for a profile. `label` is a human note the user can attach
    (e.g. "Backend-focused" vs "Full-stack generalist") to tell multiple
    resumes apart at a glance, since the brief notes people often have several.
    """
    try:
        file_bytes = base64.b64decode(file_content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ResumeValidationError(f"Uploaded file isn't valid base64: {exc}")

    _validate_resume_upload(filename, len(file_bytes))

    client = supabase_client.get_client()
    record = {
        "profile_id": profile_id,
        "filename": filename,
        "label": label or filename,
        "file_content_base64": file_content_base64,  # small-scale prototype storage; swap for Supabase Storage + URL at real scale
        "size_bytes": len(file_bytes),
    }
    result = client.table("resumes").insert(record).execute()
    saved_resume = result.data[0] if result.data else record

    # Fires the same audio-alert mechanism used for CAPTCHA/login events, since
    # this is also a "please look at this" moment for the user, per the brief's
    # explicit request for an alert notification on upload.
    alert_human_intervention_needed(f"Resume '{filename}' uploaded and saved for profile {profile_id}")

    return saved_resume


def list_resumes(profile_id: str) -> list[dict]:
    client = supabase_client.get_client()
    result = (
        client.table("resumes")
        .select("id, filename, label, size_bytes, created_at")
        .eq("profile_id", profile_id)
        .execute()
    )
    return result.data or []


def select_best_resume(profile_id: str, job_description_keywords: list[str]) -> dict | None:
    """
    Scores each of the profile's saved resumes by how many of the job's
    extracted keywords appear in the resume's own stored label/filename (a
    crude but zero-cost proxy at this checkpoint stage — matching against full
    resume text would need OCR/text-extraction first, which is Phase 2 scope).
    Returns the highest-scoring resume, or None if the profile has none saved.
    """
    resumes = list_resumes(profile_id)
    if not resumes:
        return None
    if not job_description_keywords:
        return resumes[0]  # nothing to score against — just return the most recently listed one

    def score_resume(resume: dict) -> int:
        searchable_text = f"{resume.get('label', '')} {resume.get('filename', '')}".lower()
        return sum(1 for keyword in job_description_keywords if keyword in searchable_text)

    return max(resumes, key=score_resume)


# Edge Cases Handled (SOP 3.5):
# 1. Disallowed file extension (e.g. .exe) -> ResumeValidationError raised
#    before anything touches Supabase.
# 2. File over RESUME_MAX_SIZE_MB -> ResumeValidationError with the actual
#    size in the message, so the caller can show a useful UI error.
# 3. Corrupted/non-base64 upload payload -> caught explicitly, never lets a
#    binascii.Error bubble up as an unhandled 500.
# 4. Profile has zero saved resumes -> select_best_resume returns None rather
#    than raising, so the caller can prompt "please upload a resume first".
# 5. Job description produced no keywords (Mistral disabled/failed) ->
#    select_best_resume falls back to the first saved resume instead of
#    scoring against an empty list.
