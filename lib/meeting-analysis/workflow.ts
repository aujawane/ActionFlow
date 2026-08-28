import { ANALYSIS_STAGE_ORDER } from "@/lib/meeting-analysis/jobs";
import { runAnalysisStageStep } from "@/lib/meeting-analysis/workflow-steps";

/**
 * Durable orchestrator for a meeting's analysis job, replacing the previous
 * after() + same-origin HTTP self-dispatch chain (which Vercel's platform-level loop detector
 * eventually rejects with 508 INFINITE_LOOP_DETECTED -- see docs/meeting-analysis-orchestration
 * if present, or the commit that introduced this file). The Workflow SDK persists this function's
 * progress after every step and resumes it durably; no HTTP request to our own API is made
 * between stages.
 *
 * Preserves the exact existing stage sequence and semantics -- this function only "stitches
 * together" runAnalysisStageStep() calls in order; every actual piece of Execution Intelligence
 * V4 business logic still lives in runMeetingAnalysisStage() and is unchanged.
 */
export async function meetingAnalysisWorkflow(input: {
  meetingId: string;
  jobId: string;
  generation: number;
}) {
  "use workflow";

  console.info("[meeting-analysis-workflow] job start", {
    job_id: input.jobId,
    meeting_id: input.meetingId,
    generation: input.generation
  });

  for (const stage of ANALYSIS_STAGE_ORDER) {
    // A FatalError thrown by runAnalysisStageStep (stage failure or stale generation) propagates
    // out of this loop and fails the workflow run -- the job's own terminal status
    // (failed/stale) was already persisted inside the step, so nothing further to do here.
    await runAnalysisStageStep({ ...input, stage });
  }

  console.info("[meeting-analysis-workflow] job complete", {
    job_id: input.jobId,
    meeting_id: input.meetingId,
    generation: input.generation
  });
}
