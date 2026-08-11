"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { MeetingSpeakerRosterItem } from "@/lib/types";

type SpeakerMappingPanelProps = {
  meetingId: string;
  initialSpeakers: MeetingSpeakerRosterItem[];
};

type SpeakersResponse = {
  speakers?: MeetingSpeakerRosterItem[];
  error?: string;
  details?: string;
};

function buildInputValues(speakers: MeetingSpeakerRosterItem[]) {
  return Object.fromEntries(
    speakers.map((speaker) => [
      speaker.rawSpeakerLabel,
      speaker.isResolved ? speaker.displayName : ""
    ])
  );
}

export function SpeakerMappingPanel({
  meetingId,
  initialSpeakers
}: SpeakerMappingPanelProps) {
  const router = useRouter();
  const [speakers, setSpeakers] = useState(initialSpeakers);
  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInputValues(initialSpeakers)
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setSpeakers(initialSpeakers);
    setValues(buildInputValues(initialSpeakers));
  }, [initialSpeakers]);

  useEffect(() => {
    let cancelled = false;
    async function refreshRoster() {
      try {
        const response = await fetch(`/api/meetings/${meetingId}/speakers`, {
          cache: "no-store"
        });
        const result = (await response.json().catch(() => ({}))) as SpeakersResponse;
        if (!response.ok || !result.speakers || cancelled) return;
        setSpeakers(result.speakers);
        setValues(buildInputValues(result.speakers));
      } catch {
        // Keep server-rendered roster; saving still reports actionable errors.
      }
    }
    void refreshRoster();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  async function saveMappings() {
    const mappings = speakers
      .map((speaker) => ({
        rawSpeakerLabel: speaker.rawSpeakerLabel,
        displayName: values[speaker.rawSpeakerLabel]?.trim() ?? ""
      }))
      .filter((mapping) => mapping.displayName.length > 0);

    if (mappings.length === 0) {
      setMessage("Add at least one speaker name before saving.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/speakers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings })
      });
      const result = (await response.json().catch(() => ({}))) as SpeakersResponse;
      if (!response.ok || !result.speakers) {
        setMessage(result.details || result.error || "Failed to save speaker mappings.");
        return;
      }

      setSpeakers(result.speakers);
      setValues(buildInputValues(result.speakers));
      setMessage("Speaker names saved. Transcript and task owners have been updated.");
      router.refresh();
    } catch {
      setMessage("Request failed while saving speaker mappings.");
    } finally {
      setSaving(false);
    }
  }

  if (speakers.length === 0) return null;

  const unresolvedCount = speakers.filter((speaker) => !speaker.isResolved).length;

  return (
    <details className="group premium-card p-5">
      {/* Compact by default: a callout summarizing whether anything needs attention, not the
          full quote-by-quote resolution grid. The full interface (below) opens on demand. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <div className="flex items-start gap-3">
          <span
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unresolvedCount > 0 ? "bg-amber-500" : "bg-brand-500"}`}
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {unresolvedCount > 0
                ? `${unresolvedCount} speaker${unresolvedCount === 1 ? "" : "s"} need identification`
                : "All speakers identified"}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {unresolvedCount > 0
                ? "Confirm speaker identities to improve ownership accuracy."
                : "Review or update speaker names for this meeting."}
            </p>
          </div>
        </div>
        <span className="tertiary-button px-3 py-1.5 text-xs group-open:hidden">
          Resolve speakers
        </span>
        <span className="tertiary-button hidden px-3 py-1.5 text-xs group-open:inline-flex">
          Hide
        </span>
      </summary>

      <div className="mt-5 space-y-4 border-t border-slate-100 pt-5">
        <p className="text-sm leading-6 text-slate-600">
          Map anonymous or shared-device speaker labels to real names. Raw Recall
          participant and diarization data remains unchanged.
        </p>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {speakers.map((speaker) => (
          <label
            key={speaker.rawSpeakerLabel}
            className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <span className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-semibold text-slate-900">
                  {speaker.rawSpeakerLabel}
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  {speaker.segmentCount}{" "}
                  {speaker.segmentCount === 1 ? "segment" : "segments"} ·{" "}
                  {speaker.taskCount} {speaker.taskCount === 1 ? "task" : "tasks"}
                </span>
              </span>
              <span
                className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${
                  speaker.isResolved
                    ? "border-brand-100 bg-brand-50 text-brand-800"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }`}
              >
                {speaker.isResolved ? "Resolved" : "Needs name"}
              </span>
            </span>

            {speaker.participantName ? (
              <span className="mt-3 block text-xs text-slate-500">
                Participant: {speaker.participantName}
                {speaker.isAmbiguous ? " · shared device detected" : ""}
              </span>
            ) : null}

            {speaker.possibleNameHints.length > 0 ? (
              <span className="mt-3 block rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">
                Possible name:{" "}
                <span className="font-semibold">
                  {speaker.possibleNameHints.join(" or ")}
                </span>
              </span>
            ) : !speaker.isResolved ? (
              <span className="mt-3 block text-xs leading-5 text-slate-500">
                No name detected — use the quotes below to identify this speaker.
              </span>
            ) : null}

            <span className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Example quotes
            </span>
            {speaker.exampleQuotes.length > 0 ? (
              <span className="mt-2 block space-y-2">
                {speaker.exampleQuotes.map((quote) => (
                  <span
                    key={quote}
                    className="block rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-700"
                  >
                    &ldquo;{quote}&rdquo;
                  </span>
                ))}
              </span>
            ) : (
              <span className="mt-2 block text-xs text-slate-500">
                No transcript quotes are available for this label yet.
              </span>
            )}

            <span className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Map to
            </span>
            <input
              value={values[speaker.rawSpeakerLabel] ?? ""}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [speaker.rawSpeakerLabel]: event.target.value
                }))
              }
              placeholder={speaker.isResolved ? speaker.displayName : "Enter real speaker name"}
              className="premium-input mt-2"
            />
          </label>
        ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={saveMappings}
            disabled={saving}
            className="premium-button px-4 py-2 text-sm"
          >
            {saving ? "Saving..." : "Save Speaker Names"}
          </button>
          {message ? <p className="text-sm text-slate-600">{message}</p> : null}
        </div>
      </div>
    </details>
  );
}
