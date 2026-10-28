import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getOpenAIClient } from "../lib/openai";
import { analyzeTranscriptWithOpenAI } from "../lib/analysis";
import { prepareMeetingAnalysis } from "../lib/meeting-analysis/topics";
import { AnalysisUnitValidationError, listAnalysisStageUnits } from "../lib/meeting-analysis/job-units";
import { ANALYSIS_STAGE_ORDER } from "../lib/meeting-analysis/jobs";
import { executeV2AnalysisUnit } from "../lib/meeting-analysis/v2-unit-execution";
import { assertV2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import { runOrderedAnalysisUnits } from "../lib/meeting-analysis/workflow-concurrency";
import { splitExecutionSourceIntoChunks } from "../lib/execution-intelligence/chunking";
import { buildExecutionSourcePayload, transcriptForSegmentIds } from "../lib/execution-intelligence/stages";
import { isAnalysisPipelineV2StagingEnabled } from "../lib/meeting-analysis/enqueue-v2";
import * as v2 from "../lib/meeting-analysis/v2-topic-extraction";

// Clients are lazy and read these on first use; nothing here reaches a network.
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_ENV: "staging",
  NEXT_PUBLIC_STAGING_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY: "anon",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test",
  RECALL_API_KEY: "test",
  RECALL_WEBHOOK_SECRET: "test"
});

type Row = Record<string, unknown>;
type Prepared = Awaited<ReturnType<typeof prepareMeetingAnalysis>>;
type Unit = Parameters<typeof v2.mergeTopicAnalysisUnits>[1][number];

const MEETING = "meeting-1";
const JOB = "job-v2";
const GENERATION = 7;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };

let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);

// ---------------------------------------------------------------- fake OpenAI
type ModelTopic = { title: string; segment_ids: string[]; confidence?: number | null };
let segmentationOutput: ModelTopic[] | Error = [];
const modelCalls = { segmentation: 0, analysis: [] as string[] };
const openai = getOpenAIClient();
Object.assign(openai.responses, {
  create: async (body: { input: Array<{ content: string }>; text: { format: { name: string } } }) => {
    if (body.text.format.name === "meeting_topic_segmentation") {
      modelCalls.segmentation += 1;
      if (segmentationOutput instanceof Error) throw segmentationOutput;
      return { output_text: JSON.stringify({ topics: segmentationOutput.map((topic, index) => ({
        summary: `summary ${index}`, start_timestamp: `start ${index}`, end_timestamp: `end ${index}`,
        separation_reason: `reason ${index}`, confidence: null, ...topic
      })) }) };
    }
    const transcript = body.input[1].content.split("\n\n").slice(1).join("\n\n");
    modelCalls.analysis.push(transcript);
    if (transcript.includes("FAIL_TOPIC")) throw new Error("model timeout");
    const markers = [...transcript.matchAll(/marker-(\w+)/g)].map((match) => match[1]);
    return { output_text: JSON.stringify({
      product_summary: `summary ${markers.join("+")}`,
      requirements: markers.map((marker) => `requirement ${marker}`),
      decisions: [`decision ${markers[0]}`],
      features: [], user_stories: [], technical_constraints: [], design_preferences: [],
      implementation_details: [], open_questions: [], risks: [], next_steps: [`next ${markers.at(-1)}`]
    }) };
  }
});

// ---------------------------------------------------------------- scenario
const FIVE_TOPICS: ModelTopic[] = [
  { title: "Onboarding", segment_ids: ["s1", "s2", "ghost"], confidence: 0.9 },
  { title: "Billing", segment_ids: ["s5", "s3"] },
  { title: "Phantom", segment_ids: ["ghost-2"] },
  { title: "Flaky", segment_ids: ["s4"] },
  { title: "Launch", segment_ids: ["s6"] }
];
const FOUR_TOPICS: ModelTopic[] = [
  { title: "A", segment_ids: ["s1", "s2"] }, { title: "B", segment_ids: ["s3"] },
  { title: "C", segment_ids: ["s5"] }, { title: "D", segment_ids: ["s6"] }
];

function seed(options: { segments?: number } = {}) {
  const words = "we agreed to ship the new flow after the review with the whole team today";
  const segments: Row[] = Array.from({ length: options.segments ?? 6 }, (_, index) => ({
    id: `s${index + 1}`, meeting_id: MEETING, timestamp: `2026-10-01T10:00:0${index}.000Z`,
    speaker: index % 2 ? "Bob" : "Alice", participant_name: null, raw_payload: null,
    text: `marker-s${index + 1} ${index === 3 ? "FAIL_TOPIC " : ""}${words}`,
    normalized_text: index === 1 ? `marker-s2 normalized ${words}` : null
  }));
  db = new FakeDb({
    meetings: [{ id: MEETING, user_id: "user-1", project_id: "project-1", created_at: "2026-10-01T10:00:00.000Z", deleted_at: null, execution_graph_generation: GENERATION }],
    projects: [{ id: "project-1", name: "Parfait", goal: "Ship", owner_id: "user-1" }],
    project_memory: [{ project_id: "project-1", summary: "memory", goal: null, current_scope: ["a"], future_scope: [], technical_context: {}, confirmed_fields: {} }],
    project_constraints: [{ id: "c1", project_id: "project-1", status: "active", title: "C" }],
    project_decisions: [],
    transcript_segments: segments,
    meeting_topics: [{ id: "old-topic", meeting_id: MEETING, title: "Old", topic_index: null }],
    extracted_insights: [{ id: "old-insight", meeting_id: MEETING, topic_id: "old-topic", category: "requirements", content: "old" }],
    meeting_analysis_jobs: [{ id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running", started_at: "x", checkpoint: { checkpointVersion: 2, normalization: { applied: false } } }]
  });
  modelCalls.segmentation = 0;
  modelCalls.analysis = [];
  return db;
}

async function runV1(topics: ModelTopic[] | Error = FIVE_TOPICS, segments?: number) {
  seed({ segments });
  segmentationOutput = topics;
  const prepared = await prepareMeetingAnalysis(MEETING);
  return { prepared, db, calls: { ...modelCalls, analysis: [...modelCalls.analysis] } };
}

const analysisDeps = (analyze = analyzeTranscriptWithOpenAI) => ({ execute: executeV2AnalysisUnit, loadPlan: v2.loadTopicPlan, loadFallbackDecision: v2.loadTopicFallbackDecision, analyze });
const finalizeDeps = (overrides: Partial<v2.V2TopicFinalizeDeps> = {}): v2.V2TopicFinalizeDeps => ({
  validate: assertV2AnalysisJob,
  loadPlan: v2.loadTopicPlan,
  loadFallbackDecision: v2.loadTopicFallbackDecision,
  recordFallbackDecision: async (value, attempt, reason) => {
    await executeV2AnalysisUnit({ ...value, stage: v2.TOPIC_PERSISTENCE_STAGE, unitKey: v2.TOPIC_FALLBACK_UNIT_KEY }, attempt, async () => ({ decisionVersion: 1, reason }));
  },
  listUnits: listAnalysisStageUnits,
  replace: v2.replaceCanonicalTopicAnalysis,
  engine: () => "v4" as const,
  saveCheckpoint: v2.saveV2TopicCheckpoint,
  ...overrides
});

/** Mirrors meetingAnalysisV2Workflow's topic stage (steps are thin wrappers over these). */
async function runV2TopicStage(attempt = 1) {
  const segmentation = await v2.runTopicSegmentationUnit(input, attempt);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, attempt));
  let finalized = await v2.finalizeV2TopicExtraction(input, attempt);
  if (finalized.status === "fallback_required") {
    await v2.runTopicAnalysisUnit({ ...input, unitKey: finalized.unitKey }, attempt);
    finalized = await v2.finalizeV2TopicExtraction(input, attempt);
  }
  return { segmentation, finalized };
}

async function runV2Units(analyze = analyzeTranscriptWithOpenAI) {
  const segmentation = await v2.runTopicSegmentationUnit(input, 1);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1, analysisDeps(analyze)));
  return segmentation;
}

async function runV2(topics: ModelTopic[] | Error = FIVE_TOPICS, segments?: number) {
  seed({ segments });
  segmentationOutput = topics;
  const segmentation = await runV2Units();
  assert.equal((await v2.finalizeV2TopicExtraction(input, 1)).status, "completed");
  const checkpoint = db.rows("meeting_analysis_jobs")[0].checkpoint as Row & { prepared: Prepared };
  return { segmentation, prepared: checkpoint.prepared, checkpoint, db, calls: { ...modelCalls, analysis: [...modelCalls.analysis] } };
}

/** Topic UUIDs differ by construction; everything else must be byte-identical. */
function normalizeIds(prepared: Prepared) {
  const ids = new Map(prepared.source.topics.map((topic, index) => [topic.id, `topic#${index}`]));
  return JSON.parse(JSON.stringify(prepared, (_key, value) => (typeof value === "string" && ids.has(value) ? ids.get(value) : value)));
}
function canonicalRows(fake: FakeDb) {
  const topics = fake.rows("meeting_topics").filter((row) => row.meeting_id === MEETING);
  const index = new Map(topics.map((row, i) => [row.id, i]));
  return {
    topics: topics.map(({ title, summary, start_timestamp, end_timestamp, segment_ids, confidence, separation_reason }) =>
      ({ title, summary, start_timestamp, end_timestamp, segment_ids, confidence, separation_reason })),
    insights: fake.rows("extracted_insights").filter((row) => row.meeting_id === MEETING)
      .map(({ topic_id, category, content }) => ({ topic: topic_id === null ? null : index.get(topic_id), category, content }))
  };
}
function unitRow(unitKey: string, topicIndex: number | null, ok = true, overrides: Partial<Unit> = {}): Unit {
  const result = ok
    ? { resultVersion: 1, unitKey, topicIndex, ok: true, analysis: { product_summary: `p${topicIndex}`, requirements: [], decisions: [], features: [], user_stories: [], technical_constraints: [], design_preferences: [], implementation_details: [], open_questions: [], risks: [], next_steps: [] } }
    : { resultVersion: 1, unitKey, topicIndex, ok: false, reason: "model_failed", error: "x", details: null };
  return { job_id: JOB, stage: v2.TOPIC_ANALYSIS_STAGE, unit_key: unitKey, status: "completed", result, error: null, attempt: 1, started_at: null, completed_at: null, created_at: "", updated_at: "", ...overrides } as Unit;
}
function plan(count: number) {
  return {
    planVersion: 1 as const, mode: "topics" as const, wholeMeetingTranscript: "whole", sourceBase: { meetingId: MEETING, meetingDate: "d", transcript: "", transcriptSegmentCount: 0, project: null },
    descriptors: Array.from({ length: count }, (_, topicIndex) => ({
      topicIndex, unitKey: v2.topicUnitKey(topicIndex), title: `T${topicIndex}`, summary: "", startTimestamp: "", endTimestamp: "",
      segmentIds: [`s${topicIndex}`], confidence: null, separationReason: "", transcript: `t${topicIndex}`
    }))
  };
}

// ======================================================================= tests

test("[27] pipeline-v1 prepareMeetingAnalysis keeps its exact topic/insight/context behavior", async () => {
  const { prepared, db: fake, calls } = await runV1();
  assert.equal(prepared.fallbackUsed, false);
  assert.deepEqual(prepared.source.topics.map((topic) => [topic.title, topic.segment_ids]),
    [["Onboarding", ["s1", "s2"]], ["Billing", ["s5", "s3"]], ["Phantom", []], ["Flaky", ["s4"]], ["Launch", ["s6"]]]);
  // Phantom (no segments) gets no context and no call; Flaky fails and is skipped, keeping its context.
  assert.equal(calls.analysis.length, 4);
  assert.deepEqual(prepared.meetingContextByTopicId.map(([id]) => prepared.source.topics.findIndex((topic) => topic.id === id)), [0, 1, 3, 4]);
  assert.deepEqual([...new Set(prepared.source.insights.map((insight) => prepared.source.topics.findIndex((topic) => topic.id === insight.topic_id)))], [0, 1, 4]);
  assert.match(prepared.meetingContextByTopicId[1][1], /marker-s3[\s\S]*marker-s5/, "topic transcript uses canonical order");
  assert.match(prepared.meetingContextByTopicId[0][1], /marker-s2 normalized/, "normalized_text preferred");
  assert.equal(prepared.source.project?.memory?.summary, "memory");
  assert.ok(!fake.rows("meeting_topics").some((row) => row.id === "old-topic"));
  assert.ok(fake.rows("meeting_topics").every((row) => row.topic_index === undefined), "v1 never writes topic_index");
});

test("[18][19][20][11][12] v2 prepared output and canonical rows match v1 for the same model outputs", async () => {
  const v1 = await runV1();
  const v2Run = await runV2();
  assert.deepEqual(normalizeIds(v2Run.prepared), normalizeIds(v1.prepared));
  assert.deepEqual(canonicalRows(v2Run.db), canonicalRows(v1.db));
  assert.deepEqual(v2Run.calls.analysis, v1.calls.analysis, "same transcripts, same order, same count");
  const topics = v2Run.db.rows("meeting_topics");
  assert.deepEqual(topics.map((row) => row.topic_index), [0, 1, 2, 3, 4], "one topic per descriptor with ordinal");
  for (const insight of v2Run.db.rows("extracted_insights")) {
    const topicIndex = topics.find((row) => row.id === insight.topic_id)!.topic_index as number;
    const markers = [...String(v2Run.prepared.meetingContextByTopicId.find(([id]) => id === insight.topic_id)![1]).matchAll(/marker-(\w+)/g)].map((m) => m[1]);
    assert.ok(markers.some((marker) => String(insight.content).includes(marker)), `insight maps to topic_index ${topicIndex}`);
  }
  assert.deepEqual(v2Run.checkpoint.normalization, { applied: false }, "earlier checkpoint fields preserved");
  assert.equal(v2Run.checkpoint.checkpointVersion, 2);
  assert.ok(v2Run.checkpoint.engine);
});

test("[21] action_tN scopes, chunks, and model payloads are unchanged downstream", async () => {
  const v1 = normalizeIds((await runV1()).prepared);
  const v2Prepared = normalizeIds((await runV2()).prepared);
  // Mirrors extractTopicActions: action_t{index+1} is the position among topics with transcript.
  const scopes = (prepared: Prepared) => prepared.source.topics
    .map((topic) => ({ id: topic.id, transcript: transcriptForSegmentIds(prepared.source.transcript, new Set(topic.segment_ids as string[])) }))
    .filter((scope) => scope.transcript.trim())
    .map((scope, index) => [`action_t${index + 1}`, scope.id, scope.transcript]);
  assert.deepEqual(scopes(v2Prepared), scopes(v1));
  assert.deepEqual(splitExecutionSourceIntoChunks(v2Prepared.source), splitExecutionSourceIntoChunks(v1.source));
  assert.deepEqual(buildExecutionSourcePayload(v2Prepared.source), buildExecutionSourcePayload(v1.source));
});

test("[1][2] descriptors preserve model order; unit keys are stable and zero-padded", async () => {
  seed();
  segmentationOutput = FIVE_TOPICS;
  const planned = await v2.planTopicExtraction(MEETING);
  assert.equal(planned.mode, "topics");
  if (planned.mode !== "topics") return;
  assert.deepEqual(planned.descriptors.map((d) => [d.topicIndex, d.unitKey, d.title]), FIVE_TOPICS.map((t, i) => [i, `topic:00000${i}`, t.title]));
  assert.deepEqual(planned.descriptors[0].segmentIds, ["s1", "s2"]);
  assert.equal(planned.descriptors[2].transcript, null);
  assert.deepEqual(Object.keys(planned.descriptors[0]).sort(), ["confidence", "endTimestamp", "segmentIds", "separationReason", "startTimestamp", "summary", "title", "topicIndex", "transcript", "unitKey"].sort());
  assert.equal(v2.topicUnitKey(12), "topic:000012");
  assert.equal(v2.topicUnitKey(999_999), "topic:999999");
  for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) assert.throws(() => v2.topicUnitKey(bad), AnalysisUnitValidationError);
  const keys = Array.from({ length: 120 }, (_, i) => v2.topicUnitKey(i));
  assert.deepEqual([...keys].sort(), keys, "lexicographic order equals ordinal order");
  assert.equal(db.writes.filter((write) => write.table === "meeting_topics" || write.table === "extracted_insights").length, 0, "planning writes nothing canonical");
});

test("[3][4][19] concurrency never exceeds 2 and completion order 1,0,3,2 merges as 0,1,2,3", async () => {
  const sequential = await runV2(FOUR_TOPICS);
  seed();
  segmentationOutput = FOUR_TOPICS;
  const delays: Record<string, number> = { s1: 30, s3: 5, s5: 30, s6: 5 };
  const completed: number[] = [];
  let active = 0;
  let maximum = 0;
  await runV2Units(async (transcript) => {
    const first = /marker-(s\d)/.exec(transcript)![1];
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, delays[first]));
    const result = await analyzeTranscriptWithOpenAI(transcript);
    active -= 1;
    completed.push(["s1", "s3", "s5", "s6"].indexOf(first));
    return result;
  });
  assert.deepEqual(completed, [1, 0, 3, 2]);
  assert.equal(maximum, 2);
  await v2.finalizeV2TopicExtraction(input, 1);
  const prepared = (db.rows("meeting_analysis_jobs")[0].checkpoint as { prepared: Prepared }).prepared;
  assert.deepEqual(prepared.source.topics.map((topic) => topic.title), ["A", "B", "C", "D"]);
  assert.deepEqual(normalizeIds(prepared), normalizeIds(sequential.prepared));
  const source = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(source, /runOrderedAnalysisUnits\(units, \(unit\) => runTopicAnalysisUnitStep/);
  assert.doesNotMatch(source, /Promise\.all/);
});

test("[5][6][7] topic units never write meeting_topics, extracted_insights, or the checkpoint", async () => {
  seed();
  segmentationOutput = FIVE_TOPICS;
  await v2.runTopicSegmentationUnit(input, 1);
  const checkpoint = JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint);
  const before = db.writes.length;
  const segmentation = await v2.runTopicSegmentationUnit(input, 1);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1));
  const unitWrites = db.writes.slice(before);
  assert.ok(unitWrites.length > 0);
  assert.deepEqual([...new Set(unitWrites.map((write) => write.table))].sort(), ["complete_meeting_analysis_job_unit", "mark_meeting_analysis_job_unit_running"]);
  assert.equal(JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint), checkpoint);
  assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
  assert.deepEqual(db.rows("extracted_insights").map((row) => row.id), ["old-insight"]);
});

test("[8][9] a completed topic/segmentation unit is reused on retry without OpenAI; first result wins", async () => {
  seed();
  segmentationOutput = FIVE_TOPICS;
  await runV2Units();
  const segmentationCalls = modelCalls.segmentation;
  const analysisCalls = modelCalls.analysis.length;
  const stored = JSON.stringify(db.rows("meeting_analysis_job_units").find((row) => row.unit_key === "topic:000000")!.result);
  segmentationOutput = [{ title: "Different", segment_ids: ["s1"] }];
  const retried = await v2.runTopicSegmentationUnit(input, 2);
  assert.equal(retried.units.length, 5, "retried segmentation reuses the accepted plan");
  const ack = await v2.runTopicAnalysisUnit({ ...input, unitKey: "topic:000000" }, 2, analysisDeps(async () => ({ ok: true, data: { product_summary: "other" } as never })));
  assert.deepEqual(ack, { unitKey: "topic:000000", ok: true });
  assert.equal(modelCalls.segmentation, segmentationCalls);
  assert.equal(modelCalls.analysis.length, analysisCalls);
  const { data } = await getSupabaseAdmin().rpc("complete_meeting_analysis_job_unit", { p_job_id: JOB, p_generation: GENERATION, p_stage: v2.TOPIC_ANALYSIS_STAGE, p_unit_key: "topic:000000", p_attempt: 3, p_result: { replaced: true } });
  assert.equal(JSON.stringify(data.result), stored);
  assert.equal(JSON.stringify(db.rows("meeting_analysis_job_units").find((row) => row.unit_key === "topic:000000")!.result), stored);
});

test("[10] a handled { ok: false } topic completes its unit, yields no insights, and does not fail the stage", async () => {
  const { db: fake, prepared } = await runV2();
  const flaky = fake.rows("meeting_analysis_job_units").find((row) => row.unit_key === "topic:000003")!;
  assert.equal(flaky.status, "completed");
  assert.deepEqual({ ...(flaky.result as Row), error: undefined }, { resultVersion: 1, unitKey: "topic:000003", topicIndex: 3, ok: false, reason: "model_failed", error: undefined, details: "model timeout" });
  const phantom = fake.rows("meeting_analysis_job_units").find((row) => row.unit_key === "topic:000002")!;
  assert.equal((phantom.result as Row).reason, "no_segments");
  const flakyId = prepared.source.topics[3].id;
  assert.equal(prepared.source.insights.filter((insight) => insight.topic_id === flakyId).length, 0);
  assert.ok(prepared.meetingContextByTopicId.some(([id]) => id === flakyId));
  // An infrastructure (thrown) error is NOT handled: it fails the unit and stays retryable.
  seed();
  segmentationOutput = FIVE_TOPICS;
  await v2.runTopicSegmentationUnit(input, 1);
  const infra = new Error("connection reset");
  await assert.rejects(v2.runTopicAnalysisUnit({ ...input, unitKey: "topic:000000" }, 1, analysisDeps(async () => { throw infra; })), (error) => error === infra);
  assert.equal(db.rows("meeting_analysis_job_units").find((row) => row.unit_key === "topic:000000")!.status, "failed");
});

test("[13][26] repeated or ambiguous canonical finalization is idempotent: no duplicate topics/insights", async () => {
  const first = await runV2();
  const rows = canonicalRows(db);
  await v2.finalizeV2TopicExtraction(input, 1);
  await Promise.all([v2.finalizeV2TopicExtraction(input, 2), v2.finalizeV2TopicExtraction(input, 3)]);
  assert.deepEqual(canonicalRows(db), rows);
  assert.equal(db.rows("meeting_topics").length, 5);
  assert.equal(db.rows("extracted_insights").length, first.db.rows("extracted_insights").length);
  const latest = (db.rows("meeting_analysis_jobs")[0].checkpoint as { prepared: Prepared }).prepared;
  assert.deepEqual(normalizeIds(latest), normalizeIds(first.prepared));
  assert.ok(latest.source.topics.every((topic) => db.rows("meeting_topics").some((row) => row.id === topic.id)), "checkpoint references the surviving topic IDs");
});

test("[14] a failed canonical transaction leaves prior rows and the checkpoint untouched and stays retryable", async () => {
  seed();
  segmentationOutput = FIVE_TOPICS;
  await runV2Units();
  const checkpoint = JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint);
  const failure = new Error("connection terminated");
  const deps = finalizeDeps({ replace: async () => { throw failure; } });
  await assert.rejects(v2.finalizeV2TopicExtraction(input, 1, deps), (error) => error === failure && !(error instanceof AnalysisUnitValidationError));
  assert.equal(JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint), checkpoint);
  assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
  assert.deepEqual(db.rows("extracted_insights").map((row) => row.id), ["old-insight"]);
});

test("[15][16][17] finalization rejects missing, duplicate, and unexpected topic indexes", () => {
  const p = plan(3);
  const complete = [unitRow("topic:000002", 2), unitRow("topic:000000", 0), unitRow("topic:000001", 1, false)];
  assert.deepEqual(v2.mergeTopicAnalysisUnits(p, complete).map((r) => r.topicIndex), [0, 1, 2], "row order is irrelevant");
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, complete.slice(0, 2)), /Missing completed topic analysis unit topic:000001/);
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, [...complete.slice(0, 2), unitRow("topic:000001", 1, true, { status: "failed" })]), /Missing/);
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, [...complete, unitRow("topic:000001", 1)]), /Duplicate topic index 1/);
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, [...complete, unitRow("topic:000003", 3)]), /Unexpected topic analysis unit topic:000003/);
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, [unitRow("topic:000000", 0), unitRow("topic:000001", 2), unitRow("topic:000002", 2)]), /Unexpected topic index 2/);
  assert.throws(() => v2.mergeTopicAnalysisUnits(p, [...complete.slice(1), unitRow("topic:000000", 0, true, { result: null })]), /Invalid topic analysis result/);
  for (const bad of [
    { ...p, descriptors: [p.descriptors[1], p.descriptors[0]] },
    { ...p, descriptors: [p.descriptors[0], p.descriptors[0]] },
    { ...p, descriptors: [] }
  ]) assert.throws(() => v2.parseTopicPlan(bad as never), AnalysisUnitValidationError);
  assert.throws(() => v2.buildV2PreparedAnalysis(p, { topics: [{ topic_index: 0 }, { topic_index: 2 }, { topic_index: 2 }] as never, insights: [], dropped_insight_topic_indexes: [], meeting_insights_dropped: false }), /do not match/);
});

test("[22] whole-meeting fallback (no topics, or segmentation failure) preserves v1 behavior via one durable unit", async () => {
  // 3 segments: the whole-meeting analysis succeeds (segment s4 carries FAIL_TOPIC).
  for (const output of [[] as ModelTopic[], new Error("segmentation timeout")]) {
    const v1 = await runV1(output, 3);
    const v2Run = await runV2(output, 3);
    assert.equal(v2Run.prepared.fallbackUsed, true);
    assert.deepEqual(normalizeIds(v2Run.prepared), normalizeIds(v1.prepared));
    assert.deepEqual(canonicalRows(v2Run.db), canonicalRows(v1.db));
    assert.deepEqual(v2Run.calls.analysis, v1.calls.analysis);
    assert.deepEqual(v2Run.segmentation.units, [{ unitKey: v2.WHOLE_MEETING_UNIT_KEY }]);
    assert.equal(v2Run.db.rows("meeting_topics").length, 0);
    assert.ok(v2Run.prepared.source.insights.length > 0 && v2Run.prepared.source.insights.every((insight) => insight.topic_id === null));
  }
  // Whole-meeting analysis failure: v1 still clears canonical rows and returns no insights.
  const v1 = await runV1([], 4);
  const v2Run = await runV2([], 4);
  assert.deepEqual(normalizeIds(v2Run.prepared), normalizeIds(v1.prepared));
  assert.deepEqual(canonicalRows(v2Run.db), canonicalRows(v1.db));
  assert.deepEqual(canonicalRows(v2Run.db), { topics: [], insights: [] });
  assert.equal((v2Run.db.rows("meeting_analysis_job_units").find((row) => row.unit_key === v2.WHOLE_MEETING_UNIT_KEY)!.result as Row).ok, false);
});

test("[23] short-transcript fallback preserves v1: no model calls, canonical rows untouched", async () => {
  const v1 = await runV1(FIVE_TOPICS, 1);
  const v2Run = await runV2(FIVE_TOPICS, 1);
  assert.deepEqual(normalizeIds(v2Run.prepared), normalizeIds(v1.prepared));
  assert.equal(v2Run.prepared.fallbackUsed, true);
  assert.deepEqual(v2Run.segmentation, { mode: "short_transcript", units: [] });
  assert.equal(v2Run.calls.segmentation + v2Run.calls.analysis.length, 0);
  assert.deepEqual(canonicalRows(v2Run.db), canonicalRows(v1.db));
  assert.deepEqual(v2Run.db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
  assert.ok(!v2Run.db.writes.some((write) => write.name === "replace_meeting_topic_analysis_v2"));
});

test("an empty transcript fails the stage without Workflow retries (v1 parity)", async () => {
  seed({ segments: 0 });
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runTopicSegmentationUnit(input, 1), (error) => error instanceof FatalError && /No transcript available yet/.test((error as Error).message));
});

test("[24][25] a stale or superseded generation cannot persist canonical rows or the checkpoint", async () => {
  seed();
  segmentationOutput = FIVE_TOPICS;
  await runV2Units();
  db.rows("meetings")[0].execution_graph_generation = GENERATION + 1;
  await assert.rejects(v2.finalizeV2TopicExtraction(input, 1), AnalysisUnitValidationError);
  assert.ok(!db.writes.some((write) => write.name === "replace_meeting_topic_analysis_v2"));
  assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
  // A newer claim landing between canonical persistence and the checkpoint write.
  seed();
  segmentationOutput = FIVE_TOPICS;
  await runV2Units();
  const checkpoint = JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint);
  await assert.rejects(v2.finalizeV2TopicExtraction(input, 1, finalizeDeps({
    replace: async (value) => {
      const result = await v2.replaceCanonicalTopicAnalysis(value);
      Object.assign(db.rows("meeting_analysis_jobs")[0], { status: "stale" });
      return result;
    }
  })), /Stale analysis generation/);
  assert.equal(JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint), checkpoint);
  // Stale units cannot be started either.
  db.rows("meeting_analysis_jobs")[0].status = "running";
  db.rows("meetings")[0].execution_graph_generation = GENERATION + 1;
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runTopicAnalysisUnit({ ...input, unitKey: "topic:000001" }, 1), FatalError);
});

test("the stage failure marker never overwrites a stale or completed job", async () => {
  seed();
  for (const status of ["stale", "completed"]) {
    db.rows("meeting_analysis_jobs")[0].status = status;
    await v2.markV2TopicExtractionFailed({ ...input, error: "boom" });
    assert.equal(db.rows("meeting_analysis_jobs")[0].status, status);
  }
  db.rows("meeting_analysis_jobs")[0].status = "running";
  await v2.markV2TopicExtractionFailed({ ...input, error: "boom" });
  assert.deepEqual([db.rows("meeting_analysis_jobs")[0].status, db.rows("meeting_analysis_jobs")[0].error], ["failed", "boom"]);
});

test("routing: normal analysis stays on v1; v2 is an explicit, staging-only opt-in", async () => {
  const enqueue = await readFile(new URL("../lib/meeting-analysis/enqueue.ts", import.meta.url), "utf8");
  assert.match(enqueue, /options\?\.claimJob \?\? claimMeetingAnalysisJob;/);
  assert.match(enqueue, /start\(meetingAnalysisWorkflow, /);
  for (const caller of ["../app/api/meetings/[id]/analyze/route.ts", "../lib/recall/processing.ts"]) {
    const source = await readFile(new URL(caller, import.meta.url), "utf8");
    assert.doesNotMatch(source, /enqueue-v2|MeetingAnalysisV2|claim_meeting_analysis_job_v2/);
  }
  const env = process.env;
  try {
    process.env = { ...env, ANALYSIS_PIPELINE_V2_STAGING_ENABLED: "true", NEXT_PUBLIC_SUPABASE_ENV: "staging" };
    assert.equal(isAnalysisPipelineV2StagingEnabled(), true);
    process.env = { ...env, ANALYSIS_PIPELINE_V2_STAGING_ENABLED: "true", NEXT_PUBLIC_SUPABASE_ENV: "production" };
    assert.equal(isAnalysisPipelineV2StagingEnabled(), false);
    process.env = { ...env, ANALYSIS_PIPELINE_V2_STAGING_ENABLED: undefined, NEXT_PUBLIC_SUPABASE_ENV: "staging" };
    assert.equal(isAnalysisPipelineV2StagingEnabled(), false);
    process.env = { ...env, ANALYSIS_PIPELINE_V2_STAGING_ENABLED: "true", NEXT_PUBLIC_SUPABASE_ENV: undefined };
    assert.equal(isAnalysisPipelineV2StagingEnabled(), false);
  } finally {
    process.env = env;
  }
  const route = await readFile(new URL("../app/api/meetings/[id]/analyze-v2/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!isAnalysisPipelineV2StagingEnabled\(\)\) \{\s*return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\);/);
  assert.doesNotMatch(route, /x-parfait-internal-secret/);
});

test("v2 workflow wiring: v1 steps around one durable topic stage; steps are concrete and serializable", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /"use workflow";\s*await runAnalysisStageStep\(\{ \.\.\.input, stage: "transcript_normalization" \}\);/);
  assert.match(workflow, /runTopicSegmentationStep[\s\S]*runTopicAnalysisUnitStep[\s\S]*finalizeTopicExtractionStep[\s\S]*failV2TopicExtractionStep[\s\S]*STAGES_AFTER_TOPICS/);
  const steps = await readFile(new URL("../lib/meeting-analysis/v2-topic-steps.ts", import.meta.url), "utf8");
  assert.equal(steps.match(/"use step";/g)?.length, 4);
  assert.equal(steps.match(/getStepMetadata\(\)\.attempt/g)?.length, 3);
  assert.doesNotMatch(steps, /meeting_topics|extracted_insights|checkpoint/);
  assert.equal(ANALYSIS_STAGE_ORDER[1], "topic_extraction");
});

// ------------------------------------------------- v1 topic-insert fallback parity
const TWO_TOPICS: ModelTopic[] = [{ title: "Intro", segment_ids: ["s1", "s2"] }, { title: "Pricing", segment_ids: ["s3"] }];
const CHECK_VIOLATION = { code: "23514", message: 'new row for relation "meeting_topics" violates check constraint' };
const unitRows = () => db.rows("meeting_analysis_job_units");
const replaceCalls = () => db.writes.filter((write) => write.name === "replace_meeting_topic_analysis_v2").length;

test("[fallback] a rejected canonical topic insert switches to v1's whole-meeting fallback via meeting:000000", async () => {
  // v1: same segmentation, same rejection class on its meeting_topics INSERT.
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = CHECK_VIOLATION;
  const v1Prepared = await prepareMeetingAnalysis(MEETING);
  const v1Rows = canonicalRows(db);
  const v1Calls = [...modelCalls.analysis];
  assert.equal(v1Prepared.fallbackUsed, true);
  assert.equal(v1Calls.length, 1, "v1 analyzes only the whole meeting");

  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = CHECK_VIOLATION;
  const segmentation = await v2.runTopicSegmentationUnit(input, 1);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1));
  const checkpointBefore = JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint);

  const first = await v2.finalizeV2TopicExtraction(input, 1);
  assert.deepEqual(first, { status: "fallback_required", unitKey: v2.WHOLE_MEETING_UNIT_KEY });
  // The rejected topic transaction rolled back: prior canonical set and checkpoint intact.
  assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
  assert.deepEqual(db.rows("extracted_insights").map((row) => row.id), ["old-insight"]);
  assert.equal(JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint), checkpointBefore);
  const decision = unitRows().find((row) => row.stage === v2.TOPIC_PERSISTENCE_STAGE)!;
  assert.equal(decision.status, "completed");
  assert.match(String((decision.result as Row).reason), /TF001|23514/);

  await v2.runTopicAnalysisUnit({ ...input, unitKey: first.status === "fallback_required" ? first.unitKey : "" }, 1);
  const done = await v2.finalizeV2TopicExtraction(input, 1);
  assert.deepEqual(done, { status: "completed", mode: "whole_meeting", topicInsertFallback: true, topics: 0, insights: (done as { insights: number }).insights });
  const checkpoint = db.rows("meeting_analysis_jobs")[0].checkpoint as Row & { prepared: Prepared };
  assert.deepEqual(normalizeIds(checkpoint.prepared), normalizeIds(v1Prepared));
  assert.deepEqual(canonicalRows(db), v1Rows);
  assert.equal(db.rows("meeting_topics").length, 0, "no partial topic state");
  assert.ok(db.rows("extracted_insights").length > 0 && db.rows("extracted_insights").every((row) => row.topic_id === null));
  assert.equal(checkpoint.checkpointVersion, 2);
  assert.deepEqual(checkpoint.normalization, { applied: false });
  assert.equal(modelCalls.segmentation, 1, "segmentation is not re-run");
  assert.deepEqual(modelCalls.analysis.at(-1), v1Calls[0], "same whole-meeting model input as v1");
});

test("[fallback] Workflow retries at every point stay idempotent: no re-segmentation, no duplicate model calls or rows", async () => {
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = CHECK_VIOLATION;
  const segmentation = await v2.runTopicSegmentationUnit(input, 1);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1));
  await v2.finalizeV2TopicExtraction(input, 1);
  const rejectedAttempts = replaceCalls();
  // Finalizer retried before the fallback unit ran: does not retry the rejected topic transaction.
  assert.equal((await v2.finalizeV2TopicExtraction(input, 2)).status, "fallback_required");
  assert.equal(replaceCalls(), rejectedAttempts);
  await v2.runTopicAnalysisUnit({ ...input, unitKey: v2.WHOLE_MEETING_UNIT_KEY }, 1);
  const calls = modelCalls.analysis.length;
  // Retried/ambiguous fallback unit and finalizer: reuse the unit, replace the same set again.
  await v2.runTopicAnalysisUnit({ ...input, unitKey: v2.WHOLE_MEETING_UNIT_KEY }, 2);
  await v2.finalizeV2TopicExtraction(input, 2);
  const rows = canonicalRows(db);
  await v2.finalizeV2TopicExtraction(input, 3);
  await Promise.all([v2.finalizeV2TopicExtraction(input, 4), v2.finalizeV2TopicExtraction(input, 5)]);
  assert.equal(modelCalls.analysis.length, calls, "meeting:000000 analyzed exactly once");
  assert.equal(modelCalls.segmentation, 1);
  await v2.runTopicSegmentationUnit(input, 3);
  assert.equal(modelCalls.segmentation, 1, "a retried segmentation step reuses the accepted plan");
  assert.deepEqual(canonicalRows(db), rows);
  assert.equal(db.rows("meeting_topics").length, 0);
  assert.equal(unitRows().filter((row) => row.unit_key === v2.WHOLE_MEETING_UNIT_KEY).length, 1);
  assert.equal(unitRows().filter((row) => row.stage === v2.TOPIC_PERSISTENCE_STAGE).length, 1);
  // The full stage helper (as the workflow runs it) also completes after a fresh start.
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = CHECK_VIOLATION;
  assert.equal((await runV2TopicStage()).finalized.status, "completed");
  assert.deepEqual(canonicalRows(db), rows);
});

test("[boundary] connection, timeout, serialization, and resource failures are NOT converted into fallback", async () => {
  for (const failure of [
    { code: "", message: "TypeError: fetch failed" },
    { code: "08006", message: "connection failure" },
    { code: "57014", message: "canceling statement due to statement timeout" },
    { code: "40001", message: "could not serialize access" },
    { code: "53300", message: "too many connections" }
  ]) {
    seed({ segments: 3 });
    segmentationOutput = TWO_TOPICS;
    db.rejectTopicInsert = failure;
    const segmentation = await v2.runTopicSegmentationUnit(input, 1);
    await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1));
    const checkpoint = JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint);
    await assert.rejects(v2.finalizeV2TopicExtraction(input, 1), (error) =>
      error instanceof Error && error.message === failure.message
      && !(error instanceof v2.TopicPersistenceRejectedError) && !(error instanceof AnalysisUnitValidationError),
    `code ${failure.code || "(transport)"} stays a retryable failure`);
    assert.ok(!unitRows().some((row) => row.stage === v2.TOPIC_PERSISTENCE_STAGE || row.unit_key === v2.WHOLE_MEETING_UNIT_KEY));
    assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
    assert.equal(JSON.stringify(db.rows("meeting_analysis_jobs")[0].checkpoint), checkpoint);
  }
  // Documented divergence: v1 literally falls back on ANY error result from its topic INSERT,
  // including a transport error (postgrest-js returns those as { error, code: "" }).
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = { code: "", message: "TypeError: fetch failed" };
  assert.equal((await prepareMeetingAnalysis(MEETING)).fallbackUsed, true);
});

test("[fallback] meeting:000000 cannot run in topics mode unless a topic-insert rejection was recorded", async () => {
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  await v2.runTopicSegmentationUnit(input, 1);
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runTopicAnalysisUnit({ ...input, unitKey: v2.WHOLE_MEETING_UNIT_KEY }, 1), (error) =>
    error instanceof FatalError && /fallback was not triggered/.test((error as Error).message));
  assert.equal(modelCalls.analysis.length, 0);
});

test("[fallback] a stale generation cannot run or persist the whole-meeting fallback", async () => {
  seed({ segments: 3 });
  segmentationOutput = TWO_TOPICS;
  db.rejectTopicInsert = CHECK_VIOLATION;
  const segmentation = await v2.runTopicSegmentationUnit(input, 1);
  await runOrderedAnalysisUnits(segmentation.units, (unit) => v2.runTopicAnalysisUnit({ ...input, unitKey: unit.unitKey }, 1));
  await v2.finalizeV2TopicExtraction(input, 1);
  db.rows("meetings")[0].execution_graph_generation = GENERATION + 1;
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runTopicAnalysisUnit({ ...input, unitKey: v2.WHOLE_MEETING_UNIT_KEY }, 1), FatalError);
  await assert.rejects(v2.finalizeV2TopicExtraction(input, 2), AnalysisUnitValidationError);
  assert.deepEqual(db.rows("meeting_topics").map((row) => row.id), ["old-topic"]);
});

test("workflow wiring runs meeting:000000 then re-finalizes only on fallback_required", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /if \(finalized\.status === "fallback_required"\) \{[\s\S]*runTopicAnalysisUnitStep\(\{ \.\.\.input, unitKey: finalized\.unitKey \}\);\s*finalized = await finalizeTopicExtractionStep\(input\);/);
  assert.match(workflow, /if \(finalized\.status !== "completed"\) throw/);
  assert.doesNotMatch(workflow, /v2-topic-extraction/, "workflow bundle imports steps only");
});
