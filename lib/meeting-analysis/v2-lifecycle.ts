import { CHECKPOINT_VERSION, V2_TOPOLOGY, saveV2Checkpoint } from "@/lib/meeting-analysis/checkpoint";
import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import { markAnalysisJobRunning, type AnalysisStageKey } from "@/lib/meeting-analysis/jobs";
import { assertV2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingAnalysisJob } from "@/lib/types";

type V2JobInput = { meetingId: string; jobId: string; generation: number };

const topologyDeps = {
  validate: assertV2AnalysisJob as (input: V2JobInput) => Promise<Pick<MeetingAnalysisJob, "checkpoint">>,
  save: saveV2Checkpoint
};
export type V2TopologyDeps = typeof topologyDeps;

/**
 * First step of every B2 workflow run, before any model work: stamps checkpoint.v2Topology.
 * Only a freshly claimed job (checkpoint is exactly `{ checkpointVersion: 2 }`) can adopt it, so
 * a B1-era v2 job that already has stage output is never retrofitted. Idempotent on retry.
 */
export async function initializeV2Topology(input: V2JobInput, deps: V2TopologyDeps = topologyDeps) {
  const job = await deps.validate(input);
  const checkpoint = job.checkpoint ?? {};
  if (checkpoint.v2Topology === V2_TOPOLOGY) return { initialized: false };
  if (Object.keys(checkpoint).some((key) => key !== "checkpointVersion")) {
    throw new AnalysisUnitValidationError("Only a freshly claimed v2 job can adopt the B2 topology.");
  }
  await deps.save({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: { checkpointVersion: CHECKPOINT_VERSION, v2Topology: V2_TOPOLOGY }
  });
  return { initialized: true };
}

/** Workflow-level terminal handling for any error that escapes a v2 step. A superseded (stale) or
 * already terminal job matches no row, so this never overwrites stale/completed/failed. */
export async function markV2AnalysisFailed(input: V2JobInput & { error: string }) {
  const { error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .update({
      status: "failed",
      current_stage: "failed",
      progress: 100,
      error: input.error,
      completed_at: new Date().toISOString()
    })
    .eq("id", input.jobId)
    .eq("generation", input.generation)
    .eq("pipeline_version", 2)
    .in("status", ["queued", "running"]);
  if (error) throw new Error(error.message);
}

/** SDK attempts are one-based; retry_count is attempt - 1. For v2 jobs the B0 trigger keeps the
 * stored value monotonic, so a lower value from another step never decreases it. */
export function retryCountFromAttempt(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new AnalysisUnitValidationError("Workflow attempt must be a positive one-based integer.");
  }
  return attempt - 1;
}

/** For future B2 plan/finalizer steps (units persist retry_count through the unit RPCs). */
export async function markV2StageRunning(input: { jobId: string; stage: AnalysisStageKey; attempt: number }) {
  await markAnalysisJobRunning({
    jobId: input.jobId,
    stage: input.stage,
    retryCount: retryCountFromAttempt(input.attempt)
  });
}
