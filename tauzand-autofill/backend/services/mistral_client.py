"""
Mistral integration for job-description analysis. Kept deliberately narrow in
scope: this module's only job is "given a job description, return the
important keywords/requirements" — a single, cheap, cacheable call, not a
general-purpose chat wrapper.

Cost-optimization (per Chawala's email — "store and reuse relevant keywords"):
every extraction result is cached in Supabase's job_description_keywords table,
keyed by a hash of the description text. The same job posting analyzed twice
(e.g. two candidates applying to the same role) only ever costs one Mistral
call. This is the lightweight, budget-friendly version of the "RAG for
reasoning" idea in the brief — we're not standing up a vector DB for this
checkpoint, just retrieval (cache lookup) + a single generation call on a miss.
"""
import hashlib
import json

import requests

from config import Config
from services import supabase_client

SYSTEM_PROMPT = (
    "You are a job description analyzer. Given a job posting's text, extract the "
    "most important keywords: required skills, tools, certifications, and "
    "experience level. Respond ONLY with a JSON array of lowercase strings, "
    "no explanations, no markdown. Example: [\"python\", \"3+ years\", \"aws\", \"sql\"]"
)


def _hash_job_description(text: str) -> str:
    """Stable cache key for a job description's text, so identical postings never re-call the API."""
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()


def _get_cached_keywords(description_hash: str) -> list[str] | None:
    if not Config.JD_KEYWORD_CACHE_ENABLED:
        return None
    try:
        client = supabase_client.get_client()
        result = (
            client.table("job_description_keywords")
            .select("keywords")
            .eq("description_hash", description_hash)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]["keywords"]
    except Exception:
        pass  # cache miss on any storage hiccup just means we fall through to a live call
    return None


def _store_keywords_in_cache(description_hash: str, keywords: list[str]) -> None:
    if not Config.JD_KEYWORD_CACHE_ENABLED:
        return
    try:
        client = supabase_client.get_client()
        client.table("job_description_keywords").upsert({
            "description_hash": description_hash,
            "keywords": keywords,
        }).execute()
    except Exception:
        pass  # caching failure shouldn't fail the actual extraction the caller asked for


def _call_mistral_for_keywords(job_description_text: str) -> list[str]:
    """The one actual paid API call in this module — everything above exists to avoid making it twice."""
    response = requests.post(
        Config.MISTRAL_API_URL,
        headers={
            "Authorization": f"Bearer {Config.MISTRAL_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": Config.MISTRAL_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": job_description_text[:4000]},  # trimmed to keep token usage predictable
            ],
            "temperature": 0.1,  # low temperature: this is extraction, not creative writing
        },
        timeout=10,
    )
    response.raise_for_status()
    raw_content = response.json()["choices"][0]["message"]["content"]
    try:
        keywords = json.loads(raw_content)
        return [str(keyword).lower().strip() for keyword in keywords if keyword]
    except (json.JSONDecodeError, TypeError, KeyError):
        return []  # malformed model output -> treat as "no keywords found" rather than crash the caller


def extract_keywords(job_description_text: str) -> dict:
    """
    Public entry point. Returns {"keywords": [...], "source": "cache" | "mistral" | "disabled"}.
    Never raises — a Mistral outage degrades to an empty keyword list rather
    than breaking whatever feature (e.g. resume matching) called this.
    """
    if not Config.MISTRAL_ENABLED or not Config.MISTRAL_API_KEY:
        return {"keywords": [], "source": "disabled"}

    description_hash = _hash_job_description(job_description_text)

    cached_keywords = _get_cached_keywords(description_hash)
    if cached_keywords is not None:
        return {"keywords": cached_keywords, "source": "cache"}

    try:
        keywords = _call_mistral_for_keywords(job_description_text)
    except (requests.RequestException, KeyError, IndexError):
        return {"keywords": [], "source": "error"}

    _store_keywords_in_cache(description_hash, keywords)
    return {"keywords": keywords, "source": "mistral"}


# Edge Cases Handled (SOP 3.5):
# 1. MISTRAL_API_KEY not set -> extract_keywords() returns source="disabled"
#    immediately, no network call attempted.
# 2. Same job description analyzed twice -> second call hits the Supabase
#    cache, zero additional Mistral spend.
# 3. Mistral returns malformed/non-JSON content -> _call_mistral_for_keywords
#    catches the parse error and returns an empty list rather than raising.
# 4. Mistral API down/timeout -> caught in extract_keywords, returns
#    source="error" with an empty list instead of crashing the caller.
# 5. Supabase cache read/write fails -> caching functions swallow the
#    exception; extraction still proceeds as if it were a cache miss.
