import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getOpenAIClient } from "../lib/openai";
import { runV4WorkItemExtraction, type V4ExecutionState } from "../lib/execution-intelligence/v4-pipeline";
import { mergeTopicWorkItems, type TopicWorkItemExtraction } from "../lib/execution-intelligence/work-item-merge";
import { extractTopicWorkItems, planTopicWorkItemScopes, requestTopicWorkItems } from "../lib/execution-intelligence/work-item-stages";
import type { RawWorkItem } from "../lib/execution-intelligence/work-item-schemas";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { AnalysisUnitValidationError, listAnalysisStageUnits, type AnalysisJobUnit } from "../lib/meeting-analysis/job-units";
import { buildPreparedMeetingAnalysis, type PreparedSourceBase } from "../lib/meeting-analysis/topics";
import { ANALYSIS_STAGE_ORDER, getMeetingAnalysisJob } from "../lib/meeting-analysis/jobs";
import { saveV2Checkpoint } from "../lib/meeting-analysis/checkpoint";
import { markV2AnalysisFailed, V2StageFailedError } from "../lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "../lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import * as v2 from "../lib/meeting-analysis/v2-candidates";
import { runOrderedAnalysisUnits } from "../lib/meeting-analysis/workflow-concurrency";
import { runMeetingAnalysisStage } from "../lib/meeting-analysis/worker";

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
const MEETING = "meeting-b22";
const JOB = "job-b22";
const GENERATION = 22;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };
const STAGE = v2.CANDIDATES_STAGE;

// --------------------------------------------------------- synthetic source (no real content)
/** Per-scope raw item counts of the generation-18 shape (numbers only): 193 raw items. */
const ITEM_COUNTS = [7, 18, 27, 15, 8, 7, 12, 12, 6, 18, 7, 29, 27];
/** Exact-evidence copies of the previous topic's first items: 35 duplicates in total. */
const COPIES = [0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2];
const SEGMENTS_PER_TOPIC = 10;
const segmentId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const EVENTS = [{ client_ref: "g22_c1_e001", type: "request", actors: ["Speaker 0"], action: "prepare", object: "x",
  temporal_state: "future", commitment_signal: "requested", source_quote: "synthetic", source_segment_ids: [segmentId(0)],
  linked_event_refs: [], confidence: 0.7 }];

/** The source goes through the REAL prepared-analysis builder, exactly as in production. B1 hands
 * it canonical topic rows that carry topic_index; the builder keeps only
 * { id, title, summary, segment_ids }, so these topics have the real prepared shape (no
 * topic_index) and the tests cannot rely on a field production does not have. */
function syntheticSource(topicCount = ITEM_COUNTS.length, options: { emptyTopic?: number; noTopics?: boolean } = {}): ExecutionSourceContext {
  const segments = topicCount * SEGMENTS_PER_TOPIC;
  const base = {
    meetingId: MEETING,
    meetingDate: "2026-10-30",
    project: null,
    transcript: Array.from({ length: segments }, (_, i) => `[${segmentId(i)}] Speaker ${i % 3}: synthetic line ${i}`).join("\n"),
    transcriptSegmentCount: segments,
    conversationEvents: EVENTS
  } as unknown as PreparedSourceBase;
  const canonicalTopicRows = options.noTopics ? [] : Array.from({ length: topicCount }, (_, t) => ({
    id: `topic-${t}`, title: `Topic ${t}`, summary: `Summary ${t}`, topic_index: t,
    segment_ids: t === options.emptyTopic ? [segmentId(9_999)] : Array.from({ length: SEGMENTS_PER_TOPIC }, (_, k) => segmentId(t * SEGMENTS_PER_TOPIC + k))
  }));
  return buildPreparedMeetingAnalysis(base, canonicalTopicRows, [], false).source;
}
const PREPARED = (source = syntheticSource()) => ({ source, fallbackUsed: false, meetingContextByTopicId: [] });

function item(t: number, k: number, patch: Partial<RawWorkItem> = {}): RawWorkItem {
  return {
    title: `Deliver t${t}k${k}x`, description: null, owner: null, owners: [], requester: null, recipient: null,
    due_date: null, due_date_text: null, status: "open", classification: "open_task", acceptance_state: "accepted",
    execution_scope: "project_work", scope_state: "current_scope", work_item_role: "action",
    classification_reason: "synthetic", source_quote: `synthetic quote t${t}k${k}`,
    source_segment_ids: [segmentId(t * SEGMENTS_PER_TOPIC + (k % SEGMENTS_PER_TOPIC))], extraction_reason: "synthetic",
    confidence: 0.5, ...patch
  };
}
/** Topic t's model output: copies of topic t-1's first items (exact evidence, higher confidence),
 * then unique items. */
function itemsForTopic(t: number): RawWorkItem[] {
  if (t >= ITEM_COUNTS.length) return [item(t, 0)];
  const previous = t > 0 ? itemsForTopic(t - 1) : [];
  return Array.from({ length: ITEM_COUNTS[t] }, (_, k) =>
    k < COPIES[t] ? { ...previous[k], confidence: 0.6 + (t % 3) / 10 } : item(t, k));
}

// --------------------------------------------------------- deterministic fake model
const model = {
  calls: [] as string[],
  contexts: [] as Row[],
  inFlight: 0,
  maxInFlight: 0,
  failTopics: new Set<string>(),
  gate: null as null | ((topicId: string) => Promise<void>),
  itemsFor: (topicId: string | null): RawWorkItem[] => itemsForTopic(topicId === null ? 0 : Number(topicId.split("-")[1]))
};
function resetModel() {
  Object.assign(model, { calls: [], contexts: [], inFlight: 0, maxInFlight: 0, failTopics: new Set<string>(), gate: null });
  model.itemsFor = (topicId) => itemsForTopic(topicId === null ? 0 : Number(topicId.split("-")[1]));
}
const openai = getOpenAIClient();
Object.assign(openai.responses, {
  create: async (body: { input: Array<{ content: string }>; text: { format: { name: string } } }) => {
    assert.equal(body.text.format.name, "execution_v4_work_item_extraction");
    const context = JSON.parse(body.input[1].content) as { topic: { id: string | null } };
    const topicId = context.topic.id;
    model.calls.push(String(topicId));
    model.contexts.push(context as unknown as Row);
    model.inFlight += 1;
    model.maxInFlight = Math.max(model.maxInFlight, model.inFlight);
    try {
      if (model.gate) await model.gate(String(topicId));
      else await new Promise((resolve) => setImmediate(resolve));
      if (model.failTopics.has(String(topicId))) return { output_text: "" };
      return { output_text: JSON.stringify({ items: model.itemsFor(topicId) }), usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
    } finally {
      model.inFlight -= 1;
    }
  }
});

// --------------------------------------------------------- fake database
let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);
const NORMALIZATION = { enabled: true, segments: 130 };
const UNKNOWN = { future: { keep: true } };
const b2Checkpoint = (source = syntheticSource()): Row => ({
  checkpointVersion: 2, v2Topology: "b2", normalization: NORMALIZATION, unknownFutureKey: UNKNOWN,
  prepared: PREPARED(source), engine: "v4"
});
function seed(job: Row = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running",
      started_at: "x", retry_count: 0, current_stage: "conversation_events", progress: 22, checkpoint: b2Checkpoint(), ...job
    }]
  });
  return db;
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const units = () => db.rows("meeting_analysis_job_units");
const jobWrites = () => db.writes.filter((write) => write.table === "meeting_analysis_jobs" && write.op === "update");
const savedV4State = () => (jobRow().checkpoint as Row).v4State as V4ExecutionState;
const realUnitDeps = (): v2.V2CandidateUnitDeps => ({
  execute: executeV2AnalysisUnit, persistence: b2UnitPersistence, loadJob: getMeetingAnalysisJob, extract: requestTopicWorkItems
});

/** Mirrors meetingAnalysisV2Workflow's candidates stage (steps are thin wrappers). */
async function runV2Stage(order?: number[]) {
  const plan = await v2.planV2Candidates(input, 1);
  assert.equal(plan.mode, "durable");
  if (order) {
    for (const index of order) await v2.runV2CandidateUnit({ ...input, unitKey: plan.units[index].unitKey }, 1);
  } else {
    await runOrderedAnalysisUnits(plan.units, (unit) => v2.runV2CandidateUnit({ ...input, unitKey: unit.unitKey }, 1));
  }
  return v2.finalizeV2Candidates(input, 1);
}
/** Timing is the only metric that legitimately differs (v1: pool wall time; v2: summed model time). */
function withoutTiming(state: V4ExecutionState) {
  const clone = structuredClone(state);
  delete (clone.metrics.openAiLatencyMs as Row).workItemExtraction;
  return clone;
}

// ================================================================= plan / keys
test("[1][2][4] the scope plan is v1's, deterministic, keyed by prepared topic position; empty topics leave gaps", async () => {
  const source = syntheticSource();
  // Real prepared topic shape: the builder drops topic_index, so planning has no canonical index to
  // validate. Keys come from each topic's position, which B1 guarantees equals its topic_index.
  assert.ok(source.topics.every((topic) => JSON.stringify(Object.keys(topic).sort()) === JSON.stringify(["id", "segment_ids", "summary", "title"])));
  const planned = v2.planCandidateUnits(source);
  assert.deepEqual(planned, v2.planCandidateUnits(syntheticSource()));
  assert.deepEqual(planned.map(({ unitKey }) => unitKey), ITEM_COUNTS.map((_, t) => `topic:${String(t).padStart(6, "0")}`));
  assert.deepEqual(planned.map(({ scope }) => scope), planTopicWorkItemScopes(source));
  const gapped = v2.planCandidateUnits(syntheticSource(4, { emptyTopic: 2 }));
  assert.deepEqual(gapped.map(({ unitKey }) => unitKey), ["topic:000000", "topic:000001", "topic:000003"]);
  assert.deepEqual(gapped.map(({ scope }) => scope.topicId), ["topic-0", "topic-1", "topic-3"]);
  // Prepared order IS the plan order: planning never re-sorts or rejects. Canonical topic_index
  // order is owned by the B1 topic finalizer, which validates it before `prepared` is saved.
  const reordered = syntheticSource(3);
  reordered.topics.reverse();
  assert.deepEqual(v2.planCandidateUnits(reordered).map(({ unitKey, scope }) => [unitKey, scope.topicId]),
    [["topic:000000", "topic-2"], ["topic:000001", "topic-1"], ["topic:000002", "topic-0"]]);
  // Plan step: keys only, current_stage/progress, no model call.
  resetModel();
  seed();
  const plan = await v2.planV2Candidates(input, 3);
  assert.deepEqual(plan, { mode: "durable", units: planned.map(({ unitKey }) => ({ unitKey })) });
  assert.deepEqual([jobRow().current_stage, jobRow().progress, jobRow().retry_count], ["candidates", 35, 2]);
  assert.equal(model.calls.length, 0);
});

test("[3] no topics: one whole-meeting scope keyed meeting:000000, matching v1", async () => {
  resetModel();
  const source = syntheticSource(2, { noTopics: true });
  assert.deepEqual(v2.planCandidateUnits(source).map(({ unitKey }) => unitKey), ["meeting:000000"]);
  const v1 = await runV4WorkItemExtraction({ source, fallbackUsed: false });
  resetModel();
  seed({ checkpoint: b2Checkpoint(source) });
  await runV2Stage();
  assert.deepEqual(withoutTiming(savedV4State()), withoutTiming(v1));
  assert.equal(savedV4State().topicWorkItems[0].topicId, null);
  for (const bad of ["meeting:000001", "topic:1", "topic:0000001", "chunk:000000"]) {
    await assert.rejects(v2.runV2CandidateUnit({ ...input, unitKey: bad }, 1), AnalysisUnitValidationError);
  }
});

// ================================================================= v1 parity
test("[32][20][21][22][23][24][34] v1 and v2 produce deep-equal v4State; the synthetic ledger is 193 raw -> 158 merged", async () => {
  resetModel();
  const v1 = await runV4WorkItemExtraction({ source: syntheticSource(), fallbackUsed: false });
  const v1Calls = model.calls.length;
  resetModel();
  seed();
  const outcome = await runV2Stage();
  const state = savedV4State();
  assert.deepEqual(withoutTiming(state), withoutTiming(v1));
  assert.deepEqual(outcome, { topics: 13, items: 158 });
  assert.equal(model.calls.length, v1Calls);
  assert.equal(model.calls.length, 13);
  // The generation-18 structural counts, from synthetic data.
  assert.equal(state.topicWorkItems.reduce((sum, topic) => sum + topic.items.length, 0), 193);
  assert.deepEqual([state.mergedWorkItems.length, state.metrics.deduplicatedTasks, state.metrics.candidateTasks], [158, 35, 158]);
  assert.deepEqual(state.mergedWorkItems.map((item) => item.ref), Array.from({ length: 158 }, (_, i) => `wi_${i + 1}`));
  assert.deepEqual(state.metrics.openAiUsage.workItemExtraction, { input_tokens: 1300, output_tokens: 130, total_tokens: 1430 });
  // mergeTopicWorkItems unchanged: re-merging the stored topic lists reproduces the ledger.
  assert.deepEqual(mergeTopicWorkItems(state.topicWorkItems), { items: state.mergedWorkItems, deduplicated: 35 });
  // topicWorkItems keep v1's exact shape, including each scope's transcript slice.
  assert.deepEqual(Object.keys(state.topicWorkItems[0]).sort(), ["items", "topicId", "topicTitle", "transcript"]);
  // Later-stage fields start exactly as v1 leaves them.
  assert.deepEqual(
    [state.globalCorrections, state.globalAdditions, state.eligibleWorkItems, state.draftGroups, state.tree, state.graph, state.finalValidation],
    [[], [], [], [], { commitments: [], standalone_tasks: [] }, { commitments: [], tasks: [] }, { ok: true, errors: [] }]
  );
  assert.deepEqual(state.workItems, state.mergedWorkItems, "workItems starts as the merged ledger");

  // The v1 worker's checkpoint for the same job state matches the v2 finalizer's.
  resetModel();
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "v4" } });
  await runMeetingAnalysisStage({ ...input, stage: "candidates" });
  const v1Checkpoint = jobRow().checkpoint as Row;
  assert.deepEqual(withoutTiming(v1Checkpoint.v4State as V4ExecutionState), withoutTiming(state));
});

test("[18][19][17] topic order changes the merge when reversed; the finalizer always restores plan order", async () => {
  // Structural order sensitivity (generation-18 property) without real content: B is a
  // near-duplicate of A and of C, but A and C have incompatible owners.
  const base = (patch: Partial<RawWorkItem>) => item(0, 0, { title: "Deliver the onboarding checklist", ...patch });
  const a = base({ owner: "ann", source_segment_ids: [segmentId(1)], source_quote: "a", confidence: 0.4 });
  const b = base({ owner: null, source_segment_ids: [segmentId(1), segmentId(2)], source_quote: "b", confidence: 0.9 });
  const c = base({ owner: "cat", source_segment_ids: [segmentId(2)], source_quote: "c", confidence: 0.5 });
  const topics = (order: RawWorkItem[][]): TopicWorkItemExtraction[] =>
    order.map((items, t) => ({ topicId: `topic-${t}`, topicTitle: `Topic ${t}`, transcript: "", items }));
  const forward = mergeTopicWorkItems(topics([[a], [c], [b]]));
  const reversed = mergeTopicWorkItems(topics([[b], [c], [a]]));
  assert.notDeepEqual(forward.items.map((x) => [x.owner, x.owners, x.source_quote]), reversed.items.map((x) => [x.owner, x.owners, x.source_quote]));

  // The same property through the full synthetic ledger: reversing topics changes the result.
  resetModel();
  seed();
  await runV2Stage();
  const planOrder = structuredClone(savedV4State().mergedWorkItems);
  const reversedLedger = mergeTopicWorkItems([...savedV4State().topicWorkItems].reverse()).items;
  assert.notDeepEqual(reversedLedger, planOrder);

  // Completion order never matters: 1,0,3,2,... and fully reversed both produce the plan-order ledger.
  for (const order of [[1, 0, 3, 2, ...ITEM_COUNTS.slice(4).map((_, i) => i + 4)], ITEM_COUNTS.map((_, i) => 12 - i)]) {
    resetModel();
    seed();
    await runV2Stage(order);
    assert.deepEqual(savedV4State().mergedWorkItems, planOrder);
  }
});

test("[33][12][11] a handled failed scope stores ok:false; the first failure in plan order fails the stage like v1", async () => {
  resetModel();
  model.failTopics = new Set(["topic-7", "topic-3"]);
  // v1: stage throws v1's stageFailure message (first failure in scope order) and stops launching.
  await assert.rejects(runV4WorkItemExtraction({ source: syntheticSource(), fallbackUsed: false }),
    /^Error: v4_work_item_extraction: OpenAI returned empty work_item_extraction output\.$/);
  assert.ok(model.calls.length < 13, `v1 stopped after ${model.calls.length} calls`);
  const v1Message = "v4_work_item_extraction: OpenAI returned empty work_item_extraction output.";

  resetModel();
  model.failTopics = new Set(["topic-7", "topic-3"]);
  seed();
  const before = structuredClone(jobRow().checkpoint);
  const plan = await v2.planV2Candidates(input, 1);
  await runOrderedAnalysisUnits(plan.units, (unit) => v2.runV2CandidateUnit({ ...input, unitKey: unit.unitKey }, 1));
  const failed = units().filter((unit) => (unit.result as Row).ok === false).map((unit) => [unit.unit_key, unit.status, unit.attempt]);
  assert.deepEqual(failed, [["topic:000003", "completed", 1], ["topic:000007", "completed", 1]]);
  assert.deepEqual(units().find((unit) => unit.unit_key === "topic:000003")!.result,
    { ok: false, error: "OpenAI returned empty work_item_extraction output.", latencyMs: (units().find((unit) => unit.unit_key === "topic:000003")!.result as Row).latencyMs, validationFailure: false });
  await assert.rejects(v2.finalizeV2Candidates(input, 1), (error) => error instanceof V2StageFailedError && error.message === v1Message);
  // v1 parity of the terminal row (v1's stage step leaves failed / candidates / 35).
  assert.deepEqual([jobRow().status, jobRow().current_stage, jobRow().progress, jobRow().error], ["failed", "candidates", 35, v1Message]);
  assert.deepEqual(jobRow().checkpoint, before, "no partial ledger is ever written");
  // The v1 worker raises the identical message.
  resetModel();
  model.failTopics = new Set(["topic-7", "topic-3"]);
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "v4" } });
  await assert.rejects(runMeetingAnalysisStage({ ...input, stage: "candidates" }), (error) => (error as Error).message === v1Message);
});

// ================================================================= concurrency / units
test("[5][6] at most two model calls in flight; exactly one call per unit; every unit sees the finalized events", async () => {
  resetModel();
  seed();
  await runV2Stage();
  assert.equal(model.maxInFlight, 2);
  assert.deepEqual([...model.calls].sort(), ITEM_COUNTS.map((_, t) => `topic-${t}`).sort());
  assert.ok(model.contexts.every((context) => JSON.stringify(context.conversation_events) === JSON.stringify(EVENTS)));
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /runOrderedAnalysisUnits\(candidates\.units, \(unit\) =>\s*runCandidateUnitStep/);
});

test("[7][8] a completed unit skips the model on retry; the first completed result wins", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Candidates(input, 1);
  const unitKey = plan.units[4].unitKey;
  await v2.runV2CandidateUnit({ ...input, unitKey }, 1);
  const stored = structuredClone(units()[0].result);
  const ack = await v2.runV2CandidateUnit({ ...input, unitKey }, 2, {
    ...realUnitDeps(), extract: async () => { throw new Error("the model must not be called again"); }
  });
  assert.deepEqual(ack, { unitKey, ok: true });
  assert.equal(model.calls.length, 1);
  assert.deepEqual(units()[0].result, stored);
});

test("[9][10] units never write the checkpoint and store only the scope result (no transcript/checkpoint/v4State)", async () => {
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint);
  const plan = await v2.planV2Candidates(input, 1);
  const writesBefore = jobWrites().length;
  await runOrderedAnalysisUnits(plan.units, (unit) => v2.runV2CandidateUnit({ ...input, unitKey: unit.unitKey }, 1));
  assert.equal(jobWrites().length, writesBefore);
  assert.deepEqual(jobRow().checkpoint, before);
  for (const unit of units()) {
    const result = unit.result as Row;
    assert.deepEqual(Object.keys(result).sort(), ["items", "latencyMs", "ok", "salvagedItems", "usage"]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic line|"transcript"|"topicWorkItems"|"mergedWorkItems"|"prepared"|"metrics"/);
    // Raw items only: no global refs or topic_id yet.
    assert.ok((result.items as Row[]).every((item) => !("ref" in item) && !("topic_id" in item)));
  }
  // Size: the largest synthetic scope has 29 items (generation 18's largest); well under 25 KB.
  const largest = units().find((unit) => unit.unit_key === "topic:000011")!;
  assert.equal(((largest.result as Row).items as unknown[]).length, 29);
  assert.ok(JSON.stringify(largest.result).length < 25_000, `${JSON.stringify(largest.result).length} bytes`);
});

test("[13] a thrown DB/infrastructure error stays Workflow-retryable; the retry calls the model once", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Candidates(input, 1);
  const unitKey = plan.units[0].unitKey;
  const { FatalError } = await import("workflow");
  await assert.rejects(
    v2.runV2CandidateUnit({ ...input, unitKey }, 1, { ...realUnitDeps(), loadJob: async () => { throw new Error("connection reset"); } }),
    (error) => !(error instanceof FatalError) && /connection reset/.test((error as Error).message)
  );
  assert.deepEqual([units()[0].status, units()[0].attempt, model.calls.length], ["failed", 1, 0]);
  await v2.runV2CandidateUnit({ ...input, unitKey }, 2, realUnitDeps());
  assert.deepEqual([units()[0].status, units()[0].attempt, model.calls.length], ["completed", 2, 1]);
});

// ================================================================= finalizer validation
function unit(unitKey: string, result: unknown, patch: Partial<AnalysisJobUnit> = {}): AnalysisJobUnit {
  return {
    job_id: JOB, stage: STAGE, unit_key: unitKey, status: "completed", result: result as AnalysisJobUnit["result"],
    error: null, attempt: 1, started_at: null, completed_at: null, created_at: "x", updated_at: "x", ...patch
  };
}

test("[14][15][16] missing, unexpected, duplicate, mismatched, incomplete and malformed units fail finalization", async () => {
  const ok = { ok: true, items: [], latencyMs: 1, salvagedItems: 0, usage: null };
  const keys = ["topic:000000", "topic:000001", "topic:000003"];
  const cases: Array<[string, AnalysisJobUnit[], RegExp]> = [
    ["missing", [unit("topic:000000", ok), unit("topic:000003", ok)], /Missing candidate unit topic:000001/],
    ["unexpected (skipped empty topic)", [unit("topic:000000", ok), unit("topic:000001", ok), unit("topic:000002", ok), unit("topic:000003", ok)], /Unexpected candidate unit topic:000002/],
    ["unexpected key", [...keys.map((key) => unit(key, ok)), unit("meeting:000000", ok)], /Unexpected candidate unit meeting:000000/],
    ["duplicate", [unit("topic:000000", ok), unit("topic:000001", ok), unit("topic:000001", ok), unit("topic:000003", ok)], /Duplicate candidate unit topic:000001/],
    ["running", [unit("topic:000000", ok), unit("topic:000001", null, { status: "running" }), unit("topic:000003", ok)], /topic:000001 is not completed/],
    ["malformed", [unit("topic:000000", ok), unit("topic:000001", { ok: true }), unit("topic:000003", ok)], /Malformed candidate unit topic:000001/]
  ];
  for (const [label, list, message] of cases) {
    assert.throws(() => v2.orderCandidateUnits(keys, list), (error) => error instanceof AnalysisUnitValidationError && message.test((error as Error).message), label);
  }
  // Through the real finalizer: a partial stage never writes v4State.
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint);
  const plan = await v2.planV2Candidates(input, 1);
  for (const planned of plan.units.slice(0, 12)) await v2.runV2CandidateUnit({ ...input, unitKey: planned.unitKey }, 1);
  await assert.rejects(v2.finalizeV2Candidates(input, 1), /Missing candidate unit topic:000012/);
  assert.deepEqual(jobRow().checkpoint, before);
  assert.equal(jobRow().status, "running", "a validation failure is not a stage failure marker");
});

// ================================================================= checkpoint preservation
test("[26][27][28][29] the finalizer writes only v4State (plus v1's prepared/engine) and keeps every other key", async () => {
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint as Row);
  await runV2Stage();
  const saved = jobRow().checkpoint as Row;
  const { v4State, ...rest } = saved;
  assert.deepEqual(rest, before);
  assert.deepEqual([saved.checkpointVersion, saved.v2Topology, saved.engine], [2, "b2", "v4"]);
  assert.deepEqual(saved.normalization, NORMALIZATION);
  assert.deepEqual(saved.unknownFutureKey, UNKNOWN);
  assert.ok(v4State);
  await v2.finalizeV2Candidates(input, 2);
  assert.deepEqual(jobRow().checkpoint, saved, "re-finalizing is idempotent");
});

// ================================================================= barrier / guards
test("[25] candidates cannot plan, run or finalize before conversation events are finalized", async () => {
  resetModel();
  const { conversationEvents: _events, ...withoutEvents } = syntheticSource();
  seed({ checkpoint: b2Checkpoint(withoutEvents as ExecutionSourceContext) });
  const before = structuredClone(jobRow());
  await assert.rejects(v2.planV2Candidates(input, 1), /Conversation events are not finalized/);
  await assert.rejects(v2.runV2CandidateUnit({ ...input, unitKey: "topic:000000" }, 1), /Conversation events are not finalized/);
  await assert.rejects(v2.finalizeV2Candidates(input, 1), /Conversation events are not finalized/);
  assert.equal(model.calls.length, 0);
  assert.deepEqual(jobRow().checkpoint, before.checkpoint);
  // Candidates (v1 worker and v2 units) never read conversation-event unit rows.
  for (const file of ["../lib/meeting-analysis/v2-candidates.ts", "../lib/meeting-analysis/worker.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /CONVERSATION_EVENTS_STAGE|"conversation_events", |listAnalysisStageUnits\(input\.jobId, "conversation_events"/);
  }
});

test("[31][30] old B1, wrong-version, terminal and stale jobs are rejected before model work or writes", async () => {
  const { v2Topology: _dropped, ...b1Checkpoint } = b2Checkpoint();
  const { FatalError } = await import("workflow");
  for (const [label, patch, message] of [
    ["old B1 job", { checkpoint: b1Checkpoint }, /B2 v2 topology/],
    ["pipeline v1", { pipeline_version: 1 }, /version 2/],
    ["missing checkpointVersion", { checkpoint: { ...b2Checkpoint(), checkpointVersion: undefined } }, /version 2/],
    ["failed job", { status: "failed" }, /terminal/],
    ["completed job", { status: "completed" }, /terminal/],
    ["stale generation", { generation: GENERATION - 1 }, /Stale analysis generation/]
  ] as const) {
    resetModel();
    seed(patch as Row);
    const before = structuredClone(jobRow());
    await assert.rejects(v2.planV2Candidates(input, 1), message, label);
    await assert.rejects(v2.runV2CandidateUnit({ ...input, unitKey: "topic:000000" }, 1),
      (error) => error instanceof FatalError && message.test((error as Error).message), label);
    await assert.rejects(v2.finalizeV2Candidates(input, 1), message, label);
    assert.equal(model.calls.length, 0, label);
    assert.deepEqual(units(), [], label);
    assert.deepEqual(jobRow(), before, label);
  }
  // A newer claim landing between validation and the v4State write.
  resetModel();
  seed();
  const plan = await v2.planV2Candidates(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2CandidateUnit({ ...input, unitKey: planned.unitKey }, 1));
  const checkpoint = structuredClone(jobRow().checkpoint);
  await assert.rejects(v2.finalizeV2Candidates(input, 1, {
    validate: assertB2AnalysisJob,
    markRunning: async () => { Object.assign(jobRow(), { status: "stale" }); },
    markFailed: markV2AnalysisFailed,
    listUnits: listAnalysisStageUnits,
    saveCheckpoint: saveV2Checkpoint
  }), /Stale analysis generation/);
  assert.deepEqual(jobRow().checkpoint, checkpoint);
});

test("the independent engine keeps the unchanged v1 candidates step", async () => {
  resetModel();
  seed({ checkpoint: { ...b2Checkpoint(), engine: "independent" } });
  assert.deepEqual(await v2.planV2Candidates(input, 1), { mode: "monolithic", units: [] });
  await assert.rejects(v2.finalizeV2Candidates(input, 1), /require the v4 engine/);
  assert.equal(model.calls.length, 0);
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /if \(candidates\.mode === "durable"\) \{[\s\S]*?\} else \{\s*await runV2AnalysisStageStep\(\{ \.\.\.input, stage: "candidates" \}\);\s*\}/);
});

test("[35] durable harvest and completeness follow candidates; lifecycle and later stages stay monolithic", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  const body = workflow.slice(workflow.indexOf("export async function meetingAnalysisV2Workflow"));
  const order = ["finalizeConversationEventsStep(input)", "planCandidatesStep(input)", "runCandidateUnitStep(", "finalizeCandidatesStep(input)", "planAtomicActionHarvestStep(input)", "runAtomicActionHarvestUnitStep(", "finalizeAtomicActionHarvestStep(input)", "planCompletenessPrimaryStep(input)", "runCompletenessPrimaryUnitStep(", "finalizeCompletenessPrimaryStep(input)", "runCompletenessCoverageUnitStep(", "finalizeCompletenessStep(input)", "for (const stage of STAGES_AFTER_CANDIDATES)"]
    .map((marker) => body.indexOf(marker));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `ordered: ${order}`);
  assert.deepEqual(ANALYSIS_STAGE_ORDER.slice(ANALYSIS_STAGE_ORDER.indexOf("candidates") + 1),
    ["global_correction", "verification", "completeness", "final_verification", "task_consolidation", "synthesis", "persistence"]);
  assert.match(body, /for \(const stage of STAGES_AFTER_CANDIDATES\) \{\s*await runV2AnalysisStageStep\(\{ \.\.\.input, stage \}\);/);
  const steps = await readFile(new URL("../lib/meeting-analysis/v2-candidate-steps.ts", import.meta.url), "utf8");
  assert.equal(steps.match(/"use step";/g)?.length, 3);
  assert.equal(steps.match(/getStepMetadata\(\)\.attempt/g)?.length, 3);
  assert.doesNotMatch(steps, /checkpoint|meeting_analysis_jobs/);
});

test("v1 extractTopicWorkItems keeps its pool: two workers, one call per scope, results in scope order", async () => {
  resetModel();
  const releases: Array<() => void> = [];
  model.gate = () => new Promise<void>((resolve) => {
    releases.push(resolve);
    if (releases.length % 2 === 0) { releases[releases.length - 1](); releases[releases.length - 2](); }
  });
  model.itemsFor = (topicId) => itemsForTopic(Number(String(topicId).split("-")[1]));
  const source = syntheticSource();
  // 13 scopes: release the odd one out once everything else has been dispatched.
  const pending = extractTopicWorkItems(source);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releases.forEach((release) => release());
  const gated = await pending;
  resetModel();
  const plain = await extractTopicWorkItems(source);
  assert.ok(gated.ok && plain.ok);
  assert.deepEqual(gated.topics, plain.topics);
  assert.equal(model.maxInFlight, 2);
  assert.equal(model.calls.length, 13);
});
