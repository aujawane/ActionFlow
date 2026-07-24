import { after } from "next/server";

import {
  ANALYSIS_STAGE_ORDER,
  claimMeetingAnalysisJob,
  markAnalysisJobDispatchFailed
} from "@/lib/meeting-analysis/jobs";
import type { MeetingAnalysisJobStatus } from "@/lib/types";
import { getAppBaseUrl, requireEnv } from "@/lib/env";

export type EnqueueAnalysisResult =
  | {
      ok: true;
      jobId: string;
      generation: number;
      status: Extract<MeetingAnalysisJobStatus, "queued">;
    }
  | { ok: false; error: string; details?: string };

type ClaimJob = (meetingId: string) => Promise<
  | { ok: true; jobId: string; generation: number }
  | { ok: false; error: string; details?: string }
>;

type StartWorker = (
  meetingId: string,
  jobId: string,
  generation: number
) => Promise<unknown>;

type MarkDispatchFailed = (input: { jobId: string; error: string }) => Promise<void>;

async function defaultStartWorker(
  meetingId: string,
  jobId: string,
  generation: number,
  requestOrigin?: string
) {
  const internalSecret = requireEnv("RECALL_WEBHOOK_SECRET");
  const baseUrl = getAppBaseUrl({ requestOrigin });
  const response = await fetch(
    `${baseUrl}/api/internal/meeting-analysis/worker`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-parfait-internal-secret": internalSecret
      },
      body: JSON.stringify({
        meetingId,
        jobId,
        generation,
        stage: ANALYSIS_STAGE_ORDER[0]
      })
    }
  );

  if (!response.ok && response.status !== 409) {
    const text = await response.text();
    throw new Error(text || `Worker returned HTTP ${response.status}`);
  }
}

/**
 * Claims a generation-scoped analysis job and starts the first worker stage.
 * Kickoff runs via after() so HTTP callers can return 202 immediately.
 */
export async function enqueueMeetingAnalysis(
  meetingId: string,
  options?: {
    claimJob?: ClaimJob;
    startWorkflow?: StartWorker;
    startWorker?: StartWorker;
    markDispatchFailed?: MarkDispatchFailed;
    requestOrigin?: string;
  }
): Promise<EnqueueAnalysisResult> {
  const claimJob = options?.claimJob ?? claimMeetingAnalysisJob;
  const markDispatchFailed =
    options?.markDispatchFailed ?? markAnalysisJobDispatchFailed;
  const startWorker =
    options?.startWorker ??
    options?.startWorkflow ??
    ((id, jobId, generation) =>
      defaultStartWorker(id, jobId, generation, options?.requestOrigin));

  const claimed = await claimJob(meetingId);
  if (!claimed.ok) {
    return claimed;
  }

  const kickoff = async () => {
    try {
      await startWorker(meetingId, claimed.jobId, claimed.generation);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start analysis worker.";
      console.warn("[meeting-analysis] Worker kickoff failed", {
        meeting_id: meetingId,
        job_id: claimed.jobId,
        error: message
      });
      await markDispatchFailed({
        jobId: claimed.jobId,
        error: message
      });
    }
  };

  try {
    after(() => kickoff());
  } catch {
    // outside a request context (tests), run immediately without blocking return
    void kickoff();
  }

  return {
    ok: true,
    jobId: claimed.jobId,
    generation: claimed.generation,
    status: "queued"
  };
}
