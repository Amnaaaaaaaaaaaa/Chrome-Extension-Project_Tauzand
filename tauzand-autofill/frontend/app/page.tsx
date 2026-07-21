"use client";

// Step 1 (SOP 3.6) — Data kept separate from render logic: sample profile/result
// data lives in data/sampleData.json, not inlined into this component.
import { useState } from "react";
import sampleData from "@/data/sampleData.json";
import { fillForm, FillFormResult } from "@/lib/api";

// Design rationale (SOP 3.6 Step 3 — must be able to justify the design):
// Single-column form -> action -> result layout. No decorative elements; every
// element on screen either takes input or reports a real outcome. Sapphire Veil
// is used for the primary action and confident results; Imperial Topaz is used
// only for "needs attention" states (skipped fields, human-intervention events),
// matching the SOP's approved palette (4.2) and its intended meaning (amber =
// attention, not error — a skipped field isn't a failure, just unconfident).

export default function Home() {
  const [formUrlInput, setFormUrlInput] = useState(""); // the job/test form URL the user wants filled
  const [candidateProfileId, setCandidateProfileId] = useState(
    sampleData.sampleCandidateProfile.id
  ); // which Supabase profile row to fill from
  const [useSampleDataOnly, setUseSampleDataOnly] = useState(true); // Phase-1 data access policy (SOP 5): default to local JSON, not live backend
  const [isFillRunLoading, setIsFillRunLoading] = useState(false); // controls skeleton visibility while a fill run is in flight
  const [fillRunResult, setFillRunResult] = useState<FillFormResult | null>(null); // last completed run's result, sample or live

  // Step 2 (SOP 3.6) — trigger a run, either against the local sample JSON
  // (Phase-1 default per SOP section 5) or, only when explicitly switched off,
  // against the real backend (emergency/time-critical case per the same policy).
  async function handleRunAutoFill() {
    setIsFillRunLoading(true);
    setFillRunResult(null);
    try {
      if (useSampleDataOnly) {
        // Simulated latency so the skeleton state is visibly demonstrated,
        // matching SOP 3.6 Step 4's loading-state requirement.
        await new Promise((resolve) => setTimeout(resolve, 600));
        setFillRunResult(sampleData.sampleFillResult as FillFormResult);
      } else {
        const liveResult = await fillForm(formUrlInput, candidateProfileId);
        setFillRunResult(liveResult);
      }
    } finally {
      setIsFillRunLoading(false);
    }
  }

  return (
    // Step 5 (SOP 3.6) — consistent padding (p-6/p-4) and consistent rounded
    // corners (rounded-lg) applied across every card-like element below.
    <main className="max-w-2xl mx-auto p-8 space-y-6">
      <h1 className="text-xl font-semibold text-sapphireVeil-dark">
        Tauzand Auto-Apply — Backend Test Harness
      </h1>

      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-1 text-sm text-slate-600">
        <p>
          Phase-1 data access policy: this page defaults to the hardcoded sample
          JSON in <code>data/sampleData.json</code>, not the live backend, per the
          SOP&apos;s frontend data-access rules.
        </p>
        <label className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={useSampleDataOnly}
            onChange={(event) => setUseSampleDataOnly(event.target.checked)}
          />
          Use sample data only (uncheck only for mentor-approved live testing)
        </label>
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-sapphireVeil-dark">Target form URL</label>
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-sapphireVeil focus:outline-none"
          placeholder="https://docs.google.com/forms/d/e/.../viewform"
          value={formUrlInput}
          onChange={(event) => setFormUrlInput(event.target.value)}
          disabled={useSampleDataOnly}
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-sapphireVeil-dark">Profile ID (Supabase row)</label>
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-sapphireVeil focus:outline-none"
          value={candidateProfileId}
          onChange={(event) => setCandidateProfileId(event.target.value)}
        />
      </div>

      <button
        onClick={handleRunAutoFill}
        disabled={isFillRunLoading || (!useSampleDataOnly && !formUrlInput)}
        className="rounded-lg border border-sapphireVeil bg-sapphireVeil-tint px-4 py-2 text-sapphireVeil-dark disabled:opacity-50"
      >
        {isFillRunLoading ? "Running…" : "Run Auto-Fill"}
      </button>

      {/* Step 4 (SOP 3.6) — skeleton screen while a run is in flight; real data
          replaces it only once the result arrives. */}
      {isFillRunLoading && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2 animate-pulse">
          <div className="h-4 w-1/3 rounded bg-slate-200" />
          <div className="h-4 w-2/3 rounded bg-slate-200" />
          <div className="h-4 w-1/2 rounded bg-slate-200" />
        </div>
      )}

      {!isFillRunLoading && fillRunResult && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-3 text-sm">
          <div>
            <strong>Success:</strong> {String(fillRunResult.success)}
          </div>
          {fillRunResult.error && (
            <div className="text-rose-600">Error: {fillRunResult.error}</div>
          )}
          {fillRunResult.platform && (
            <div><strong>Platform:</strong> {fillRunResult.platform}</div>
          )}
          {fillRunResult.duration_ms !== undefined && (
            <div><strong>Duration:</strong> {fillRunResult.duration_ms} ms</div>
          )}
          {fillRunResult.filled && (
            <div>
              <strong>Filled ({fillRunResult.filled.length}):</strong>
              <ul className="list-disc pl-5">
                {fillRunResult.filled.map((filledField, index) => (
                  <li key={index}>
                    {filledField.label} → {filledField.profile_key} (confidence{" "}
                    {filledField.confidence})
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fillRunResult.skipped && fillRunResult.skipped.length > 0 && (
            <div className="rounded-lg bg-imperialTopaz-tint p-3 text-imperialTopaz">
              <strong>Skipped ({fillRunResult.skipped.length}):</strong>
              <ul className="list-disc pl-5">
                {fillRunResult.skipped.map((skippedField, index) => (
                  <li key={index}>
                    {skippedField.label} — {skippedField.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fillRunResult.events && fillRunResult.events.length > 0 && (
            <div className="rounded-lg bg-imperialTopaz-tint p-3 text-imperialTopaz">
              <strong>Human intervention events:</strong>
              <ul className="list-disc pl-5">
                {fillRunResult.events.map((event, index) => (
                  <li key={index}>
                    {event.type}: {event.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

// Edge Cases Handled (SOP 3.5):
// 1. Sample mode checked (default) -> never calls the live backend; uses
//    data/sampleData.json and a simulated delay so the skeleton is visible.
// 2. Live mode with empty form URL -> Run button stays disabled.
// 3. Backend unreachable in live mode -> fillForm() rejects; caller sees no
//    result card and isFillRunLoading resets via the finally block (no stuck
//    skeleton).
// 4. Result has no skipped fields / no events -> those sections simply don't
//    render, rather than showing empty "Skipped (0):" blocks.
// 5. Very long field labels/reasons -> wrapped by default list-item text flow,
//    no manual truncation needed at this data size.
