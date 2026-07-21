"""
Flask REST API for the checkpoint demo. Per the brief: no auth, no rate
limiting, no load balancer — kept intentionally simple. Routes are thin; all
real logic lives in services/ so this file stays easy to read and the route
surface is easy to restandardize in Phase 2.
"""
import time
import uuid

from flask import Flask, request, jsonify
from flask_cors import CORS

from config import Config
from services import supabase_client, form_filler, resume_service, mistral_client

app = Flask(__name__)
CORS(app, origins=Config.CORS_ORIGINS)

# In-memory session store for the current checkpoint (no DB dependency for
# this bit — swap for Redis/Supabase once we're past the prototype stage).
# Dict keyed by session_id so a lookup by id never scans the full run history.
# TC: O(1) average insert/lookup per session | SC: O(n) for n sessions since last restart
_active_sessions: dict[str, dict] = {}


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "tauzand-autofill-backend"})


@app.get("/api/profile/<profile_id>")
def get_profile(profile_id):
    try:
        profile = supabase_client.get_profile(profile_id)
        return jsonify({"success": True, "profile": profile})
    except (KeyError, supabase_client.SupabaseUnavailableError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 404


@app.post("/api/profile")
def save_profile():
    payload = request.get_json(force=True)
    if not payload.get("id"):
        return jsonify({"success": False, "error": "profile.id is required"}), 400
    try:
        saved = supabase_client.save_profile(payload)
        return jsonify({"success": True, "profile": saved})
    except supabase_client.SupabaseUnavailableError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503


@app.post("/api/fill-form")
def fill_form():
    """
    Body: { "url": "...", "profile_id": "..." }
    Kicks off a real browser session, fills what it confidently can, and
    reports back what it filled / skipped / any human-intervention events.
    """
    payload = request.get_json(force=True)
    target_form_url = payload.get("url")  # the job/test form the automation should open and fill
    candidate_profile_id = payload.get("profile_id")  # which Supabase profile row to pull field values from
    if not target_form_url or not candidate_profile_id:
        return jsonify({"success": False, "error": "url and profile_id are required"}), 400

    try:
        candidate_profile = supabase_client.get_profile(candidate_profile_id)  # full record used as the fill source
    except (KeyError, supabase_client.SupabaseUnavailableError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 404

    run_start_time = time.time()  # wall-clock start, used for the latency figure reported back to the caller
    fill_run_result = form_filler.run_fill(target_form_url, candidate_profile)
    fill_run_duration_ms = int((time.time() - run_start_time) * 1000)

    session_id = str(uuid.uuid4())  # opaque id so the frontend can re-fetch this run's result later
    _active_sessions[session_id] = {
        "url": target_form_url,
        "profile_id": candidate_profile_id,
        "result": fill_run_result,
    }

    supabase_client.log_run({
        "profile_id": candidate_profile_id,
        "platform": fill_run_result.get("platform", "unknown"),
        "url": target_form_url,
        "fields_filled": len(fill_run_result.get("filled", [])),
        "fields_flagged": len(fill_run_result.get("skipped", [])),
        "duration_ms": fill_run_duration_ms,
        "events": fill_run_result.get("events", []),
    })

    return jsonify({**fill_run_result, "session_id": session_id})


@app.get("/api/session/<session_id>")
def get_session(session_id):
    session = _active_sessions.get(session_id)
    if not session:
        return jsonify({"success": False, "error": "Unknown session_id"}), 404
    return jsonify({"success": True, "session": session})


@app.post("/api/resume/upload")
def upload_resume():
    """
    Body: { "profile_id": "...", "filename": "...", "file_content_base64": "...", "label": "..." (optional) }
    Fires an audio alert on success per the brief — people often have several
    resumes, so this is a "please note this happened" moment, not a silent save.
    """
    payload = request.get_json(force=True)
    profile_id = payload.get("profile_id")
    filename = payload.get("filename")
    file_content_base64 = payload.get("file_content_base64")
    resume_label = payload.get("label", "")
    if not profile_id or not filename or not file_content_base64:
        return jsonify({"success": False, "error": "profile_id, filename, and file_content_base64 are required"}), 400

    try:
        saved_resume = resume_service.save_resume(profile_id, filename, file_content_base64, resume_label)
        return jsonify({"success": True, "resume": saved_resume})
    except resume_service.ResumeValidationError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except supabase_client.SupabaseUnavailableError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503


@app.get("/api/resume/list/<profile_id>")
def list_resumes(profile_id):
    try:
        resumes = resume_service.list_resumes(profile_id)
        return jsonify({"success": True, "resumes": resumes})
    except supabase_client.SupabaseUnavailableError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503


@app.post("/api/job-description/analyze")
def analyze_job_description():
    """
    Body: { "job_description_text": "..." }
    Returns extracted keywords; repeated calls with the same text hit the
    Supabase cache instead of re-calling Mistral (see mistral_client.py).
    """
    payload = request.get_json(force=True)
    job_description_text = payload.get("job_description_text", "")
    if not job_description_text.strip():
        return jsonify({"success": False, "error": "job_description_text is required"}), 400

    extraction_result = mistral_client.extract_keywords(job_description_text)
    return jsonify({"success": True, **extraction_result})


@app.post("/api/resume/best-match")
def best_match_resume():
    """
    Body: { "profile_id": "...", "job_description_text": "..." }
    Analyzes the job description (cached where possible) and returns whichever
    saved resume scores highest against its keywords.
    """
    payload = request.get_json(force=True)
    profile_id = payload.get("profile_id")
    job_description_text = payload.get("job_description_text", "")
    if not profile_id:
        return jsonify({"success": False, "error": "profile_id is required"}), 400

    extraction_result = mistral_client.extract_keywords(job_description_text) if job_description_text.strip() else {"keywords": []}
    try:
        best_resume = resume_service.select_best_resume(profile_id, extraction_result["keywords"])
    except supabase_client.SupabaseUnavailableError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503

    if best_resume is None:
        return jsonify({"success": False, "error": "No resumes saved for this profile yet"}), 404
    return jsonify({"success": True, "resume": best_resume, "matched_keywords": extraction_result["keywords"]})


@app.post("/api/close-session/<driver_id>")
def close_session(driver_id):
    """Closes the actual Chrome window for a past fill run. Call this once the
    user has reviewed/submitted the form and no longer needs it open."""
    closed = form_filler.close_driver(driver_id)
    if not closed:
        return jsonify({"success": False, "error": "Unknown or already-closed driver_id"}), 404
    return jsonify({"success": True})


@app.get("/api/platforms")
def list_platforms():
    from services.platform_configs import PLATFORM_CONFIGS
    return jsonify({
        "platforms": [
            {
                "key": platform_key,
                "domains": platform_configuration["match_domains"],
                "notes": platform_configuration["notes"],
            }
            for platform_key, platform_configuration in PLATFORM_CONFIGS.items()
        ]
    })


if __name__ == "__main__":
    app.run(port=Config.FLASK_PORT, debug=Config.FLASK_ENV == "development")


# Edge Cases Handled (SOP 3.5):
# 1. Missing url or profile_id in /api/fill-form body -> 400 with a clear
#    error message before any browser/Supabase work starts.
# 2. Unknown profile_id -> Supabase lookup raises KeyError -> 404, not a 500.
# 3. Supabase not configured (.env missing) -> SupabaseUnavailableError caught
#    and returned as a 503/404 with a message telling the caller what to fix,
#    rather than an unhandled stack trace.
# 4. Supabase logging failure after a successful fill -> log_run() swallows
#    its own exceptions (see supabase_client.py) so a logging outage never
#    fails a fill that actually succeeded.
# 5. Unknown session_id on GET /api/session/<id> -> 404 rather than None
#    silently serialized as a 200.
