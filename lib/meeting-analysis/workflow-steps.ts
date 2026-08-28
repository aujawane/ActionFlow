import { FatalError } from "workflow";

import {
  ANALYSIS_STAGES,
  markAnalysisJobTerminal,
  StaleAnalysisError,
  type WorkerAnalysisStage
} from "@/lib/meeting-analysis/jobs";
import { runMeetingAnalysisStage } from "@/lib/meeting-analysis/worker";

/** Never logs full error objects/stacks (which can embed request payloads) -- only a short,
 * human-readable message. */
function sanitizedErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Runs exactly one analysis stage as a Workflow SDK step, reusing runMeetingAnalysisStage() --
 * the same stage-execution logic the previous HTTP-recursive worker route called. No V4/stage
 * business logic lives here; this is orchestration/persistence/observability glue only.
 *
 * On a non-stale failure, marks the job terminal (reusing the existing markAnalysisJobTerminal()
 * helper -- runMeetingAnalysisStage() already does this internally for errors raised inside its
 * own stage work, this is a defensive backstop for errors raised before/around that, exactly like
 * the previous route-level fix) and throws FatalError so the Workflow SDK's own step-retry
 * mechanism (default 3 retries) never kicks in. Stage-level retries already happen inside
 * runMeetingAnalysisStage/model.ts; the product's existing retry behavior is "the user starts a
 * fresh generation," not automatic per-stage retries at the orchestration layer, and this repo's
 * failure-persistence fix already assumes exactly one terminal write per failed stage.
 */
export async function runAnalysisStageStep(input: {
  meetingId: string;
  jobId: string;
  generation: number;
  stage: WorkerAnalysisStage;
}) {
  "use step";

  const logContext = {
    job_id: input.jobId,
    meeting_id: input.meetingId,
    generation: input.generation,
    stage: input.stage
  };
  const stageStartedAt = Date.now();
  console.info("[meeting-analysis-workflow] stage start", logContext);

  try {
    const result = await runMeetingAnalysisStage(input);
    console.info("[meeting-analysis-workflow] stage success", {
      ...logContext,
      next_stage: result.nextStage,
      done: result.done,
      elapsed_ms: Date.now() - stageStartedAt
    });
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - stageStartedAt;

    if (error instanceof StaleAnalysisError || (error as Error)?.name === "StaleAnalysisError") {
      // assertAnalysisJobStillCurrent() already persisted status="stale" before throwing --
      // nothing further to mark, and a stale generation must never be reported as "failed" or
      // retried by the workflow.
      console.info("[meeting-analysis-workflow] stage stale", {
        ...logContext,
        elapsed_ms: elapsedMs
      });
      throw new FatalError((error as Error).message);
    }

    const message = sanitizedErrorMessage(error, "Analysis stage failed");
    console.error("[meeting-analysis-workflow] stage failure", {
      ...logContext,
      elapsed_ms: elapsedMs,
      error: message
    });

    try {
      await markAnalysisJobTerminal({
        jobId: input.jobId,
        status: "failed",
        stage: input.stage,
        progress: ANALYSIS_STAGES[input.stage].progress,
        error: message
      });
    } catch (persistError) {
      console.error("[meeting-analysis-workflow] failed to persist terminal failure state", {
        ...logContext,
        persist_error: sanitizedErrorMessage(persistError, "Unknown persistence error")
      });
    }

    throw new FatalError(message);
  }
}
