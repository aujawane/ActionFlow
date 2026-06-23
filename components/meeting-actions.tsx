"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MeetingActions({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"analyze" | "generatePrompts" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function trigger(kind: "analyze" | "generatePrompts") {
    setBusy(kind);
    setMessage(null);

    const path =
      kind === "analyze"
        ? `/api/meetings/${meetingId}/analyze`
        : `/api/meetings/${meetingId}/generate-prompts`;

    try {
      const response = await fetch(path, { method: "POST" });
      const data = await response.json();
      setBusy(null);

      if (!response.ok) {
        const details = typeof data?.details === "string" ? data.details : null;
        setMessage(
          details ? `${data.error ?? `Failed to ${kind}`}: ${details}` : data.error ?? `Failed to ${kind}`
        );
        return;
      }

      setMessage(
        kind === "analyze"
          ? "Insights updated from transcript."
          : "Prompts generated for General Development and Lovable."
      );
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
          Analyze transcript and generate build-ready engineering prompts.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => trigger("analyze")}
          disabled={busy !== null}
          className="secondary-button px-3 py-2 text-xs"
        >
          {busy === "analyze" ? "Analyzing..." : "Analyze Meeting"}
        </button>
        <button
          onClick={() => trigger("generatePrompts")}
          disabled={busy !== null}
          className="premium-button px-3 py-2 text-xs"
        >
          {busy === "generatePrompts" ? "Generating..." : "Generate Prompts"}
        </button>
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
