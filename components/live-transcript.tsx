"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { Meeting, TranscriptSegment } from "@/lib/types";

const ACTIVE_STATUSES: Meeting["status"][] = ["joining", "recording", "processing"];

export function LiveTranscript({
  meetingId,
  initialSegments,
  initialStatus
}: {
  meetingId: string;
  initialSegments: TranscriptSegment[];
  initialStatus: Meeting["status"];
}) {
  const router = useRouter();
  const [segments, setSegments] = useState(initialSegments);
  const [meetingStatus, setMeetingStatus] = useState(initialStatus);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSegments(initialSegments);
  }, [initialSegments]);

  useEffect(() => {
    setMeetingStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (!ACTIVE_STATUSES.includes(meetingStatus)) return;

    let cancelled = false;
    async function refreshTranscriptAndMeeting() {
      setIsRefreshing(true);
      try {
        const response = await fetch(`/api/meetings/${meetingId}/transcript`, {
          method: "GET",
          cache: "no-store"
        });
        if (!response.ok) {
          setError("Unable to refresh transcript right now.");
          return;
        }
        const data = (await response.json()) as {
          segments?: TranscriptSegment[];
          meeting?: { status?: Meeting["status"] };
        };
        if (cancelled) return;
        setSegments(data.segments ?? []);
        if (data.meeting?.status) {
          const nextStatus = data.meeting.status;
          setMeetingStatus(nextStatus);
          window.dispatchEvent(
            new CustomEvent("parfait:meeting-status", {
              detail: { meetingId, status: nextStatus }
            })
          );
          if (nextStatus === "completed" || nextStatus === "failed") {
            router.refresh();
          }
        }
        setError(null);
      } catch {
        if (!cancelled) setError("Network error while loading transcript.");
      } finally {
        if (!cancelled) setIsRefreshing(false);
      }
    }

    void refreshTranscriptAndMeeting();
    const interval = window.setInterval(refreshTranscriptAndMeeting, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [meetingId, meetingStatus, router]);

  return (
    <div className="premium-card space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Transcript Viewer</h2>
        <span className="text-xs text-slate-500">
          {isRefreshing
            ? "Refreshing..."
            : ACTIVE_STATUSES.includes(meetingStatus)
              ? "Auto-refresh every 5s"
              : "Transcript finalized"}
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="max-h-[30rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/80 p-3">
        {segments.length > 0 ? (
          segments.map((segment) => (
            <div
              key={segment.id}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm transition hover:border-brand-200 hover:bg-brand-50/30"
            >
              <p className="text-xs font-medium text-slate-500">
                {segment.speaker ?? "Unknown speaker"} •{" "}
                {new Date(segment.timestamp).toLocaleTimeString()}
              </p>
              <p className="mt-1 text-sm text-slate-800">{segment.text}</p>
            </div>
          ))
        ) : (
          <div className="premium-empty p-6">
            <p className="text-sm font-medium text-slate-700">
              Waiting for transcript...
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Transcript segments will appear here automatically as Recall sends them.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
