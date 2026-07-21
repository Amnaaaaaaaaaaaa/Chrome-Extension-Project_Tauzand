// Thin fetch wrapper around the Flask backend. All routes centralized here so
// the frontend never hardcodes an endpoint path inline in a component.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:5000";

export type FillFormResult = {
  success: boolean;
  platform?: string;
  fields_detected?: number;
  filled?: { label: string; profile_key: string; confidence: number }[];
  skipped?: { label: string; reason: string; confidence?: number }[];
  events?: { type: string; reason: string; timestamp: number }[];
  duration_ms?: number;
  session_id?: string;
  error?: string;
};

export async function fillForm(url: string, profileId: string): Promise<FillFormResult> {
  const res = await fetch(`${API_BASE}/api/fill-form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, profile_id: profileId }),
  });
  return res.json();
}

export async function getProfile(profileId: string) {
  const res = await fetch(`${API_BASE}/api/profile/${profileId}`);
  return res.json();
}

export async function saveProfile(profile: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/api/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  return res.json();
}

export async function listPlatforms() {
  const res = await fetch(`${API_BASE}/api/platforms`);
  return res.json();
}
