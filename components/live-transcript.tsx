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

  useEffect(() => {
    const interval = setInterval(async () => {
      const response = await fetch(`/api/meetings/${meetingId}/transcript`, {
        method: "GET",
        cache: "no-store"
      });
      if (!response.ok) return;
      const data = await response.json();
      setSegments(data.segments ?? []);
    }, 5000);

    return () => clearInterval(interval);
  }, [meetingId]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">
        Transcript (auto-refresh every 5s)
      </h2>
      <div className="max-h-[26rem] space-y-2 overflow-y-auto rounded-md bg-slate-50 p-3">
        {segments.length > 0 ? (
          segments.map((segment) => (
            <div
              key={segment.id}
              className="rounded-md border border-slate-200 bg-white px-3 py-2"
            >
              <p className="text-xs font-medium text-slate-500">
                {segment.speaker_name ?? "Unknown speaker"} -{" "}
                {new Date(segment.started_at).toLocaleTimeString()}
              </p>
              <p className="mt-1 text-sm text-slate-800">{segment.content}</p>
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">
            Waiting for transcript segments from Recall webhook...
          </p>
        )}
      </div>
    </div>
  );
}
