"use client";

import { useEffect, useState } from "react";

import type { TranscriptSegment } from "@/lib/types";

export function LiveTranscript({
  meetingId,
  initialSegments
}: {
  meetingId: string;
  initialSegments: TranscriptSegment[];
}) {
  const [segments, setSegments] = useState(initialSegments);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
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
        const data = await response.json();
        setSegments(data.segments ?? []);
        setError(null);
      } catch {
        setError("Network error while loading transcript.");
      } finally {
        setIsRefreshing(false);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [meetingId]);

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Transcript Viewer</h2>
        <span className="text-xs text-slate-500">
          {isRefreshing ? "Refreshing..." : "Auto-refresh every 5s"}
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="max-h-[30rem] space-y-2 overflow-y-auto rounded-lg bg-slate-50 p-3">
        {segments.length > 0 ? (
          segments.map((segment) => (
            <div
              key={segment.id}
              className="rounded-md border border-slate-200 bg-white px-3 py-2.5"
            >
              <p className="text-xs font-medium text-slate-500">
                {segment.speaker_name ?? "Unknown speaker"} •{" "}
                {new Date(segment.started_at).toLocaleTimeString()}
              </p>
              <p className="mt-1 text-sm text-slate-800">{segment.content}</p>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-dashed border-slate-300 bg-white p-4">
            <p className="text-sm text-slate-500">
              Waiting for transcript segments from the meeting bot webhook.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
