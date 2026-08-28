import { after } from "next/server";
import { start } from "workflow/api";

import {
  claimMeetingAnalysisJob,
  markAnalysisJobDispatchFailed
} from "@/lib/meeting-analysis/jobs";
import { meetingAnalysisWorkflow } from "@/lib/meeting-analysis/workflow";
import type { MeetingAnalysisJobStatus } from "@/lib/types";

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

/**
 * Starts the durable Workflow SDK run for this job. Unlike the previous implementation, this
 * makes no HTTP request to our own API at all -- start() enqueues the run through Vercel Queues,
 * which is what eliminates the same-origin recursive self-dispatch that eventually tripped
 * Vercel's INFINITE_LOOP_DETECTED protection (see lib/meeting-analysis/workflow.ts).
 */
async function defaultStartWorkflow(meetingId: string, jobId: string, generation: number) {
  await start(meetingAnalysisWorkflow, [{ meetingId, jobId, generation }]);
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
    /** No longer used -- start() doesn't make an HTTP request to our own app, so there's no
     * self-request URL to build. Kept so existing callers (recall webhook, sync-status) don't
     * need an unrelated signature change. */
    requestOrigin?: string;
  }
): Promise<EnqueueAnalysisResult> {
  const claimJob = options?.claimJob ?? claimMeetingAnalysisJob;
  const markDispatchFailed =
    options?.markDispatchFailed ?? markAnalysisJobDispatchFailed;
  const startWorker = options?.startWorker ?? options?.startWorkflow ?? defaultStartWorkflow;

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
