import type { CompletenessAdjudicationModelResult } from "@/lib/execution-intelligence/work-item-model";
import {
  assembleCompletenessAdjudicationWaves,
  assembleCompletenessPrimaryState,
  assembleCompletenessRecoveryAfterAdjudication,
  planCompletenessAdjudicationBatches,
  requestCompletenessAdjudicationBatch,
  type AtomicActionHarvestPassResult,
  type CompletenessPrimaryState,
  type CompletenessRecoveryPassResult
} from "@/lib/execution-intelligence/work-item-stages";
import type { V4ExecutionState } from "@/lib/execution-intelligence/v4-pipeline";
import { saveV2Checkpoint, stageCheckpoint } from "@/lib/meeting-analysis/checkpoint";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  type AnalysisJobUnit,
  type UnitResult
} from "@/lib/meeting-analysis/job-units";
import { ANALYSIS_STAGES, getMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import { markV2AnalysisFailed, markV2StageRunning, V2StageFailedError } from "@/lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "@/lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import type { MeetingAnalysisJob } from "@/lib/types";

export const COMPLETENESS_PRIMARY_STAGE = "completeness_adjudication";
export const COMPLETENESS_COVERAGE_STAGE = "completeness_coverage";
const PRIMARY_KEY = /^batch:(\d{6})$/;
const COVERAGE_KEY = /^retry:(\d{6})$/;
const MAX_UNIT_INDEX = 999_999;
type V2JobInput = { meetingId: string; jobId: string; generation: number };
type SuccessfulHarvest = Extract<AtomicActionHarvestPassResult, { ok: true }>;
type SuccessfulCompleteness = Extract<CompletenessRecoveryPassResult, { ok: true }>;

type CompletenessCheckpoint = Record<string, unknown> & {
  engine?: unknown;
  v4State?: V4ExecutionState;
  gcV2?: {
    harvest?: SuccessfulHarvest;
    completeness?: {
      primary?: CompletenessPrimaryState;
      final?: SuccessfulCompleteness;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

function unitKey(prefix: "batch" | "retry", index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_UNIT_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid completeness ${prefix} index ${index}.`);
  }
  return `${prefix}:${String(index).padStart(6, "0")}`;
}

export const completenessPrimaryUnitKey = (index: number) => unitKey("batch", index);
export const completenessCoverageUnitKey = (index: number) => unitKey("retry", index);

function parseKey(value: string, kind: "primary" | "coverage") {
  const match = value.match(kind === "primary" ? PRIMARY_KEY : COVERAGE_KEY);
  if (!match) throw new AnalysisUnitValidationError(`Unexpected completeness ${kind} unit ${value}.`);
  return Number(match[1]);
}

function completenessCheckpoint(checkpoint: Record<string, unknown> | null | undefined) {
  const value = (checkpoint ?? {}) as CompletenessCheckpoint;
  if (value.engine !== "v4") throw new AnalysisUnitValidationError("Durable completeness requires the v4 engine.");
  if (!value.v4State?.source) throw new AnalysisUnitValidationError("Missing execution graph checkpoint.");
  const harvest = value.gcV2?.harvest;
  if (!harvest || harvest.ok !== true || !Array.isArray(harvest.candidates)) {
    throw new AnalysisUnitValidationError("Missing atomic action harvest checkpoint.");
  }
  return { checkpoint: value, v4State: value.v4State, harvest };
}

function primaryCheckpoint(checkpoint: Record<string, unknown> | null | undefined) {
  const state = completenessCheckpoint(checkpoint);
  const primary = state.checkpoint.gcV2?.completeness?.primary;
  if (!primary || !Array.isArray(primary.batches) || !Array.isArray(primary.coveragePlan)) {
    throw new AnalysisUnitValidationError("Missing completeness primary checkpoint.");
  }
  return { ...state, primary };
}

function toUnitResult(result: CompletenessAdjudicationModelResult): UnitResult {
  return result as unknown as UnitResult;
}

function parseUnitResult(unit: AnalysisJobUnit, kind: "primary" | "coverage") {
  const result = unit.result as Record<string, unknown> | null;
  const valid = result !== null && typeof result === "object" && !Array.isArray(result) && (
    result.ok === true ? Array.isArray(result.decisions) : result.ok === false && typeof result.error === "string"
  );
  if (!valid) throw new AnalysisUnitValidationError(`Malformed completeness ${kind} unit ${unit.unit_key}.`);
  return result as unknown as CompletenessAdjudicationModelResult;
}

export function orderCompletenessUnits(
  expectedKeys: readonly string[],
  units: readonly AnalysisJobUnit[],
  kind: "primary" | "coverage"
) {
  const expected = new Set(expectedKeys);
  const byKey = new Map<string, CompletenessAdjudicationModelResult>();
  for (const unit of units) {
    if (!expected.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Unexpected completeness ${kind} unit ${unit.unit_key}.`);
    if (byKey.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Duplicate completeness ${kind} unit ${unit.unit_key}.`);
    if (unit.status !== "completed") throw new AnalysisUnitValidationError(`Completeness ${kind} unit ${unit.unit_key} is not completed.`);
    byKey.set(unit.unit_key, parseUnitResult(unit, kind));
  }
  return expectedKeys.map((key) => {
    const result = byKey.get(key);
    if (!result) throw new AnalysisUnitValidationError(`Missing completeness ${kind} unit ${key}.`);
    return result;
  });
}

const planDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) => Promise<Pick<MeetingAnalysisJob, "checkpoint">>,
  markRunning: markV2StageRunning
};
export type V2CompletenessPlanDeps = typeof planDeps;

export async function planV2CompletenessPrimary(
  input: V2JobInput,
  attempt: number,
  deps: V2CompletenessPlanDeps = planDeps
) {
  const job = await deps.validate(input);
  const { harvest } = completenessCheckpoint(job.checkpoint);
  const plan = planCompletenessAdjudicationBatches(harvest.candidates);
  await deps.markRunning({ jobId: input.jobId, stage: COMPLETENESS_PRIMARY_STAGE, attempt });
  return { units: plan.map((batch) => ({ unitKey: completenessPrimaryUnitKey(batch.batchIndex) })) };
}

const unitDeps = {
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  loadJob: getMeetingAnalysisJob,
  request: requestCompletenessAdjudicationBatch
};
export type V2CompletenessUnitDeps = typeof unitDeps;

export async function runV2CompletenessPrimaryUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2CompletenessUnitDeps = unitDeps
) {
  const batchIndex = parseKey(input.unitKey, "primary");
  const result = await deps.execute(
    { ...input, stage: COMPLETENESS_PRIMARY_STAGE },
    attempt,
    async () => {
      const job = await deps.loadJob(input.jobId);
      const { harvest, v4State } = completenessCheckpoint(job?.checkpoint);
      const batch = planCompletenessAdjudicationBatches(harvest.candidates)
        .find((descriptor) => descriptor.batchIndex === batchIndex);
      if (!batch) throw new AnalysisUnitValidationError(`Unexpected completeness primary unit ${input.unitKey}.`);
      return toUnitResult(await deps.request({
        source: v4State.source,
        existingWorkItems: v4State.mergedWorkItems,
        candidates: harvest.candidates,
        refs: batch.candidateRefs
      }));
    },
    deps.persistence
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

const barrierDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) =>
    Promise<Pick<MeetingAnalysisJob, "checkpoint" | "pipeline_version">>,
  markRunning: markV2StageRunning,
  markFailed: markV2AnalysisFailed,
  listUnits: listAnalysisStageUnits,
  saveCheckpoint: saveV2Checkpoint
};
export type V2CompletenessBarrierDeps = typeof barrierDeps;

export async function finalizeV2CompletenessPrimary(
  input: V2JobInput,
  attempt: number,
  deps: V2CompletenessBarrierDeps = barrierDeps
) {
  const job = await deps.validate(input);
  const { checkpoint, harvest } = completenessCheckpoint(job.checkpoint);
  await deps.markRunning({ jobId: input.jobId, stage: COMPLETENESS_PRIMARY_STAGE, attempt });
  const plan = planCompletenessAdjudicationBatches(harvest.candidates);
  const results = orderCompletenessUnits(
    plan.map((batch) => completenessPrimaryUnitKey(batch.batchIndex)),
    await deps.listUnits(input.jobId, COMPLETENESS_PRIMARY_STAGE),
    "primary"
  );
  const latencyMs = results.reduce((total, result) => total + (Number(result.latencyMs) || 0), 0);
  const primary = assembleCompletenessPrimaryState({ plan, results, latencyMs });
  if (!("batches" in primary)) {
    const message = `v4_completeness_recovery: ${primary.details ? `${primary.error}: ${primary.details}` : primary.error}`;
    await deps.markFailed({ ...input, error: message, stage: COMPLETENESS_PRIMARY_STAGE,
      progress: ANALYSIS_STAGES.completeness_adjudication.progress });
    throw new V2StageFailedError(message);
  }
  const gcV2 = checkpoint.gcV2 ?? { harvest };
  const completeness = gcV2.completeness ?? {};
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, checkpoint, {
      gcV2: { ...gcV2, completeness: { ...completeness, primary } }
    })
  });
  return {
    units: primary.coveragePlan.map((descriptor) => ({
      unitKey: completenessCoverageUnitKey(descriptor.retryIndex)
    }))
  };
}

export async function runV2CompletenessCoverageUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2CompletenessUnitDeps = unitDeps
) {
  const retryIndex = parseKey(input.unitKey, "coverage");
  const result = await deps.execute(
    { ...input, stage: COMPLETENESS_COVERAGE_STAGE },
    attempt,
    async () => {
      const job = await deps.loadJob(input.jobId);
      const { harvest, primary, v4State } = primaryCheckpoint(job?.checkpoint);
      const retry = primary.coveragePlan.find((descriptor) => descriptor.retryIndex === retryIndex);
      if (!retry) throw new AnalysisUnitValidationError(`Unexpected completeness coverage unit ${input.unitKey}.`);
      return toUnitResult(await deps.request({
        source: v4State.source,
        existingWorkItems: v4State.mergedWorkItems,
        candidates: harvest.candidates,
        refs: retry.candidateRefs
      }));
    },
    deps.persistence
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

export async function finalizeV2Completeness(
  input: V2JobInput,
  attempt: number,
  deps: V2CompletenessBarrierDeps = barrierDeps
) {
  const job = await deps.validate(input);
  const { checkpoint, harvest, primary, v4State } = primaryCheckpoint(job.checkpoint);
  await deps.markRunning({ jobId: input.jobId, stage: COMPLETENESS_COVERAGE_STAGE, attempt });
  const results = orderCompletenessUnits(
    primary.coveragePlan.map((descriptor) => completenessCoverageUnitKey(descriptor.retryIndex)),
    await deps.listUnits(input.jobId, COMPLETENESS_COVERAGE_STAGE),
    "coverage"
  );
  const coverageLatencyMs = results.reduce((total, result) => total + (Number(result.latencyMs) || 0), 0);
  const adjudication = assembleCompletenessAdjudicationWaves({
    primary,
    coverageResults: results,
    latencyMs: primary.latencyMs + coverageLatencyMs
  });
  const final = assembleCompletenessRecoveryAfterAdjudication({
    source: v4State.source,
    workItems: v4State.mergedWorkItems,
    harvest,
    adjudication,
    latencyMs: harvest.latencyMs + adjudication.latencyMs
  });
  const gcV2 = checkpoint.gcV2!;
  const completeness = gcV2.completeness ?? {};
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, checkpoint, {
      gcV2: { ...gcV2, completeness: { ...completeness, final } }
    })
  });
  return { additions: final.additions.length, missingAfterRetry: final.missingCandidateRefsAfterRetry.length };
}
