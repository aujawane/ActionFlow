import { createHash } from "node:crypto";

import { isTranscriptNormalizationEnabled } from "@/lib/env";
import type { TranscriptNormalizationModelResult } from "@/lib/execution-intelligence/work-item-model";
import { saveV2Checkpoint, stageCheckpoint } from "@/lib/meeting-analysis/checkpoint";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  loadCompletedAnalysisUnit,
  type AnalysisJobUnit,
  type UnitResult
} from "@/lib/meeting-analysis/job-units";
import {
  applyNormalizationBatchResult,
  buildNormalizationPatches,
  buildNormalizationPlan,
  createNormalizationMerge,
  finishNormalization,
  loadNormalizationInput,
  loadOrderedTranscriptSegments,
  requestNormalizationBatch,
  SKIPPED_DISABLED,
  type NormalizationPlan,
  type NormalizationStageResult,
  type SegmentPersistencePatch
} from "@/lib/meeting-analysis/normalization";
import { markV2StageRunning } from "@/lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "@/lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingAnalysisJob, ProjectVocabularyTerm, TranscriptSegment } from "@/lib/types";

/** Pipeline-v2 (B2) transcript_normalization: durable plan -> one durable unit per batch -> one
 * finalizer. Units persist only meeting_analysis_job_units. Only finalizeV2Normalization writes
 * transcript_segments and the job checkpoint (checkpoint.normalization). */
export const NORMALIZATION_STAGE = "transcript_normalization";
export const NORMALIZATION_PLAN_STAGE = "transcript_normalization_plan";
export const NORMALIZATION_PLAN_UNIT_KEY = "plan:000000";
const MAX_BATCH_INDEX = 999_999;
const BATCH_UNIT_KEY = /^batch:(\d{6})$/;

type V2JobInput = { meetingId: string; jobId: string; generation: number };

export function normalizationUnitKey(batchIndex: number) {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex > MAX_BATCH_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid normalization batch index ${batchIndex}.`);
  }
  return `batch:${String(batchIndex).padStart(6, "0")}`;
}

export function parseNormalizationUnitKey(unitKey: string) {
  const match = BATCH_UNIT_KEY.exec(unitKey);
  if (!match) throw new AnalysisUnitValidationError(`Unexpected normalization unit ${unitKey}.`);
  return Number(match[1]);
}

/** The durable plan. First-completed-wins, so every unit and the finalizer see one consistent
 * vocabulary snapshot, as v1's single read does. Never holds the transcript. */
export type V2NormalizationPlan =
  | { planVersion: 1; mode: "skipped"; result: NormalizationStageResult }
  | {
      planVersion: 1;
      mode: "batches";
      batchCount: number;
      sourceFingerprint: string;
      meetingDate: string;
      projectId: string | null;
      approvedVocabulary: ProjectVocabularyTerm[];
    };

/** Everything a batch's input is derived from, in canonical order. Excludes the normalized_*
 * columns, so the finalizer's own writes never change it. */
export function normalizationSourceFingerprint(ordered: readonly TranscriptSegment[]) {
  const source = ordered.map((segment) => [segment.id, segment.speaker, segment.participant_name, segment.text, segment.timestamp]);
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** Reads the transcript and vocabulary only: no model call and no transcript write. */
export async function buildV2NormalizationPlan(meetingId: string): Promise<V2NormalizationPlan> {
  if (!isTranscriptNormalizationEnabled()) {
    return { planVersion: 1, mode: "skipped", result: SKIPPED_DISABLED };
  }
  const input = await loadNormalizationInput(meetingId);
  if ("skipped" in input) return { planVersion: 1, mode: "skipped", result: input.skipped };
  return {
    planVersion: 1,
    mode: "batches",
    batchCount: buildNormalizationPlan(input).batches.length,
    sourceFingerprint: normalizationSourceFingerprint(input.ordered),
    meetingDate: input.meetingDate,
    projectId: input.projectId,
    approvedVocabulary: input.approvedVocabulary
  };
}

function parsePlan(value: UnitResult): V2NormalizationPlan {
  const plan = value as unknown as V2NormalizationPlan | null;
  const valid = plan?.planVersion === 1 && (
    plan.mode === "skipped"
      ? typeof plan.result?.status === "string"
      : plan.mode === "batches" && Number.isSafeInteger(plan.batchCount) && plan.batchCount >= 1 &&
        typeof plan.sourceFingerprint === "string" && Array.isArray(plan.approvedVocabulary)
  );
  if (!valid) throw new AnalysisUnitValidationError("Invalid normalization plan.");
  return plan;
}

export async function loadV2NormalizationPlan(input: { jobId: string; generation: number }) {
  const unit = await loadCompletedAnalysisUnit({
    ...input, stage: NORMALIZATION_PLAN_STAGE, unitKey: NORMALIZATION_PLAN_UNIT_KEY
  });
  if (!unit) throw new AnalysisUnitValidationError("Normalization plan unit is not completed.");
  return parsePlan(unit.result);
}

/** Rebuilds v1's exact plan from the stored snapshot. A transcript replaced mid-run would give
 * batches different inputs, so it is rejected rather than merged. */
export function rebuildNormalizationPlan(
  input: V2JobInput,
  stored: Extract<V2NormalizationPlan, { mode: "batches" }>,
  ordered: TranscriptSegment[]
): NormalizationPlan {
  if (normalizationSourceFingerprint(ordered) !== stored.sourceFingerprint) {
    throw new AnalysisUnitValidationError("Transcript changed during normalization.");
  }
  const plan = buildNormalizationPlan({
    meetingId: input.meetingId,
    meetingDate: stored.meetingDate,
    projectId: stored.projectId,
    ordered,
    approvedVocabulary: stored.approvedVocabulary
  });
  if (plan.batches.length !== stored.batchCount) {
    throw new AnalysisUnitValidationError("Normalization batches do not match the plan.");
  }
  return plan;
}

/** Only what the merge needs: never the batch transcript, source or checkpoint. */
function toUnitResult(result: TranscriptNormalizationModelResult): UnitResult {
  if (result.ok) {
    return {
      ok: true, corrections: result.corrections, vocabularyCandidates: result.vocabularyCandidates,
      latencyMs: result.latencyMs, salvagedItems: result.salvagedItems, usage: result.usage
    } as unknown as UnitResult;
  }
  return {
    ok: false,
    error: result.error,
    ...(result.details === undefined ? {} : { details: result.details }),
    latencyMs: result.latencyMs,
    validationFailure: result.validationFailure
  };
}

function parseUnitResult(unit: AnalysisJobUnit): TranscriptNormalizationModelResult {
  const result = unit.result as Record<string, unknown> | null;
  const valid = result !== null && typeof result === "object" && !Array.isArray(result) && (
    result.ok === true
      ? Array.isArray(result.corrections) && Array.isArray(result.vocabularyCandidates)
      : result.ok === false && typeof result.error === "string"
  );
  if (!valid) throw new AnalysisUnitValidationError(`Malformed normalization unit ${unit.unit_key}.`);
  return result as unknown as TranscriptNormalizationModelResult;
}

/** Restores batch order. Every planned batch must be completed exactly once; nothing else may exist. */
export function orderNormalizationUnits(
  batchCount: number,
  units: readonly AnalysisJobUnit[]
): TranscriptNormalizationModelResult[] {
  const byIndex = new Map<number, TranscriptNormalizationModelResult>();
  for (const unit of units) {
    const index = parseNormalizationUnitKey(unit.unit_key);
    if (index >= batchCount) throw new AnalysisUnitValidationError(`Unexpected normalization unit ${unit.unit_key}.`);
    if (byIndex.has(index)) throw new AnalysisUnitValidationError(`Duplicate normalization unit ${unit.unit_key}.`);
    if (unit.status !== "completed") {
      throw new AnalysisUnitValidationError(`Normalization unit ${unit.unit_key} is not completed.`);
    }
    byIndex.set(index, parseUnitResult(unit));
  }
  return Array.from({ length: batchCount }, (_, index) => {
    const result = byIndex.get(index);
    if (!result) throw new AnalysisUnitValidationError(`Missing normalization unit ${normalizationUnitKey(index)}.`);
    return result;
  });
}

const planDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) => Promise<unknown>,
  markRunning: markV2StageRunning,
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  buildPlan: buildV2NormalizationPlan
};
export type V2NormalizationPlanDeps = typeof planDeps;

/** Body of planNormalizationStep: ordered unit keys only, no model call, no transcript write. */
export async function planV2Normalization(input: V2JobInput, attempt: number, deps: V2NormalizationPlanDeps = planDeps) {
  await deps.validate(input);
  await deps.markRunning({ jobId: input.jobId, stage: "transcript_normalization", attempt });
  const plan = parsePlan(await deps.execute(
    { ...input, stage: NORMALIZATION_PLAN_STAGE, unitKey: NORMALIZATION_PLAN_UNIT_KEY },
    attempt,
    async () => (await deps.buildPlan(input.meetingId)) as unknown as UnitResult,
    deps.persistence
  ));
  return {
    mode: plan.mode,
    units: plan.mode === "batches"
      ? Array.from({ length: plan.batchCount }, (_, index) => ({ unitKey: normalizationUnitKey(index) }))
      : []
  };
}

const unitDeps = {
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  loadPlan: loadV2NormalizationPlan,
  loadSegments: loadOrderedTranscriptSegments,
  request: requestNormalizationBatch
};
export type V2NormalizationUnitDeps = typeof unitDeps;

/** Body of runNormalizationUnitStep (one batch, one model request). Writes only its own
 * meeting_analysis_job_units row; a completed unit returns before anything else is read. A handled
 * `{ ok: false }` model result completes the unit (no Workflow retry), as v1 skips that batch. */
export async function runV2NormalizationUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2NormalizationUnitDeps = unitDeps
) {
  const batchIndex = parseNormalizationUnitKey(input.unitKey);
  const result = await deps.execute(
    { ...input, stage: NORMALIZATION_STAGE },
    attempt,
    async () => {
      const stored = await deps.loadPlan(input);
      if (stored.mode !== "batches") throw new AnalysisUnitValidationError("Normalization was skipped by the plan.");
      const plan = rebuildNormalizationPlan(input, stored, await deps.loadSegments(input.meetingId));
      const batch = plan.batches[batchIndex];
      if (!batch) throw new AnalysisUnitValidationError(`Unexpected normalization unit ${input.unitKey}.`);
      return toUnitResult(await deps.request(plan, batch));
    },
    deps.persistence
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

/** Unlike v1, a failed row write throws: the finalizer retries, and patches are repeat-safe. */
async function writeNormalizedSegment(id: string, patch: SegmentPersistencePatch) {
  const { error } = await supabaseAdmin.from("transcript_segments").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

const finalizeDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) =>
    Promise<Pick<MeetingAnalysisJob, "checkpoint" | "pipeline_version">>,
  markRunning: markV2StageRunning,
  loadPlan: loadV2NormalizationPlan,
  loadSegments: loadOrderedTranscriptSegments,
  listUnits: listAnalysisStageUnits,
  writeSegment: writeNormalizedSegment,
  finish: finishNormalization,
  saveCheckpoint: saveV2Checkpoint
};
export type V2NormalizationFinalizeDeps = typeof finalizeDeps;

/**
 * STEP: the only v2 normalization code that writes transcript_segments or the job checkpoint.
 * Applies v1's exact merge in batch order, writes every segment's patch, then saves
 * checkpoint.normalization last. Row writes are per segment (no transactional writer exists), so
 * a kill can leave some rows written; a redelivery rewrites all of them from raw `text`, and the
 * checkpoint is what marks the stage done. Once it exists, a redelivery does nothing.
 */
export async function finalizeV2Normalization(
  input: V2JobInput,
  attempt: number,
  deps: V2NormalizationFinalizeDeps = finalizeDeps
) {
  const job = await deps.validate(input);
  await deps.markRunning({ jobId: input.jobId, stage: "transcript_normalization", attempt });
  const existing = job.checkpoint?.normalization as NormalizationStageResult | undefined;
  if (existing) return { status: existing.status, alreadyFinalized: true };

  const stored = await deps.loadPlan(input);
  let normalization: NormalizationStageResult;
  if (stored.mode === "skipped") {
    normalization = stored.result;
  } else {
    const plan = rebuildNormalizationPlan(input, stored, await deps.loadSegments(input.meetingId));
    const results = orderNormalizationUnits(plan.batches.length, await deps.listUnits(input.jobId, NORMALIZATION_STAGE));
    const merge = createNormalizationMerge();
    plan.batches.forEach((batch, index) => applyNormalizationBatchResult(merge, plan, batch, results[index]));
    const { patches, counts } = buildNormalizationPatches(plan, merge, new Date().toISOString());
    await Promise.all(patches.map(({ id, patch }) => deps.writeSegment(id, patch)));
    normalization = await deps.finish(plan, merge, counts);
  }

  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, job.checkpoint, { normalization })
  });
  return { status: normalization.status, alreadyFinalized: false };
}
