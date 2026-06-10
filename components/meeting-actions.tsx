"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MeetingActions({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"analyze" | "prompts" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function trigger(kind: "analyze" | "prompts") {
    setBusy(kind);
    setMessage(null);

    const response = await fetch(
      `/api/meetings/${meetingId}/${kind === "analyze" ? "analyze" : "prompts"}`,
      {
        method: "POST"
      }
    );

    const data = await response.json();
    setBusy(null);

    if (!response.ok) {
      setMessage(data.error ?? `Failed to ${kind}`);
      return;
    }

    setMessage(
      kind === "analyze"
        ? "Insights updated from transcript."
        : "Prompts generated for Codex, Claude Code, and Lovable."
    );
    router.refresh();
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Actions</h2>
      <div className="flex gap-2">
        <button
          onClick={() => trigger("analyze")}
          disabled={busy !== null}
          className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {busy === "analyze" ? "Analyzing..." : "Analyze Meeting"}
        </button>
        <button
          onClick={() => trigger("prompts")}
          disabled={busy !== null}
          className="rounded-md bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {busy === "prompts" ? "Generating..." : "Generate Prompts"}
        </button>
      </div>
      {message ? <p className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
}
