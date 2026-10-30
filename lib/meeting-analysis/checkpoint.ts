import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingAnalysisJob } from "@/lib/types";

/** Canonical checkpoint ownership. Only stage coordinators/finalizers call these; durable
 * fan-out units (job-units.ts, v2-unit-execution.ts) never write the job checkpoint. */
export const CHECKPOINT_VERSION = 2;
/** Workflow topology marker for pipeline v2 runs started by B2 code. pipeline_version stays 2;
 * B1-era v2 jobs never carry it, so B2-only plans/units/finalizers can reject them. */
export const V2_TOPOLOGY = "b2";

/** Keys no stage may replace or remove through stageCheckpoint. */
const PROTECTED_KEYS = new Set(["checkpointVersion", "v2Topology"]);

export type AnalysisCheckpointRecord = Record<string, unknown>;

/**
 * Builds the checkpoint a stage writes.
 *
 * Pipeline v1: returns `owned` unchanged -- exactly the literal v1 has always written, including
 * its replacement of keys it does not name.
 *
 * Pipeline v2: `{ ...current, ...owned, checkpointVersion: 2 }`, minus the explicitly listed
 * `remove` keys. Unknown keys, normalization and v2Topology survive; only the stage-owned keys
 * change. Neither input is mutated.
 */
export function stageCheckpoint(
  job: Pick<MeetingAnalysisJob, "pipeline_version">,
  current: AnalysisCheckpointRecord | null | undefined,
  owned: AnalysisCheckpointRecord,
  options: { remove?: readonly string[] } = {}
): AnalysisCheckpointRecord {
  const remove = options.remove ?? [];
  for (const key of remove) {
    if (PROTECTED_KEYS.has(key)) {
      throw new AnalysisUnitValidationError(`Checkpoint key ${key} is not stage-owned.`);
    }
  }
  // A spread of the current checkpoint (`{ ...checkpoint, normalization }`) carries protected keys
  // through unchanged; a stage may never set or change them.
  for (const key of Object.keys(owned)) {
    if (PROTECTED_KEYS.has(key) && owned[key] !== current?.[key]) {
      throw new AnalysisUnitValidationError(`Checkpoint key ${key} is not stage-owned.`);
    }
  }
  if (job.pipeline_version !== 2) {
    if (remove.length > 0) throw new AnalysisUnitValidationError("Checkpoint key removal is v2-only.");
    return owned;
  }
  if (current?.checkpointVersion !== CHECKPOINT_VERSION) {
    throw new AnalysisUnitValidationError("V2 checkpoint is missing checkpointVersion 2.");
  }
  const next: AnalysisCheckpointRecord = { ...current, ...owned, checkpointVersion: CHECKPOINT_VERSION };
  for (const key of remove) delete next[key];
  return next;
}

/** Generation-guarded canonical v2 checkpoint write: a superseded, terminal, stale, or non-v2 job
 * matches zero rows and nothing is written. */
export async function saveV2Checkpoint(input: {
  jobId: string;
  generation: number;
  checkpoint: AnalysisCheckpointRecord;
}) {
  if (input.checkpoint.checkpointVersion !== CHECKPOINT_VERSION) {
    throw new AnalysisUnitValidationError("V2 checkpoint writes must keep checkpointVersion 2.");
  }
  const { data, error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .update({ checkpoint: input.checkpoint })
    .eq("id", input.jobId)
    .eq("generation", input.generation)
    .eq("pipeline_version", 2)
    .in("status", ["queued", "running"])
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length !== 1) throw new AnalysisUnitValidationError("Stale analysis generation.");
}

/** Pure B2 compatibility check. B1-era v2 jobs (no v2Topology) are rejected. */
export function validateB2Topology(job: Pick<MeetingAnalysisJob, "pipeline_version" | "checkpoint">) {
  if (job.pipeline_version !== 2 || job.checkpoint?.checkpointVersion !== CHECKPOINT_VERSION) {
    throw new AnalysisUnitValidationError("B2 step requires pipeline/checkpoint version 2.");
  }
  if (job.checkpoint?.v2Topology !== V2_TOPOLOGY) {
    throw new AnalysisUnitValidationError("Analysis job was not started by the B2 v2 topology.");
  }
}
