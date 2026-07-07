"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { MeetingSpeakerAlias } from "@/lib/types";

type SpeakerMappingPanelProps = {
  meetingId: string;
  speakerLabels: string[];
  initialAliases: MeetingSpeakerAlias[];
};

export function SpeakerMappingPanel({
  meetingId,
  speakerLabels,
  initialAliases
}: SpeakerMappingPanelProps) {
  const router = useRouter();
  const [aliases, setAliases] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    for (const alias of initialAliases) {
      values[alias.raw_speaker_label] = alias.display_name;
    }
    return values;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function saveAliases() {
    const payload = Object.entries(aliases)
      .map(([raw_speaker_label, display_name]) => ({
        raw_speaker_label,
        display_name: display_name.trim()
      }))
      .filter((alias) => alias.display_name.length > 0);

    if (payload.length === 0) {
      setMessage("Add at least one speaker name before saving.");
      return;
    }

    setSaving(true);
    setMessage(null);

    const response = await fetch(`/api/meetings/${meetingId}/speaker-aliases`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliases: payload })
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    setSaving(false);

    if (!response.ok) {
      setMessage(result.error ?? "Failed to save speaker mappings.");
      return;
    }

    setMessage("Speaker mappings saved. Re-run Analyze Meeting to update task owner detection.");
    router.refresh();
  }

  if (speakerLabels.length === 0) {
    return null;
  }

  return (
    <section className="premium-card space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Speaker Mapping</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Map diarized speaker labels to real names for shared-room or same-device calls.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {speakerLabels.map((label) => (
          <label key={label} className="block rounded-2xl border border-slate-200 bg-white p-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {label}
            </span>
            <input
              value={aliases[label] ?? ""}
              onChange={(event) =>
                setAliases((current) => ({ ...current, [label]: event.target.value }))
              }
              placeholder="Real speaker name"
              className="premium-input mt-2"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveAliases}
          disabled={saving}
          className="premium-button px-3 py-2 text-xs"
        >
          {saving ? "Saving..." : "Save Speaker Mappings"}
        </button>
        {message ? <p className="text-sm text-slate-600">{message}</p> : null}
      </div>
    </section>
  );
}
