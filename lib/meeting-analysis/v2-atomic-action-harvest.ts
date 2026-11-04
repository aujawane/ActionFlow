import type { AtomicActionHarvestModelResult } from "@/lib/execution-intelligence/work-item-model";
import {
  assembleAtomicActionHarvestPass,
  planAtomicActionHarvestWindows,
  requestAtomicActionHarvestWindow,
  type AtomicActionHarvestPassResult
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

export const ATOMIC_ACTION_HARVEST_STAGE = "atomic_action_harvest";
const HARVEST_UNIT_KEY = /^window:(\d{6})$/;
const MAX_WINDOW_INDEX = 999_999;
type V2JobInput = { meetingId: string; jobId: string; generation: number };

type HarvestCheckpoint = Record<string, unknown> & {
  engine?: unknown;
  v4State?: V4ExecutionState;
  gcV2?: Record<string, unknown>;
};

export function atomicActionHarvestUnitKey(windowIndex: number) {
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 0 || windowIndex > MAX_WINDOW_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid atomic action harvest window index ${windowIndex}.`);
  }
  return `window:${String(windowIndex).padStart(6, "0")}`;
}

function parseWindowIndex(unitKey: string) {
  const match = unitKey.match(HARVEST_UNIT_KEY);
  if (!match) throw new AnalysisUnitValidationError(`Unexpected atomic action harvest unit ${unitKey}.`);
  return Number(match[1]);
}

function harvestState(checkpoint: Record<string, unknown> | null | undefined) {
  const value = (checkpoint ?? {}) as HarvestCheckpoint;
  if (value.engine !== "v4") {
    throw new AnalysisUnitValidationError("Durable atomic action harvest requires the v4 engine.");
  }
  if (!value.v4State?.source) {
    throw new AnalysisUnitValidationError("Missing execution graph checkpoint.");
  }
  return { checkpoint: value, v4State: value.v4State };
}

function toUnitResult(result: AtomicActionHarvestModelResult): UnitResult {
  return result as unknown as UnitResult;
}

function parseUnitResult(unit: AnalysisJobUnit): AtomicActionHarvestModelResult {
  const result = unit.result as Record<string, unknown> | null;
  const valid = result !== null && typeof result === "object" && !Array.isArray(result) && (
    result.ok === true ? Array.isArray(result.candidates) : result.ok === false && typeof result.error === "string"
  );
  if (!valid) throw new AnalysisUnitValidationError(`Malformed atomic action harvest unit ${unit.unit_key}.`);
  return result as unknown as AtomicActionHarvestModelResult;
}

/** Restore canonical plan order and require exactly one completed row for every planned window. */
export function orderAtomicActionHarvestUnits(
  expectedKeys: readonly string[],
  units: readonly AnalysisJobUnit[]
) {
  const expected = new Set(expectedKeys);
  const byKey = new Map<string, AtomicActionHarvestModelResult>();
  for (const unit of units) {
    if (!expected.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Unexpected atomic action harvest unit ${unit.unit_key}.`);
    if (byKey.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Duplicate atomic action harvest unit ${unit.unit_key}.`);
    if (unit.status !== "completed") throw new AnalysisUnitValidationError(`Atomic action harvest unit ${unit.unit_key} is not completed.`);
    byKey.set(unit.unit_key, parseUnitResult(unit));
  }
  return expectedKeys.map((key) => {
    const result = byKey.get(key);
    if (!result) throw new AnalysisUnitValidationError(`Missing atomic action harvest unit ${key}.`);
    return result;
  });
}

const planDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) => Promise<Pick<MeetingAnalysisJob, "checkpoint">>,
  markRunning: markV2StageRunning
};
export type V2AtomicActionHarvestPlanDeps = typeof planDeps;

export async function planV2AtomicActionHarvest(
  input: V2JobInput,
  attempt: number,
  deps: V2AtomicActionHarvestPlanDeps = planDeps
) {
  const job = await deps.validate(input);
  const { v4State } = harvestState(job.checkpoint);
  const windows = planAtomicActionHarvestWindows(v4State.source);
  await deps.markRunning({ jobId: input.jobId, stage: ATOMIC_ACTION_HARVEST_STAGE, attempt });
  return { units: windows.map((window) => ({ unitKey: atomicActionHarvestUnitKey(window.index) })) };
}

const unitDeps = {
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  loadJob: getMeetingAnalysisJob,
  request: requestAtomicActionHarvestWindow
};
export type V2AtomicActionHarvestUnitDeps = typeof unitDeps;

/** One window, one model call, one unit-row write. Completed rows bypass checkpoint/model work. */
export async function runV2AtomicActionHarvestUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2AtomicActionHarvestUnitDeps = unitDeps
) {
  const windowIndex = parseWindowIndex(input.unitKey);
  const result = await deps.execute(
    { ...input, stage: ATOMIC_ACTION_HARVEST_STAGE },
    attempt,
    async () => {
      const job = await deps.loadJob(input.jobId);
      const { v4State } = harvestState(job?.checkpoint);
      const window = planAtomicActionHarvestWindows(v4State.source).find((item) => item.index === windowIndex);
      if (!window) throw new AnalysisUnitValidationError(`Unexpected atomic action harvest unit ${input.unitKey}.`);
      return toUnitResult(await deps.request({ source: v4State.source, window }));
    },
    deps.persistence
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

const finalizeDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) =>
    Promise<Pick<MeetingAnalysisJob, "checkpoint" | "pipeline_version">>,
  markRunning: markV2StageRunning,
  markFailed: markV2AnalysisFailed,
  listUnits: listAnalysisStageUnits,
  saveCheckpoint: saveV2Checkpoint
};
export type V2AtomicActionHarvestFinalizeDeps = typeof finalizeDeps;

export async function finalizeV2AtomicActionHarvest(
  input: V2JobInput,
  attempt: number,
  deps: V2AtomicActionHarvestFinalizeDeps = finalizeDeps
) {
  const job = await deps.validate(input);
  const { checkpoint, v4State } = harvestState(job.checkpoint);
  await deps.markRunning({ jobId: input.jobId, stage: ATOMIC_ACTION_HARVEST_STAGE, attempt });
  const windows = planAtomicActionHarvestWindows(v4State.source);
  const expectedKeys = windows.map((window) => atomicActionHarvestUnitKey(window.index));
  const results = orderAtomicActionHarvestUnits(
    expectedKeys,
    await deps.listUnits(input.jobId, ATOMIC_ACTION_HARVEST_STAGE)
  );
  const latencyMs = results.reduce((total, result) => total + (Number(result.latencyMs) || 0), 0);
  const harvest = assembleAtomicActionHarvestPass({ source: v4State.source, windows, results, latencyMs });
  if (!harvest.ok) {
    const message = `v4_completeness_recovery: ${harvest.details ? `${harvest.error}: ${harvest.details}` : harvest.error}`;
    await deps.markFailed({
      ...input,
      error: message,
      stage: ATOMIC_ACTION_HARVEST_STAGE,
      progress: ANALYSIS_STAGES.atomic_action_harvest.progress
    });
    throw new V2StageFailedError(message);
  }
  const currentGcV2 = checkpoint.gcV2 && typeof checkpoint.gcV2 === "object" && !Array.isArray(checkpoint.gcV2)
    ? checkpoint.gcV2
    : {};
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, checkpoint, { gcV2: { ...currentGcV2, harvest } })
  });
  return { windows: windows.length, candidates: harvest.candidates.length };
}

export type SuccessfulAtomicActionHarvest = Extract<AtomicActionHarvestPassResult, { ok: true }>;
