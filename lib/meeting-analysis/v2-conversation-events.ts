import {
  extractConversationEvents,
  mergeConversationEventChunkResults,
  planConversationEventChunks,
  type ConversationEventStageResult
} from "@/lib/execution-intelligence/conversation-events";
import { applyConversationEventResult } from "@/lib/execution-intelligence/durable-pipeline";
import { applyV4ConversationEventResult } from "@/lib/execution-intelligence/v4-pipeline";
import type { ExecutionIntelligenceEngine } from "@/lib/env";
import { saveV2Checkpoint, stageCheckpoint } from "@/lib/meeting-analysis/checkpoint";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  type AnalysisJobUnit,
  type UnitResult
} from "@/lib/meeting-analysis/job-units";
import { getMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import type { PreparedMeetingAnalysis } from "@/lib/meeting-analysis/topics";
import { markV2StageRunning } from "@/lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "@/lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import type { MeetingAnalysisJob } from "@/lib/types";

/** Pipeline-v2 (B2) conversation_events: plan -> one durable unit per chunk -> one finalizer.
 * Units persist only meeting_analysis_job_units. Only finalizeV2ConversationEvents writes the
 * job checkpoint (prepared.source.conversationEvents), which candidates then read. */
export const CONVERSATION_EVENTS_STAGE = "conversation_events";
const MAX_CHUNK_INDEX = 999_999;
const CHUNK_UNIT_KEY = /^chunk:(\d{6})$/;

type V2JobInput = { meetingId: string; jobId: string; generation: number };

export function conversationEventUnitKey(chunkIndex: number) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_CHUNK_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid conversation event chunk index ${chunkIndex}.`);
  }
  return `chunk:${String(chunkIndex).padStart(6, "0")}`;
}

export function parseConversationEventUnitKey(unitKey: string) {
  const match = CHUNK_UNIT_KEY.exec(unitKey);
  if (!match) throw new AnalysisUnitValidationError(`Unexpected conversation event unit ${unitKey}.`);
  return Number(match[1]);
}

/** The canonical checkpoint's prepared analysis and engine, exactly as the v1 stage resolves it. */
function preparedFromCheckpoint(checkpoint: Record<string, unknown> | undefined) {
  const prepared = checkpoint?.prepared as PreparedMeetingAnalysis | undefined;
  if (!prepared?.source || typeof prepared.source.transcript !== "string") {
    throw new AnalysisUnitValidationError("Missing prepared analysis checkpoint.");
  }
  const engine = (checkpoint?.engine as ExecutionIntelligenceEngine | undefined) ?? "independent";
  return { prepared, engine };
}

/** Only what the finalizer needs: never the chunk source, transcript, or checkpoint. */
function toUnitResult(result: ConversationEventStageResult): UnitResult {
  if (result.ok) return { ok: true, events: result.events, latencyMs: result.latencyMs } as unknown as UnitResult;
  return {
    ok: false,
    error: result.error,
    ...(result.details === undefined ? {} : { details: result.details }),
    latencyMs: result.latencyMs
  };
}

function parseUnitResult(unit: AnalysisJobUnit): ConversationEventStageResult {
  const result = unit.result as Record<string, unknown> | null;
  const valid = result !== null && typeof result === "object" && !Array.isArray(result) && (
    result.ok === true ? Array.isArray(result.events) : result.ok === false && typeof result.error === "string"
  );
  if (!valid) throw new AnalysisUnitValidationError(`Malformed conversation event unit ${unit.unit_key}.`);
  return result as unknown as ConversationEventStageResult;
}

/** Restores plan (chunk-index) order. Every expected chunk must be completed exactly once. */
export function orderConversationEventUnits(
  chunkCount: number,
  units: readonly AnalysisJobUnit[]
): ConversationEventStageResult[] {
  const byIndex = new Map<number, ConversationEventStageResult>();
  for (const unit of units) {
    const index = parseConversationEventUnitKey(unit.unit_key);
    if (index >= chunkCount) throw new AnalysisUnitValidationError(`Unexpected conversation event unit ${unit.unit_key}.`);
    if (byIndex.has(index)) throw new AnalysisUnitValidationError(`Duplicate conversation event unit ${unit.unit_key}.`);
    if (unit.status !== "completed") {
      throw new AnalysisUnitValidationError(`Conversation event unit ${unit.unit_key} is not completed.`);
    }
    byIndex.set(index, parseUnitResult(unit));
  }
  return Array.from({ length: chunkCount }, (_, index) => {
    const result = byIndex.get(index);
    if (!result) {
      throw new AnalysisUnitValidationError(`Missing conversation event unit ${conversationEventUnitKey(index)}.`);
    }
    return result;
  });
}

const planDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) => Promise<Pick<MeetingAnalysisJob, "checkpoint">>,
  markRunning: markV2StageRunning
};
export type V2ConversationEventPlanDeps = typeof planDeps;

/** Body of planConversationEventsStep. Deterministic: the same chunks the v1 stage extracts
 * from, as ordered unit keys only. */
export async function planV2ConversationEvents(
  input: V2JobInput,
  attempt: number,
  deps: V2ConversationEventPlanDeps = planDeps
) {
  const job = await deps.validate(input);
  const { prepared } = preparedFromCheckpoint(job.checkpoint);
  await deps.markRunning({ jobId: input.jobId, stage: "conversation_events", attempt });
  const chunks = planConversationEventChunks(prepared.source);
  return { units: chunks.map((chunk) => ({ unitKey: conversationEventUnitKey(chunk.index) })) };
}

const unitDeps = {
  execute: executeV2AnalysisUnit,
  persistence: b2UnitPersistence,
  loadJob: getMeetingAnalysisJob,
  extract: extractConversationEvents
};
export type V2ConversationEventUnitDeps = typeof unitDeps;

/** Body of runConversationEventUnitStep (one chunk, one model call). Writes only its own
 * meeting_analysis_job_units row; a completed unit returns before the checkpoint or model is
 * touched. A handled `{ ok: false }` model result completes the unit (no Workflow retry). */
export async function runV2ConversationEventUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2ConversationEventUnitDeps = unitDeps
) {
  const chunkIndex = parseConversationEventUnitKey(input.unitKey);
  const result = await deps.execute(
    { ...input, stage: CONVERSATION_EVENTS_STAGE },
    attempt,
    async () => {
      const job = await deps.loadJob(input.jobId);
      const { prepared } = preparedFromCheckpoint(job?.checkpoint);
      const chunk = planConversationEventChunks(prepared.source)[chunkIndex];
      if (!chunk) throw new AnalysisUnitValidationError(`Unexpected conversation event unit ${input.unitKey}.`);
      return toUnitResult(await deps.extract(chunk.source));
    },
    deps.persistence
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

const finalizeDeps = {
  validate: assertB2AnalysisJob as (input: V2JobInput) =>
    Promise<Pick<MeetingAnalysisJob, "checkpoint" | "pipeline_version">>,
  markRunning: markV2StageRunning,
  listUnits: listAnalysisStageUnits,
  saveCheckpoint: saveV2Checkpoint
};
export type V2ConversationEventFinalizeDeps = typeof finalizeDeps;

/** STEP: the only v2 conversation-event code that writes the job checkpoint. Restores chunk order,
 * then applies v1's exact merge and optional/all-or-nothing rule. Re-running is idempotent. */
export async function finalizeV2ConversationEvents(
  input: V2JobInput,
  attempt: number,
  deps: V2ConversationEventFinalizeDeps = finalizeDeps
) {
  const job = await deps.validate(input);
  const { prepared, engine } = preparedFromCheckpoint(job.checkpoint);
  await deps.markRunning({ jobId: input.jobId, stage: "conversation_events", attempt });
  const chunks = planConversationEventChunks(prepared.source);
  const results = orderConversationEventUnits(chunks.length, await deps.listUnits(input.jobId, CONVERSATION_EVENTS_STAGE));
  const merged = mergeConversationEventChunkResults({
    results,
    transcript: prepared.source.transcript,
    generation: input.generation
  });
  // Summed model time across chunks (v1 reports the pool's wall time); logged only.
  const latencyMs = results.reduce((total, result) => total + (Number(result.latencyMs) || 0), 0);
  const stageResult: ConversationEventStageResult = { ...merged, latencyMs };
  const source = engine === "v4"
    ? applyV4ConversationEventResult(prepared.source, stageResult)
    : applyConversationEventResult(prepared.source, stageResult);
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, job.checkpoint, { prepared: { ...prepared, source }, engine })
  });
  return { ok: merged.ok, events: source.conversationEvents?.length ?? 0 };
}
