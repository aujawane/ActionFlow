"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { MeetingAnalysisJob, MeetingAnalysisJobStatus } from "@/lib/types";

type AnalysisStatusResponse = {
  meetingId: string;
  meetingStatus: string;
  job: Pick<
    MeetingAnalysisJob,
    | "id"
    | "generation"
    | "status"
    | "current_stage"
    | "progress"
    | "error"
    | "retry_count"
    | "started_at"
    | "completed_at"
    | "created_at"
    | "updated_at"
  > | null;
};

const ACTIVE_JOB_STATUSES: MeetingAnalysisJobStatus[] = ["queued", "running"];

function formatStage(stage: string) {
  return stage.replaceAll("_", " ");
}

export function MeetingAnalysisStatusPanel({
  meetingId,
  meetingStatus,
  initialJob,
  segmentCount
}: {
  meetingId: string;
  meetingStatus: string;
  initialJob: MeetingAnalysisJob | null;
  segmentCount: number;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState<string | null>(null);
  const refreshedForJobId = useRef<string | null>(null);

  useEffect(() => {
    setJob(initialJob);
  }, [initialJob]);

  useEffect(() => {
    const jobStatus = job?.status ?? null;
    const shouldPoll =
      ACTIVE_JOB_STATUSES.includes(jobStatus ?? "queued") ||
      (meetingStatus === "transcript_ready" && !jobStatus);

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    async function refreshStatus() {
      try {
        const response = await fetch(`/api/meetings/${meetingId}/analysis-status`, {
          method: "GET",
          cache: "no-store"
        });
        if (!response.ok) {
          if (!cancelled) setError("Unable to refresh analysis status.");
          return;
        }
        const data = (await response.json()) as AnalysisStatusResponse;
        if (cancelled) return;
        setJob(data.job as MeetingAnalysisJob | null);
        setError(null);

        if (
          data.job?.status === "completed" &&
          refreshedForJobId.current !== data.job.id
        ) {
          refreshedForJobId.current = data.job.id;
          router.refresh();
        }
      } catch {
        if (!cancelled) setError("Network error while loading analysis status.");
      }
    }

    void refreshStatus();
    const interval = window.setInterval(refreshStatus, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // Poll while the latest known job is queued/running (or transcript is ready
    // with no job yet). Intentionally omit the full job object to avoid resetting
    // the interval on every poll response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, meetingId, meetingStatus, router]);

  const status = job?.status ?? null;
  const showTranscriptReady =
    meetingStatus === "transcript_ready" ||
    (segmentCount > 0 && (status === "queued" || status === "running" || !status));

  if (!showTranscriptReady && !job) {
    return null;
  }

  return (
    <div className="premium-card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Analysis Status</h2>
        <p className="text-xs text-slate-500">
          Transcript sync and analysis run independently. Analysis may take several
          minutes for long meetings.
        </p>
      </div>

      {meetingStatus === "transcript_ready" && (!status || status === "queued") ? (
        <p className="rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-800">
          Transcript is ready{segmentCount > 0 ? ` (${segmentCount} segments)` : ""}.
          Analysis is queued in the background.
        </p>
      ) : null}

      {status === "running" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span className="capitalize">{formatStage(job?.current_stage ?? "running")}</span>
            <span>{job?.progress ?? 0}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${Math.max(5, job?.progress ?? 0)}%` }}
            />
          </div>
          {(job?.retry_count ?? 0) > 0 ? (
            <p className="text-xs text-amber-700">
              Retrying stage (attempt {job!.retry_count + 1}).
            </p>
          ) : null}
        </div>
      ) : null}

      {status === "queued" && meetingStatus !== "transcript_ready" ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Analysis queued. Waiting for a worker.
        </p>
      ) : null}

      {status === "completed" ? (
        <p className="rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-800">
          Analysis completed. Commitments and tasks are up to date.
        </p>
      ) : null}

      {status === "failed" ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p className="font-medium">Analysis failed.</p>
          {job?.error ? <p className="mt-1">{job.error}</p> : null}
          <p className="mt-1">Use Analyze Meeting to retry with a new generation.</p>
        </div>
      ) : null}

      {status === "stale" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This analysis run was superseded by a newer request.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
