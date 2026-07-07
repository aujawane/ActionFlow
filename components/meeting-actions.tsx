"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MeetingActions({
  meetingId,
  showDevReimport = false
}: {
  meetingId: string;
  showDevReimport?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"analyze" | "reimport" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function triggerAnalyze() {
    setBusy("analyze");
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
      const data = await response.json();
      setBusy(null);

      if (!response.ok) {
        const details = typeof data?.details === "string" ? data.details : null;
        setMessage(
          details
            ? `${data.error ?? "Failed to analyze meeting"}: ${details}`
            : data.error ?? "Failed to analyze meeting"
        );
        return;
      }

      setMessage("Insights updated from transcript.");
      router.refresh();
    } catch {
      setBusy(null);
      setMessage("Request failed. Check your connection and try again.");
    }
  }

  async function reimportTranscript() {
    const pastedJson = window.prompt(
      "Paste the Recall.ai transcript JSON array from the dashboard."
    );

    if (!pastedJson) return;

    let transcript: unknown;
    try {
      transcript = JSON.parse(pastedJson);
    } catch {
      setMessage("Invalid JSON. Paste the Recall transcript array and try again.");
      return;
    }

    if (!Array.isArray(transcript)) {
      setMessage("Transcript JSON must be an array of Recall transcript entries.");
      return;
    }

    setBusy("reimport");
    setMessage(null);

    try {
      const response = await fetch("/api/dev/reimport-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId, transcript })
      });
      const data = await response.json();
      setBusy(null);

      if (!response.ok) {
        const details = typeof data?.details === "string" ? data.details : null;
        setMessage(
          details
            ? `${data.error ?? "Failed to reimport transcript"}: ${details}`
            : data.error ?? "Failed to reimport transcript"
        );
        return;
      }

      setMessage(`Transcript reimported. Inserted ${data.insertedSegments ?? 0} segments.`);
      router.refresh();
    } catch {
      setBusy(null);
      setMessage("Request failed. Check your connection and try again.");
    }
  }

  return (
    <div className="premium-card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Meeting Actions</h2>
        <p className="text-xs text-slate-500">
          Analyze transcript and refresh extracted meeting intelligence.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={triggerAnalyze}
          disabled={busy !== null}
          className="secondary-button px-3 py-2 text-xs"
        >
          {busy === "analyze" ? "Analyzing..." : "Analyze Meeting"}
        </button>
        {showDevReimport ? (
          <button
            onClick={reimportTranscript}
            disabled={busy !== null}
            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 transition hover:border-amber-300 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "reimport" ? "Reimporting..." : "Reimport Transcript"}
          </button>
        ) : null}
      </div>
      {message ? (
        <p
          className={`rounded-md px-2 py-1 text-xs ${
            message.toLowerCase().includes("failed")
              ? "bg-rose-50 text-rose-700"
              : "border border-brand-100 bg-brand-50 text-brand-800"
          }`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
