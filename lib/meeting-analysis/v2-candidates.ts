import { assembleV4WorkItemState } from "@/lib/execution-intelligence/v4-pipeline";
import type { WorkItemExtractionModelResult } from "@/lib/execution-intelligence/work-item-model";
import {
  assembleTopicWorkItemExtraction,
  planTopicWorkItemScopes,
  requestTopicWorkItems,
  type TopicWorkItemScope
} from "@/lib/execution-intelligence/work-item-stages";
import type { ExecutionSourceContext } from "@/lib/execution-intelligence/stages";
import { saveV2Checkpoint, stageCheckpoint } from "@/lib/meeting-analysis/checkpoint";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  type AnalysisJobUnit,
  type UnitResult
} from "@/lib/meeting-analysis/job-units";
import { ANALYSIS_STAGES, getMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import type { PreparedMeetingAnalysis } from "@/lib/meeting-analysis/topics";
import { preparedFromCheckpoint } from "@/lib/meeting-analysis/v2-conversation-events";
import { markV2AnalysisFailed, markV2StageRunning, V2StageFailedError } from "@/lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "@/lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import type { MeetingAnalysisJob } from "@/lib/types";

/** Pipeline-v2 (B2) candidates: scope plan -> one durable unit per topic scope -> one finalizer.
 * Units persist only meeting_analysis_job_units. Only finalizeV2Candidates writes the job
 * checkpoint (v4State). The independent engine keeps the unchanged v1 candidates step. */
export const CANDIDATES_STAGE = "candidates";
export const WHOLE_MEETING_CANDIDATE_UNIT_KEY = "meeting:000000";
const MAX_TOPIC_INDEX = 999_999;
const CANDIDATE_UNIT_KEY = /^(topic|meeting):(\d{6})$/;

type V2JobInput = { meetingId: string; jobId: string; generation: number };
export type V2CandidateUnit = { unitKey: string; scope: TopicWorkItemScope };

export function candidateUnitKey(scope: Pick<TopicWorkItemScope, "topicIndex">) {
  if (scope.topicIndex === null) return WHOLE_MEETING_CANDIDATE_UNIT_KEY;
  if (!Number.isSafeInteger(scope.topicIndex) || scope.topicIndex < 0 || scope.topicIndex > MAX_TOPIC_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid candidate topic index ${scope.topicIndex}.`);
  }
  return `topic:${String(scope.topicIndex).padStart(6, "0")}`;
}

function assertCandidateUnitKey(unitKey: string) {
  if (!CANDIDATE_UNIT_KEY.test(unitKey) || (unitKey.startsWith("meeting:") && unitKey !== WHOLE_MEETING_CANDIDATE_UNIT_KEY)) {
    throw new AnalysisUnitValidationError(`Unexpected candidate unit ${unitKey}.`);
  }
}

/** Pure: v1's exact scopes, in v1's order, with stable keys (topic:{topic_index} or
 * meeting:000000). Skipped empty topics leave gaps; keys stay strictly increasing. */
export function planCandidateUnits(source: ExecutionSourceContext): V2CandidateUnit[] {
  source.topics.forEach((topic, position) => {
    const canonical = (topic as { topic_index?: unknown }).topic_index;
    if (typeof canonical === "number" && canonical !== position) {
      throw new AnalysisUnitValidationError("Prepared topics are not in canonical topic_index order.");
    }
  });
  return planTopicWorkItemScopes(source).map((scope) => ({ unitKey: candidateUnitKey(scope), scope }));
}

/** Barrier: candidates read prepared.source.conversationEvents from the conversation_events
 * finalizer's canonical checkpoint, which is the only writer of that key. */
function assertConversationEventsFinalized(prepared: PreparedMeetingAnalysis) {
  if (!Array.isArray(prepared.source.conversationEvents)) {
    throw new AnalysisUnitValidationError("Conversation events are not finalized.");
  }
}

/** Only what the finalizer needs: never the scope transcript, source, checkpoint or v4State. */
function toUnitResult(result: WorkItemExtractionModelResult): UnitResult {
  if (result.ok) {
    return {
      ok: true, items: result.items, latencyMs: result.latencyMs,
      salvagedItems: result.salvagedItems, usage: result.usage
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

function parseUnitResult(unit: AnalysisJobUnit): WorkItemExtractionModelResult {
  const result = unit.result as Record<string, unknown> | null;
  const valid = result !== null && typeof result === "object" && !Array.isArray(result) && (
    result.ok === true ? Array.isArray(result.items) : result.ok === false && typeof result.error === "string"
  );
  if (!valid) throw new AnalysisUnitValidationError(`Malformed candidate unit ${unit.unit_key}.`);
  return result as unknown as WorkItemExtractionModelResult;
}

/** Restores plan order. Every planned scope must be completed exactly once; nothing else may exist. */
export function orderCandidateUnits(
  expectedKeys: readonly string[],
  units: readonly AnalysisJobUnit[]
): WorkItemExtractionModelResult[] {
  const expected = new Set(expectedKeys);
  const byKey = new Map<string, WorkItemExtractionModelResult>();
  for (const unit of units) {
    if (!expected.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Unexpected candidate unit ${unit.unit_key}.`);
    if (byKey.has(unit.unit_key)) throw new AnalysisUnitValidationError(`Duplicate candidate unit ${unit.unit_key}.`);
    if (unit.status !== "completed") throw new AnalysisUnitValidationError(`Candidate unit ${unit.unit_key} is not completed.`);
    byKey.set(unit.unit_key, parseUnitResult(unit));
  }
  return expectedKeys.map((key) => {
    const result = byKey.get(key);
    if (!result) throw new AnalysisUnitValidationError(`Missing candidate unit ${key}.`);
    return result;
  });
}

function candidatePrepared(checkpoint: Record<string, unknown> | undefined) {
  const { prepared, engine } = preparedFromCheckpoint(checkpoint);
  assertConversationEventsFinalized(prepared);
  return { prepared, engine };
}

const planDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) => Promise<Pick<MeetingAnalysisJob, "checkpoint">>,
  markRunning: markV2StageRunning
};
export type V2CandidatePlanDeps = typeof planDeps;

/** Body of planCandidatesStep. v4: ordered unit keys only. Any other engine keeps the v1 step. */
export async function planV2Candidates(input: V2JobInput, attempt: number, deps: V2CandidatePlanDeps = planDeps) {
  const job = await deps.validate(input);
  const { prepared, engine } = candidatePrepared(job.checkpoint);
  if (engine !== "v4") return { mode: "monolithic" as const, units: [] };
  const units = planCandidateUnits(prepared.source);
  await deps.markRunning({ jobId: input.jobId, stage: "candidates", attempt });
  return { mode: "durable" as const, units: units.map(({ unitKey }) => ({ unitKey })) };
}

const unitDeps = {
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  loadJob: getMeetingAnalysisJob,
  extract: requestTopicWorkItems
};
export type V2CandidateUnitDeps = typeof unitDeps;

/** Body of runCandidateUnitStep (one scope, one model call). Writes only its own
 * meeting_analysis_job_units row; a completed unit returns before the checkpoint or model is
 * touched. A handled `{ ok: false }` model result completes the unit (no Workflow retry). */
export async function runV2CandidateUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2CandidateUnitDeps = unitDeps
) {
  assertCandidateUnitKey(input.unitKey);
  const result = await deps.execute(
    { ...input, stage: CANDIDATES_STAGE },
    attempt,
    async () => {
      const job = await deps.loadJob(input.jobId);
      const { prepared } = candidatePrepared(job?.checkpoint);
      const unit = planCandidateUnits(prepared.source).find((planned) => planned.unitKey === input.unitKey);
      if (!unit) throw new AnalysisUnitValidationError(`Unexpected candidate unit ${input.unitKey}.`);
      return toUnitResult(await deps.extract(prepared.source, unit.scope));
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
export type V2CandidateFinalizeDeps = typeof finalizeDeps;

/** STEP: the only v2 candidates code that writes the job checkpoint (v4State). Restores plan
 * order, then v1's exact assembly: first failed scope fails the stage, else merge in order. */
export async function finalizeV2Candidates(
  input: V2JobInput,
  attempt: number,
  deps: V2CandidateFinalizeDeps = finalizeDeps
) {
  const job = await deps.validate(input);
  const { prepared, engine } = candidatePrepared(job.checkpoint);
  if (engine !== "v4") throw new AnalysisUnitValidationError("Durable candidates require the v4 engine.");
  await deps.markRunning({ jobId: input.jobId, stage: "candidates", attempt });
  const planned = planCandidateUnits(prepared.source);
  const results = orderCandidateUnits(planned.map(({ unitKey }) => unitKey), await deps.listUnits(input.jobId, CANDIDATES_STAGE));
  // Summed model time across scopes (v1 reports the pool's wall time); observability only.
  const latencyMs = results.reduce((total, result) => total + (Number(result.latencyMs) || 0), 0);
  const extracted = assembleTopicWorkItemExtraction(planned.map(({ scope }) => scope), results, latencyMs);
  if (!extracted.ok) {
    let message = "Analysis stage failed";
    try {
      assembleV4WorkItemState({ source: prepared.source, fallbackUsed: prepared.fallbackUsed }, extracted);
    } catch (error) {
      if (error instanceof Error) message = error.message;
    }
    // v1 parity: the job ends failed at candidates/35 with v1's stageFailure message.
    await deps.markFailed({ ...input, error: message, stage: "candidates", progress: ANALYSIS_STAGES.candidates.progress });
    throw new V2StageFailedError(message);
  }
  const v4State = assembleV4WorkItemState({ source: prepared.source, fallbackUsed: prepared.fallbackUsed }, extracted);
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, job.checkpoint, { prepared, engine, v4State })
  });
  return { topics: v4State.topicWorkItems.length, items: v4State.mergedWorkItems.length };
}
