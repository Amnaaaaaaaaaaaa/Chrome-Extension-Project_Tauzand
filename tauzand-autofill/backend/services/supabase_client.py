"""
Thin wrapper around the Supabase Python SDK. Kept separate from app.py so the
storage backend can be swapped (the brief allows Supabase OR Firebase) without
touching route logic — routes only ever call get_profile/save_profile/log_run.

Table expected in Supabase (create via the SQL editor, free tier):

    create table profiles (
        id text primary key,
        full_name text,
        email text,
        phone text,
        address jsonb,
        education jsonb,
        work_experience jsonb,
        skills jsonb,
        resume_url text,
        created_at timestamp default now()
    );

    create table fill_runs (
        id uuid primary key default gen_random_uuid(),
        profile_id text,
        platform text,
        url text,
        fields_filled int,
        fields_flagged int,
        duration_ms int,
        events jsonb,
        created_at timestamp default now()
    );

    -- Added for the expanded scope (multiple resumes + Mistral job-description matching):
    create table resumes (
        id uuid primary key default gen_random_uuid(),
        profile_id text references profiles(id) on delete cascade,
        filename text not null,
        label text,
        file_content_base64 text not null,
        size_bytes int,
        created_at timestamp default now()
    );

    create table job_description_keywords (
        description_hash text primary key,
        keywords jsonb not null,
        created_at timestamp default now()
    );
"""
from config import Config

try:
    from supabase import create_client, Client
    _SDK_AVAILABLE = True
except ImportError:
    _SDK_AVAILABLE = False


class SupabaseUnavailableError(RuntimeError):
    pass


_client: "Client | None" = None


def get_client():
    global _client
    if not _SDK_AVAILABLE:
        raise SupabaseUnavailableError(
            "supabase-py isn't installed. Run: pip install supabase"
        )
    if not Config.SUPABASE_URL or not Config.SUPABASE_KEY:
        raise SupabaseUnavailableError(
            "SUPABASE_URL / SUPABASE_KEY missing. Copy backend/.env.example to "
            "backend/.env and fill them in with your free-tier project's values."
        )
    if _client is None:
        _client = create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
    return _client


def get_profile(profile_id: str) -> dict:
    client = get_client()
    result = (
        client.table(Config.SUPABASE_PROFILES_TABLE)
        .select("*")
        .eq("id", profile_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise KeyError(f"No profile found with id '{profile_id}'")
    return result.data[0]


def save_profile(profile: dict) -> dict:
    client = get_client()
    result = (
        client.table(Config.SUPABASE_PROFILES_TABLE)
        .upsert(profile)
        .execute()
    )
    return result.data[0] if result.data else profile


def log_run(run_record: dict) -> None:
    """Best-effort logging of a fill run; failures here never break the fill itself."""
    try:
        client = get_client()
        client.table(Config.SUPABASE_RUNS_TABLE).insert(run_record).execute()
    except Exception:
        pass
