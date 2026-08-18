"""
Flask REST API for the checkpoint demo. Per the brief: no auth, no rate
limiting, no load balancer — kept intentionally simple. Routes are thin; all
real logic lives in services/ so this file stays easy to read and the route
surface is easy to restandardize in Phase 2.
"""
import time
import uuid

from flask import Flask, request, jsonify  # type: ignore[import]
from flask_cors import CORS  # type: ignore[import]

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


@app.post("/api/llm/batch-generate-behavioral")
def batch_generate_behavioral():
    """
    Body: { "questions": ["...", "..."], "profile": {...} }
    Phase 2 of the architecture change requested in review: generates answers
    for ALL behavioral questions on one form in a SINGLE Mistral call, instead
    of one call per question, to keep API cost/latency down at scale. Strict
    JSON in and out — no free-form explanation text. PII (phone, email,
    GitHub, LinkedIn) is never included in what's sent to Mistral, per an
    explicit instruction in the review.
    """
    payload = request.get_json(force=True)
    questions = payload.get("questions") or []
    profile = payload.get("profile") or {}
    job_context = (payload.get("jobContext") or "").strip()
    if not questions:
        return jsonify({"success": False, "error": "questions is required and must be non-empty"}), 400
    if not Config.MISTRAL_API_KEY:
        return jsonify({"success": False, "error": "Mistral API key not configured on the backend"}), 500

    # PII exclusion, explicit per instruction — only background/skills context
    # goes in, never contact details or account links.
    summary_lines = []
    if profile.get("skills"):
        summary_lines.append(f"Skills: {profile['skills']}")
    if profile.get("school") or profile.get("degree_type") or profile.get("field_of_study"):
        summary_lines.append(
            f"Education: {profile.get('degree_type', '')} in {profile.get('field_of_study', '')} "
            f"at {profile.get('school', '')}".strip()
        )
    if profile.get("education"):
        summary_lines.append(f"Education history: {profile['education']}")
    if profile.get("work_experience"):
        summary_lines.append(f"Work experience: {profile['work_experience']}")
    if profile.get("current_company"):
        summary_lines.append(f"Current company: {profile['current_company']}")
    profile_summary = "\n".join(summary_lines) or "No additional profile details available."

    system_prompt = (
        "You are helping a job applicant answer several behavioral job-application questions "
        "at once (e.g. \"Why do you want to join our company?\", \"What are your strengths?\"). "
        "For EACH question, write a short, professional, recruiter-friendly answer using the "
        "candidate's real background where relevant — never invent facts not present in their "
        "profile. If job/company context is provided, reference it naturally where relevant "
        "(e.g. mentioning the specific role or company for a \"why do you want to join us\" "
        "question) instead of writing something fully generic. Keep each answer confident but "
        "honest, concise (3-5 sentences), and free of generic filler. Respond with ONLY a JSON "
        "array, one object per question, in the same order as the questions were given, in "
        "exactly this shape — no other text before or after the array:\n"
        '[{"question": "<repeat the question>", "answer": "<the answer>", '
        '"confidence": <0.0-1.0>, "requires_review": <true or false>}]'
    )
    user_prompt_parts = [f"Candidate background:\n{profile_summary}"]
    if job_context:
        user_prompt_parts.append(f"Job/company context: {job_context}")
    user_prompt_parts.append(
        "Questions:\n" + "\n".join(f"{i + 1}. {q}" for i, q in enumerate(questions))
    )
    user_prompt = "\n\n".join(user_prompt_parts)

    try:
        import requests
        response = requests.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {Config.MISTRAL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "mistral-small-latest",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.6,
                "max_tokens": 500 * max(len(questions), 1),
            },
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        raw_reply = result["choices"][0]["message"]["content"].strip()

        # Mistral occasionally wraps the array in a fenced code block despite
        # the instruction not to — strip that defensively before parsing.
        if raw_reply.startswith("```"):
            raw_reply = raw_reply.strip("`")
            if raw_reply.lower().startswith("json"):
                raw_reply = raw_reply[4:].strip()

        import json as json_module
        parsed = json_module.loads(raw_reply)
        # Some models wrap a single-object response in {"results": [...]}
        # rather than a bare array when json_object mode is forced — handle both.
        if isinstance(parsed, dict) and "results" in parsed:
            parsed = parsed["results"]
        if not isinstance(parsed, list):
            parsed = [parsed]

        return jsonify({"success": True, "results": parsed})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.post("/api/llm/suggest-answer")
def suggest_answer():
    """
    Body: { "question": "...", "profile": {...} }
    Powers the extension's "AI Suggest" button on long-answer (textarea)
    questions the confidence-matcher can't handle (e.g. "Best project you
    worked on", "Expected CTC"). Uses the candidate's profile as context so
    the draft references their real background instead of being generic —
    the extension always shows this as an editable draft, never auto-fills
    it, so a slightly-off suggestion is a minor inconvenience, not a
    correctness risk the way silently submitting one would be.
    """
    payload = request.get_json(force=True)
    question = (payload.get("question") or "").strip()
    profile = payload.get("profile") or {}
    if not question:
        return jsonify({"success": False, "error": "question is required"}), 400
    if not Config.MISTRAL_API_KEY:
        return jsonify({"success": False, "error": "Mistral API key not configured on the backend"}), 500

    # Compact, relevant-only summary — sending the whole profile blob would
    # waste tokens on fields (phone number, address, etc.) that have nothing
    # to do with writing a recruiter-facing answer.
    summary_lines = []
    if profile.get("full_name"):
        summary_lines.append(f"Name: {profile['full_name']}")
    if profile.get("skills"):
        summary_lines.append(f"Skills: {profile['skills']}")
    if profile.get("school") or profile.get("degree_type") or profile.get("field_of_study"):
        summary_lines.append(
            f"Education: {profile.get('degree_type', '')} in {profile.get('field_of_study', '')} "
            f"at {profile.get('school', '')}".strip()
        )
    if profile.get("education"):
        summary_lines.append(f"Education history: {profile['education']}")
    if profile.get("work_experience"):
        summary_lines.append(f"Work experience: {profile['work_experience']}")
    profile_summary = "\n".join(summary_lines) or "No additional profile details available — write a reasonable general answer."

    system_prompt = (
        "You are helping a job applicant answer a job application question. Write a short, "
        "professional, recruiter-friendly answer using the candidate's real background where "
        "relevant — never invent facts not present in their profile. Keep it confident but "
        "honest, concise (3-5 sentences unless the question clearly calls for more, e.g. a "
        "single number for something like expected salary), and free of generic filler "
        "phrases. Respond with ONLY a JSON object, no other text before or after it, in "
        "exactly this shape:\n"
        '{"answer": "<the answer, no greeting, no sign-off>", "confidence": <0.0-1.0, how '
        "well the candidate's profile supports this answer>, "
        '"requires_review": <true if the profile had little to go on and the answer leans '
        "generic, false if it's well-grounded in their actual background>}"
    )
    user_prompt = f"Question: {question}\n\nCandidate background:\n{profile_summary}\n\nWrite the answer."

    try:
        import requests
        import json as json_module
        response = requests.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {Config.MISTRAL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "mistral-small-latest",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.6,
                "max_tokens": 400,
            },
            timeout=20,
        )
        response.raise_for_status()
        result = response.json()
        raw_reply = result["choices"][0]["message"]["content"].strip()
        if raw_reply.startswith("```"):
            raw_reply = raw_reply.strip("`")
            if raw_reply.lower().startswith("json"):
                raw_reply = raw_reply[4:].strip()
        parsed = json_module.loads(raw_reply)
        return jsonify({
            "success": True,
            "answer": parsed.get("answer", ""),
            "confidence": parsed.get("confidence"),
            "requires_review": parsed.get("requires_review", True),
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


@app.post("/api/llm/validate-legal-text")
def validate_legal_text():
    """
    Body: { "question": "...", "current_text": "..." }
    Powers the extension's "Check for legal risk" button on legal-sensitive
    free-text questions (e.g. "explain any convictions", "describe the
    circumstances of the lawsuit"). Analyzes text the candidate has already
    written and suggests safer phrasing — never rewrites the substance of
    what they said, only flags risky wording and offers an alternative the
    candidate must explicitly review and insert themselves.
    """
    payload = request.get_json(force=True)
    question = (payload.get("question") or "").strip()
    current_text = (payload.get("current_text") or "").strip()
    if not question or not current_text:
        return jsonify({"success": False, "error": "question and current_text are required"}), 400
    if not Config.MISTRAL_API_KEY:
        return jsonify({"success": False, "error": "Mistral API key not configured on the backend"}), 500

    system_prompt = (
        "You are helping a job applicant review text they wrote for a legally sensitive "
        "application question, before they submit it. Do NOT change the facts, admissions, "
        "or substance of what they wrote — only flag wording that is unnecessarily broad, "
        "self-incriminating beyond what was asked, or phrased in a way that could create "
        "legal risk for them, and suggest more precise, factual phrasing that says the same "
        "true thing more carefully. If the text is already fine, say so plainly and don't "
        "invent a change for the sake of having one. Respond with ONLY a JSON object, no "
        "other text before or after it, in exactly this shape:\n"
        '{"risk_note": "<one short sentence — either \'No significant concerns found.\' or '
        'what to watch for>", "suggested_text": "<the revised text, or the original text '
        'unchanged if no revision is needed>", "confidence": <0.0-1.0, how confident you are '
        'in this risk assessment>, "requires_review": <true if there is any real concern '
        "worth the candidate's attention, false only if the text is clearly fine>}"
    )
    user_prompt = f"Question: {question}\n\nCandidate's current answer:\n{current_text}"

    try:
        import requests
        import json as json_module
        response = requests.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {Config.MISTRAL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "mistral-small-latest",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 400,
            },
            timeout=20,
        )
        response.raise_for_status()
        result = response.json()
        raw_reply = result["choices"][0]["message"]["content"].strip()
        if raw_reply.startswith("```"):
            raw_reply = raw_reply.strip("`")
            if raw_reply.lower().startswith("json"):
                raw_reply = raw_reply[4:].strip()
        parsed = json_module.loads(raw_reply)

        return jsonify({
            "success": True,
            "risk_note": parsed.get("risk_note", ""),
            "suggested_text": parsed.get("suggested_text", current_text),
            "confidence": parsed.get("confidence"),
            "requires_review": parsed.get("requires_review", True),
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 502


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