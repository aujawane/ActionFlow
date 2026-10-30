import {
  analyzeTranscriptWithOpenAI,
  buildInsightsPayload,
  segmentMeetingTopicsWithOpenAI,
  type TopicSegmentationResult,
  type TranscriptAnalysisResult
} from "@/lib/analysis";
import { getExecutionIntelligenceEngine } from "@/lib/env";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  loadCompletedAnalysisUnit,
  type AnalysisJobUnit,
  type UnitResult
} from "@/lib/meeting-analysis/job-units";
import { markAnalysisJobRunning } from "@/lib/meeting-analysis/jobs";
import {
  buildPreparedMeetingAnalysis,
  buildTopicTranscript,
  existingTopicSegmentIds,
  isTranscriptTooShortForTopicAnalysis,
  loadMeetingAnalysisInput,
  type PreparedMeetingAnalysis,
  type PreparedSourceBase
} from "@/lib/meeting-analysis/topics";
import { saveV2Checkpoint, stageCheckpoint } from "@/lib/meeting-analysis/checkpoint";
import { executeV2AnalysisUnit } from "@/lib/meeting-analysis/v2-unit-execution";
import { assertV2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ExtractedInsight, MeetingAnalysisJob, MeetingTopic, TranscriptSegment } from "@/lib/types";

/** Pipeline v2 topic_extraction: segmentation unit -> per-topic analysis units -> one finalizer.
 * Units persist only meeting_analysis_job_units. Only finalizeV2TopicExtraction writes
 * meeting_topics/extracted_insights (one RPC transaction) and then the job checkpoint. */
export const TOPIC_SEGMENTATION_STAGE = "topic_segmentation";
export const TOPIC_SEGMENTATION_UNIT_KEY = "segmentation:000000";
export const TOPIC_ANALYSIS_STAGE = "topic_analysis";
export const WHOLE_MEETING_UNIT_KEY = "meeting:000000";
/** Durable record that the canonical topic insert was rejected (v1 topic-insert fallback). */
export const TOPIC_PERSISTENCE_STAGE = "topic_persistence";
export const TOPIC_FALLBACK_UNIT_KEY = "fallback:000000";
const TOPIC_INSERT_REJECTED = "TF001";
const MAX_TOPIC_INDEX = 999_999;

/** The database rejected the canonical topic rows (SQLSTATE class 22/23/42 on the topic insert,
 * re-raised by the RPC as TF001). The transaction rolled back; v1 falls back to whole-meeting
 * analysis on exactly this. Transport/connection/timeout errors never take this path. */
export class TopicPersistenceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicPersistenceRejectedError";
  }
}

export function topicUnitKey(topicIndex: number) {
  if (!Number.isSafeInteger(topicIndex) || topicIndex < 0 || topicIndex > MAX_TOPIC_INDEX) {
    throw new AnalysisUnitValidationError(`Invalid topic index ${topicIndex}.`);
  }
  return `topic:${String(topicIndex).padStart(6, "0")}`;
}

export type V2TopicDescriptor = {
  topicIndex: number;
  unitKey: string;
  title: string;
  summary: string;
  startTimestamp: string;
  endTimestamp: string;
  /** Persisted segment_ids: model order, filtered to segments that exist (v1 semantics). */
  segmentIds: string[];
  confidence: number | null;
  separationReason: string;
  /** Canonical-order clean topic transcript; null means no context and no model call (v1). */
  transcript: string | null;
};

/** The durable segmentation unit result. First completed result wins, so every retry and
 * every topic unit sees the same descriptors even though segmentation is non-deterministic. */
export type V2TopicPlan = { planVersion: 1; sourceBase: PreparedSourceBase } & (
  | { mode: "short_transcript" }
  | { mode: "whole_meeting"; fallbackReason: string; wholeMeetingTranscript: string }
  /** wholeMeetingTranscript: the clean transcript v1's topic-insert fallback analyzes. */
  | { mode: "topics"; descriptors: V2TopicDescriptor[]; wholeMeetingTranscript: string }
);

export type V2TopicFallbackDecision = { decisionVersion: 1; reason: string };

export type V2TopicAnalysisResult = { resultVersion: 1; unitKey: string; topicIndex: number | null } & (
  | { ok: true; analysis: TranscriptAnalysisResult }
  | { ok: false; reason: "no_segments" | "model_failed"; error: string; details: string | null }
);

export function buildTopicDescriptors(
  topics: TopicSegmentationResult["topics"],
  segmentMap: Map<string, TranscriptSegment>
): V2TopicDescriptor[] {
  return topics.map((topic, topicIndex) => ({
    topicIndex,
    unitKey: topicUnitKey(topicIndex),
    title: topic.title,
    summary: topic.summary,
    startTimestamp: topic.start_timestamp,
    endTimestamp: topic.end_timestamp,
    segmentIds: existingTopicSegmentIds(topic.segment_ids, segmentMap),
    confidence: topic.confidence ?? null,
    separationReason: topic.separation_reason,
    transcript: buildTopicTranscript(topic.segment_ids, segmentMap)
  }));
}

const planDeps = {
  load: loadMeetingAnalysisInput,
  segment: segmentMeetingTopicsWithOpenAI
};
export type V2TopicPlanDeps = typeof planDeps;

/** STEP A/B. Same load, short-transcript gate, segmentation call, and fallback triggers as
 * prepareMeetingAnalysis. Performs no canonical writes. */
export async function planTopicExtraction(
  meetingId: string,
  deps: V2TopicPlanDeps = planDeps
): Promise<V2TopicPlan> {
  let input: Awaited<ReturnType<typeof loadMeetingAnalysisInput>>;
  try {
    input = await deps.load(meetingId);
  } catch (error) {
    // Deterministic for this generation; v1 fails the job here too, without stage retries.
    if (error instanceof Error && error.message === "No transcript available yet.") {
      throw new AnalysisUnitValidationError(error.message);
    }
    throw error;
  }
  const { safeSegments, transcript, segmentationTranscript, sourceBase } = input;
  if (isTranscriptTooShortForTopicAnalysis(safeSegments)) {
    return { planVersion: 1, sourceBase, mode: "short_transcript" };
  }
  const segmentation = await deps.segment(segmentationTranscript);
  if (!segmentation.ok || segmentation.data.topics.length === 0) {
    const fallbackReason = segmentation.ok
      ? "No topics returned by segmentation model"
      : segmentation.details ?? segmentation.error;
    console.warn("[meeting-analysis-v2] Falling back to whole-meeting analysis:", fallbackReason);
    return { planVersion: 1, sourceBase, mode: "whole_meeting", fallbackReason, wholeMeetingTranscript: transcript };
  }
  const segmentMap = new Map(safeSegments.map((segment) => [segment.id, segment]));
  return {
    planVersion: 1,
    sourceBase,
    mode: "topics",
    descriptors: buildTopicDescriptors(segmentation.data.topics, segmentMap),
    wholeMeetingTranscript: transcript
  };
}

export function parseTopicPlan(value: UnitResult): V2TopicPlan {
  const plan = value as unknown as V2TopicPlan | null;
  if (!plan || plan.planVersion !== 1 || !plan.sourceBase) {
    throw new AnalysisUnitValidationError("Invalid topic segmentation unit result.");
  }
  if (plan.mode !== "short_transcript" && typeof plan.wholeMeetingTranscript !== "string") {
    throw new AnalysisUnitValidationError("Topic plan has no whole-meeting transcript.");
  }
  if (plan.mode === "topics") {
    if (!Array.isArray(plan.descriptors) || plan.descriptors.length === 0) {
      throw new AnalysisUnitValidationError("Topic plan has no descriptors.");
    }
    plan.descriptors.forEach((descriptor, index) => {
      if (descriptor.topicIndex !== index || descriptor.unitKey !== topicUnitKey(index)) {
        throw new AnalysisUnitValidationError("Topic descriptors must be ordered by topic index.");
      }
    });
  } else if (plan.mode !== "short_transcript" && plan.mode !== "whole_meeting") {
    throw new AnalysisUnitValidationError("Unknown topic plan mode.");
  }
  return plan;
}

/** STEP C: the ordered unit list the workflow fans out over (small, serializable). */
export function planAnalysisUnits(plan: V2TopicPlan): Array<{ unitKey: string }> {
  if (plan.mode === "topics") return plan.descriptors.map(({ unitKey }) => ({ unitKey }));
  if (plan.mode === "whole_meeting") return [{ unitKey: WHOLE_MEETING_UNIT_KEY }];
  return [];
}

function analysisTarget(plan: V2TopicPlan, unitKey: string) {
  if (plan.mode === "whole_meeting" && unitKey === WHOLE_MEETING_UNIT_KEY) {
    return { topicIndex: null, transcript: plan.wholeMeetingTranscript as string | null };
  }
  const descriptor = plan.mode === "topics"
    ? plan.descriptors.find((candidate) => candidate.unitKey === unitKey)
    : undefined;
  if (!descriptor) throw new AnalysisUnitValidationError(`Unexpected topic analysis unit ${unitKey}.`);
  return { topicIndex: descriptor.topicIndex as number | null, transcript: descriptor.transcript };
}

/** v1's topic-insert fallback: same segmentation plan, whole-meeting semantics (no topics,
 * topic-less insights, fallbackUsed, no contexts). Segmentation is never re-run. */
export function topicPersistenceFallbackPlan(
  plan: Extract<V2TopicPlan, { mode: "topics" }>,
  decision: V2TopicFallbackDecision
): V2TopicPlan {
  return {
    planVersion: 1,
    sourceBase: plan.sourceBase,
    mode: "whole_meeting",
    fallbackReason: decision.reason,
    wholeMeetingTranscript: plan.wholeMeetingTranscript
  };
}

/** One unit's model work. analyzeTranscriptWithOpenAI reports every model/network failure as
 * { ok: false } and v1 skips that topic's insights, so a handled failure completes the unit.
 * Only a thrown (infrastructure) error reaches the Workflow retry path. */
export async function analyzeTopicUnit(
  plan: V2TopicPlan,
  unitKey: string,
  analyze: typeof analyzeTranscriptWithOpenAI = analyzeTranscriptWithOpenAI
): Promise<V2TopicAnalysisResult> {
  const { topicIndex, transcript } = analysisTarget(plan, unitKey);
  const base = { resultVersion: 1 as const, unitKey, topicIndex };
  if (transcript === null) {
    return { ...base, ok: false, reason: "no_segments", error: "Topic has no transcript segments.", details: null };
  }
  const analysis = await analyze(transcript);
  if (!analysis.ok) {
    return { ...base, ok: false, reason: "model_failed", error: analysis.error, details: analysis.details ?? null };
  }
  return { ...base, ok: true, analysis: analysis.data };
}

/** STEP E/F. Completion order is irrelevant: results are validated against the plan and
 * returned strictly by topic ordinal. */
export function mergeTopicAnalysisUnits(plan: V2TopicPlan, units: AnalysisJobUnit[]): V2TopicAnalysisResult[] {
  const expected = new Map(planAnalysisUnits(plan).map(({ unitKey }) => [unitKey, analysisTarget(plan, unitKey)]));
  const byTopicIndex = new Map<number | null, V2TopicAnalysisResult>();
  for (const unit of units) {
    const target = expected.get(unit.unit_key);
    if (!target) throw new AnalysisUnitValidationError(`Unexpected topic analysis unit ${unit.unit_key}.`);
    if (unit.status !== "completed") continue;
    const result = unit.result as unknown as V2TopicAnalysisResult | null;
    if (!result || result.resultVersion !== 1 || typeof result.ok !== "boolean" || result.unitKey !== unit.unit_key) {
      throw new AnalysisUnitValidationError(`Invalid topic analysis result for ${unit.unit_key}.`);
    }
    if (result.topicIndex !== target.topicIndex) {
      throw new AnalysisUnitValidationError(`Unexpected topic index ${result.topicIndex} for ${unit.unit_key}.`);
    }
    if (byTopicIndex.has(result.topicIndex)) {
      throw new AnalysisUnitValidationError(`Duplicate topic index ${result.topicIndex}.`);
    }
    byTopicIndex.set(result.topicIndex, result);
  }
  for (const [unitKey, target] of expected) {
    if (!byTopicIndex.has(target.topicIndex)) {
      throw new AnalysisUnitValidationError(`Missing completed topic analysis unit ${unitKey}.`);
    }
  }
  return [...byTopicIndex.values()].sort((left, right) => (left.topicIndex ?? -1) - (right.topicIndex ?? -1));
}

type CanonicalInsightInput = { category: string; content: string; confidence: number | null };
export type CanonicalTopicInput = {
  topic_index: number;
  title: string;
  summary: string;
  start_timestamp: string;
  end_timestamp: string;
  segment_ids: string[];
  confidence: number | null;
  separation_reason: string;
  insights: CanonicalInsightInput[];
};

function insightInputs(meetingId: string, analysis: TranscriptAnalysisResult): CanonicalInsightInput[] {
  return buildInsightsPayload({ meetingId, analysis, topicId: null })
    .map(({ category, content, confidence }) => ({ category, content, confidence }));
}

/** Same row values v1 inserted; insights are attached by ordinal, never by DB id. */
export function buildCanonicalTopicPayload(meetingId: string, plan: V2TopicPlan, results: V2TopicAnalysisResult[]) {
  if (plan.mode === "whole_meeting") {
    const [result] = results;
    return { topics: [], meetingInsights: result?.ok ? insightInputs(meetingId, result.analysis) : [] };
  }
  if (plan.mode !== "topics") return { topics: [], meetingInsights: [] };
  const topics: CanonicalTopicInput[] = plan.descriptors.map((descriptor, index) => {
    const result = results[index];
    if (result?.topicIndex !== descriptor.topicIndex) {
      throw new AnalysisUnitValidationError(`Missing topic analysis result ${descriptor.topicIndex}.`);
    }
    return {
      topic_index: descriptor.topicIndex,
      title: descriptor.title,
      summary: descriptor.summary,
      start_timestamp: descriptor.startTimestamp,
      end_timestamp: descriptor.endTimestamp,
      segment_ids: descriptor.segmentIds,
      confidence: descriptor.confidence,
      separation_reason: descriptor.separationReason,
      insights: result.ok ? insightInputs(meetingId, result.analysis) : []
    };
  });
  return { topics, meetingInsights: [] as CanonicalInsightInput[] };
}

export type CanonicalTopicRow = MeetingTopic & { topic_index: number };
export type CanonicalInsightRow = ExtractedInsight & { topic_index: number | null };
export type CanonicalTopicReplacement = {
  topics: CanonicalTopicRow[];
  insights: CanonicalInsightRow[];
  dropped_insight_topic_indexes: number[];
  meeting_insights_dropped: boolean;
};

/** STEP G. One transaction; stale/terminal/version errors are non-retryable validation. */
export async function replaceCanonicalTopicAnalysis(input: {
  jobId: string;
  generation: number;
  topics: CanonicalTopicInput[];
  meetingInsights: CanonicalInsightInput[];
}): Promise<CanonicalTopicReplacement> {
  const { data, error } = await supabaseAdmin.rpc("replace_meeting_topic_analysis_v2", {
    p_job_id: input.jobId,
    p_generation: input.generation,
    p_topics: input.topics,
    p_meeting_insights: input.meetingInsights
  });
  if (error) {
    if (error.code === TOPIC_INSERT_REJECTED) throw new TopicPersistenceRejectedError(error.message);
    if (["22023", "55000", "P0002"].includes(error.code)) throw new AnalysisUnitValidationError(error.message);
    throw new Error(error.message);
  }
  if (!data || !Array.isArray(data.topics) || !Array.isArray(data.insights)) {
    throw new Error("Invalid canonical topic replacement response.");
  }
  return data as CanonicalTopicReplacement;
}

/** STEP H input: identical shape/order to prepareMeetingAnalysis for the same model outputs. */
export function buildV2PreparedAnalysis(
  plan: V2TopicPlan,
  persisted: CanonicalTopicReplacement | null
): PreparedMeetingAnalysis {
  if (plan.mode === "short_transcript") {
    return buildPreparedMeetingAnalysis(plan.sourceBase, [], [], true);
  }
  if (!persisted) throw new Error("Canonical topic persistence result is required.");
  if (plan.mode === "whole_meeting") {
    return buildPreparedMeetingAnalysis(plan.sourceBase, [], persisted.insights, true);
  }
  const topics = [...persisted.topics].sort((left, right) => left.topic_index - right.topic_index);
  if (topics.length !== plan.descriptors.length || topics.some((topic, index) => topic.topic_index !== index)) {
    throw new Error("Canonical topics do not match the segmentation plan.");
  }
  const insights = [...persisted.insights].sort((left, right) => (left.topic_index ?? -1) - (right.topic_index ?? -1));
  const contexts: Array<[string, string]> = [];
  for (const descriptor of plan.descriptors) {
    if (descriptor.transcript !== null) contexts.push([topics[descriptor.topicIndex].id, descriptor.transcript]);
  }
  return buildPreparedMeetingAnalysis(plan.sourceBase, topics, insights, false, contexts);
}

export async function loadTopicPlan(input: { jobId: string; generation: number }) {
  const unit = await loadCompletedAnalysisUnit({
    ...input, stage: TOPIC_SEGMENTATION_STAGE, unitKey: TOPIC_SEGMENTATION_UNIT_KEY
  });
  if (!unit) throw new AnalysisUnitValidationError("Topic segmentation unit is not completed.");
  return parseTopicPlan(unit.result);
}

export async function loadTopicFallbackDecision(input: { jobId: string; generation: number }) {
  const unit = await loadCompletedAnalysisUnit({
    ...input, stage: TOPIC_PERSISTENCE_STAGE, unitKey: TOPIC_FALLBACK_UNIT_KEY
  });
  if (!unit) return null;
  const decision = unit.result as unknown as V2TopicFallbackDecision | null;
  if (decision?.decisionVersion !== 1 || typeof decision.reason !== "string") {
    throw new AnalysisUnitValidationError("Invalid topic persistence fallback decision.");
  }
  return decision;
}

type V2JobInput = { meetingId: string; jobId: string; generation: number };

const segmentationUnitDeps = {
  execute: executeV2AnalysisUnit,
  markRunning: markAnalysisJobRunning,
  plan: (meetingId: string) => planTopicExtraction(meetingId)
};
export type V2TopicSegmentationUnitDeps = typeof segmentationUnitDeps;

/** Body of runTopicSegmentationStep (STEP A-C). Segmentation is itself a durable unit, so a
 * retried step never re-segments into different topics. Returns only ordered unit keys. */
export async function runTopicSegmentationUnit(
  input: V2JobInput,
  attempt: number,
  deps: V2TopicSegmentationUnitDeps = segmentationUnitDeps
) {
  const plan = parseTopicPlan(await deps.execute(
    { ...input, stage: TOPIC_SEGMENTATION_STAGE, unitKey: TOPIC_SEGMENTATION_UNIT_KEY },
    attempt,
    async () => {
      await deps.markRunning({ jobId: input.jobId, stage: "topic_extraction" });
      return (await deps.plan(input.meetingId)) as unknown as UnitResult;
    }
  ));
  return { mode: plan.mode, units: planAnalysisUnits(plan) };
}

const analysisUnitDeps = {
  execute: executeV2AnalysisUnit,
  loadPlan: loadTopicPlan,
  loadFallbackDecision: loadTopicFallbackDecision,
  analyze: analyzeTranscriptWithOpenAI
};
export type V2TopicAnalysisUnitDeps = typeof analysisUnitDeps;

/** Body of runTopicAnalysisUnitStep (STEP D, one unit). Writes only its own
 * meeting_analysis_job_units row; a completed unit returns before the plan or model is touched. */
export async function runTopicAnalysisUnit(
  input: V2JobInput & { unitKey: string },
  attempt: number,
  deps: V2TopicAnalysisUnitDeps = analysisUnitDeps
) {
  const result = await deps.execute(
    { ...input, stage: TOPIC_ANALYSIS_STAGE },
    attempt,
    async () => {
      let plan = await deps.loadPlan(input);
      // In topics mode meeting:000000 exists only after a recorded topic-insert rejection.
      if (plan.mode === "topics" && input.unitKey === WHOLE_MEETING_UNIT_KEY) {
        const decision = await deps.loadFallbackDecision(input);
        if (!decision) throw new AnalysisUnitValidationError("Whole-meeting fallback was not triggered.");
        plan = topicPersistenceFallbackPlan(plan, decision);
      }
      return (await analyzeTopicUnit(plan, input.unitKey, deps.analyze)) as unknown as UnitResult;
    }
  );
  return { unitKey: input.unitKey, ok: (result as { ok?: unknown } | null)?.ok === true };
}

/** Records the topic-insert rejection as a durable, first-wins unit. Later retries skip the
 * rejected topic transaction and go straight to the whole-meeting fallback. */
async function recordTopicFallbackDecision(input: V2JobInput, attempt: number, reason: string) {
  await executeV2AnalysisUnit(
    { ...input, stage: TOPIC_PERSISTENCE_STAGE, unitKey: TOPIC_FALLBACK_UNIT_KEY },
    attempt,
    async () => ({ decisionVersion: 1, reason } satisfies V2TopicFallbackDecision)
  );
}

const finalizeDeps = {
  validate: assertV2AnalysisJob as (input: { jobId: string; meetingId: string; generation: number }) =>
    Promise<Pick<MeetingAnalysisJob, "checkpoint" | "pipeline_version">>,
  loadPlan: loadTopicPlan,
  loadFallbackDecision: loadTopicFallbackDecision,
  recordFallbackDecision: recordTopicFallbackDecision,
  listUnits: listAnalysisStageUnits,
  replace: replaceCanonicalTopicAnalysis,
  engine: getExecutionIntelligenceEngine,
  saveCheckpoint: saveV2Checkpoint
};
export type V2TopicFinalizeDeps = typeof finalizeDeps;

export type V2TopicFinalizeResult =
  | { status: "completed"; mode: V2TopicPlan["mode"]; topicInsertFallback: boolean; topics: number; insights: number }
  /** The workflow must run meeting:000000, then finalize again. Nothing canonical was written. */
  | { status: "fallback_required"; unitKey: typeof WHOLE_MEETING_UNIT_KEY };

/** STEP E-H: the only v2 topic code that writes canonical rows or the job checkpoint.
 * Re-running after an ambiguous failure replaces the same set again (no duplicates).
 * A topic-insert rejection (TF001, rolled back) switches to v1's whole-meeting fallback. */
export async function finalizeV2TopicExtraction(
  input: V2JobInput,
  attempt: number,
  deps: V2TopicFinalizeDeps = finalizeDeps
): Promise<V2TopicFinalizeResult> {
  const job = await deps.validate(input);
  const segmentationPlan = await deps.loadPlan(input);
  const units = await deps.listUnits(input.jobId, TOPIC_ANALYSIS_STAGE);
  const decision = segmentationPlan.mode === "topics" ? await deps.loadFallbackDecision(input) : null;
  const plan = decision && segmentationPlan.mode === "topics"
    ? topicPersistenceFallbackPlan(segmentationPlan, decision)
    : segmentationPlan;
  if (decision) {
    // Per-topic results are discarded exactly like v1, which never reached topic analysis.
    const fallbackUnit = units.find((unit) => unit.unit_key === WHOLE_MEETING_UNIT_KEY);
    if (fallbackUnit?.status !== "completed") return { status: "fallback_required", unitKey: WHOLE_MEETING_UNIT_KEY };
  }
  const results = mergeTopicAnalysisUnits(plan, decision
    ? units.filter((unit) => unit.unit_key === WHOLE_MEETING_UNIT_KEY)
    : units);
  // v1's short-transcript path leaves existing canonical topics/insights untouched.
  let persisted: CanonicalTopicReplacement | null = null;
  if (plan.mode !== "short_transcript") {
    try {
      persisted = await deps.replace({ jobId: input.jobId, generation: input.generation, ...buildCanonicalTopicPayload(input.meetingId, plan, results) });
    } catch (error) {
      if (!(error instanceof TopicPersistenceRejectedError) || plan.mode !== "topics") throw error;
      console.warn("[meeting-analysis-v2] Falling back to whole-meeting analysis:", error.message);
      await deps.recordFallbackDecision(input, attempt, error.message);
      return { status: "fallback_required", unitKey: WHOLE_MEETING_UNIT_KEY };
    }
  }
  if (persisted && (persisted.dropped_insight_topic_indexes.length > 0 || persisted.meeting_insights_dropped)) {
    console.warn("[meeting-analysis-v2] Dropped rejected insight batches", {
      job_id: input.jobId,
      topic_indexes: persisted.dropped_insight_topic_indexes,
      meeting_insights: persisted.meeting_insights_dropped
    });
  }
  const prepared = buildV2PreparedAnalysis(plan, persisted);
  await deps.saveCheckpoint({
    jobId: input.jobId,
    generation: input.generation,
    checkpoint: stageCheckpoint(job, job.checkpoint, { prepared, engine: deps.engine() })
  });
  return {
    status: "completed",
    mode: plan.mode,
    topicInsertFallback: Boolean(decision),
    topics: prepared.source.topics.length,
    insights: prepared.source.insights.length
  };
}
