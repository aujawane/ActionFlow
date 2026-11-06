import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { APIError, APIUserAbortError } from "openai";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getOpenAIClient } from "../lib/openai";
import {
  extractAndLinkConversationEvents,
  extractConversationEvents,
  mergeConversationEventChunkResults,
  planConversationEventChunks,
  type ConversationEventStageResult
} from "../lib/execution-intelligence/conversation-events";
import type { ConversationEvent } from "../lib/execution-intelligence/conversation-event-schemas";
import { RetryableProviderError } from "../lib/execution-intelligence/provider-errors";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { workflowErrorMessage } from "../lib/meeting-analysis/error-message";
import { AnalysisUnitValidationError, listAnalysisStageUnits, type AnalysisJobUnit } from "../lib/meeting-analysis/job-units";
import { ANALYSIS_STAGE_ORDER } from "../lib/meeting-analysis/jobs";
import * as v2 from "../lib/meeting-analysis/v2-conversation-events";
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
const MEETING = "meeting-b21";
const JOB = "job-b21";
const GENERATION = 21;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };
const STAGE = v2.CONVERSATION_EVENTS_STAGE;

// --------------------------------------------------------- synthetic benchmark-shaped source
/** 854 synthetic segments in 13 topics of 66 -- the benchmark's shape (24 chunks), no real content. */
const segmentId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const segmentIndex = (id: string) => Number(id.slice(-12));
function syntheticSource(segments = 854, topicSize = 66): ExecutionSourceContext {
  return {
    meetingId: MEETING,
    meetingDate: "2026-10-30",
    transcript: Array.from({ length: segments }, (_, index) => `[${segmentId(index)}] Speaker ${index % 3}: synthetic line ${index}`).join("\n"),
    transcriptSegmentCount: segments,
    topics: Array.from({ length: Math.ceil(segments / topicSize) }, (_, topic) => ({
      id: `topic-${topic}`, title: `Topic ${topic}`, summary: null,
      segment_ids: Array.from({ length: Math.min(topicSize, segments - topic * topicSize) }, (_, k) => segmentId(topic * topicSize + k))
    })),
    insights: []
  } as unknown as ExecutionSourceContext;
}
const PREPARED = () => ({ source: syntheticSource(), fallbackUsed: false, meetingContextByTopicId: [] });
const NORMALIZATION = { enabled: true, segments: 854 };
const UNKNOWN = { future: { keep: true } };
const b2Checkpoint = (): Row => ({
  checkpointVersion: 2, v2Topology: "b2", normalization: NORMALIZATION, unknownFutureKey: UNKNOWN,
  prepared: PREPARED(), engine: "v4"
});

// --------------------------------------------------------- deterministic fake model
/** Every 9th segment is a request, the next an acceptance of it. Events depend only on the
 * segment, so overlapping chunks re-emit the same event (exactly what dedup must collapse). */
function modelEventsFor(transcript: string) {
  const ids = Array.from(transcript.matchAll(/^\[([0-9a-f-]{36})\]/gim), (match) => match[1]);
  const events: Row[] = [];
  for (const id of ids) {
    const index = segmentIndex(id);
    const item = `deliverable ${Math.floor(index / 9)}`;
    if (index % 9 === 0) {
      events.push({ client_ref: `r${index}`, type: "request", actors: ["Speaker 0"], action: "prepare", object: item,
        temporal_state: "future", commitment_signal: "requested", source_quote: `synthetic line ${index}`,
        source_segment_ids: [id], linked_event_refs: [], confidence: 0.6 + (index % 4) / 10 });
    } else if (index % 9 === 1) {
      events.push({ client_ref: `a${index}`, type: "acceptance", actors: ["Speaker 1"], action: "prepare", object: item,
        temporal_state: "future", commitment_signal: "accepted", source_quote: `synthetic line ${index}`,
        source_segment_ids: [id], linked_event_refs: ids.includes(segmentId(index - 1)) ? [`r${index - 1}`] : [], confidence: 0.8 });
    }
  }
  return events;
}

const model = {
  calls: [] as number[],
  inFlight: 0,
  maxInFlight: 0,
  /** Chunks (by first segment index) whose model call fails as a handled `{ ok: false }`. */
  failStarts: new Set<number>(),
  /** Optional per-call gate to control completion order. */
  gate: null as null | ((start: number) => Promise<void>)
};
function resetModel() {
  Object.assign(model, { calls: [], inFlight: 0, maxInFlight: 0, failStarts: new Set<number>(), gate: null });
}
const openai = getOpenAIClient();
Object.assign(openai.responses, {
  create: async (body: { input: Array<{ content: string }>; text: { format: { name: string } } }) => {
    assert.equal(body.text.format.name, "conversation_events");
    const { transcript } = JSON.parse(body.input[1].content) as { transcript: string };
    const start = segmentIndex(/^\[([0-9a-f-]{36})\]/i.exec(transcript)![1]);
    model.calls.push(start);
    model.inFlight += 1;
    model.maxInFlight = Math.max(model.maxInFlight, model.inFlight);
    try {
      if (model.gate) await model.gate(start);
      else await new Promise((resolve) => setImmediate(resolve));
      if (model.failStarts.has(start)) return { output_text: "" };
      return { output_text: JSON.stringify({ events: modelEventsFor(transcript) }) };
    } finally {
      model.inFlight -= 1;
    }
  }
});

// --------------------------------------------------------- fake database
let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);
function seed(job: Row = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running",
      started_at: "x", retry_count: 0, current_stage: "topic_extraction", progress: 10, checkpoint: b2Checkpoint(), ...job
    }]
  });
  return db;
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const units = () => db.rows("meeting_analysis_job_units");
const jobWrites = () => db.writes.filter((write) => write.table === "meeting_analysis_jobs" && write.op === "update");

/** Mirrors meetingAnalysisV2Workflow's conversation_events stage (steps are thin wrappers). */
async function runV2Stage(order?: number[]) {
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  if (order) {
    for (const index of order) await v2.runV2ConversationEventUnit({ ...input, unitKey: planned[index].unitKey }, 1);
  } else {
    await runOrderedAnalysisUnits(planned, (unit) => v2.runV2ConversationEventUnit({ ...input, unitKey: unit.unitKey }, 1));
  }
  return v2.finalizeV2ConversationEvents(input, 1);
}
const v2Events = () => ((jobRow().checkpoint as Row).prepared as { source: ExecutionSourceContext }).source.conversationEvents;
async function v1Events(source = syntheticSource()) {
  const result = await extractAndLinkConversationEvents(source, { generation: GENERATION });
  return result;
}

// ================================================================= plan / keys
test("[1][2][3] the plan is the v1 chunker, deterministic, with stable zero-padded keys (24 for the benchmark shape)", async () => {
  resetModel();
  seed();
  const first = await v2.planV2ConversationEvents(input, 1);
  const second = await v2.planV2ConversationEvents(input, 1);
  assert.deepEqual(first, second);
  assert.equal(first.units.length, 24);
  assert.deepEqual(first.units.map((unit) => unit.unitKey), Array.from({ length: 24 }, (_, i) => `chunk:${String(i).padStart(6, "0")}`));
  const chunks = planConversationEventChunks(syntheticSource());
  assert.equal(chunks.length, 24);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.index, index);
    const size = chunk.endSegment - chunk.startSegment + 1;
    assert.ok(index === chunks.length - 1 || (size >= 40 && size <= 50), `chunk ${index} size ${size}`);
    if (index > 0) assert.equal(chunks[index - 1].endSegment - chunk.startSegment + 1, 5, "5-segment overlap");
  });
  assert.equal(model.calls.length, 0, "planning makes no model call");
  assert.deepEqual([v2.conversationEventUnitKey(0), v2.conversationEventUnitKey(23), v2.parseConversationEventUnitKey("chunk:000023")], ["chunk:000000", "chunk:000023", 23]);
  for (const bad of ["chunk:23", "chunk:0000023", "topic:000001", "chunk:-00001"]) {
    assert.throws(() => v2.parseConversationEventUnitKey(bad), AnalysisUnitValidationError);
  }
  assert.equal((jobRow() as Row).current_stage, "conversation_events");
  assert.equal((jobRow() as Row).progress, 22);
});

// ================================================================= v1 parity
test("[28][12][14] v1 and v2 produce deep-equal conversation events and checkpoint `prepared` for the same model outputs", async () => {
  resetModel();
  const v1 = await v1Events();
  assert.ok(v1.ok);
  const v1Calls = model.calls.length;
  resetModel();
  seed();
  const outcome = await runV2Stage();
  assert.deepEqual(outcome, { ok: true, events: v1.events.length });
  assert.deepEqual(v2Events(), v1.events);
  assert.equal(model.calls.length, v1Calls, "same model call count");
  assert.equal(model.calls.length, 24);
  // Refs are v1's canonical g{generation}_c{chunk}_eNNN, and acceptances link to their requests.
  assert.ok(v1.events.every((event) => /^g21_c\d+_e\d{3}$/.test(event.client_ref)));
  const accepted = v1.events.filter((event) => event.type === "acceptance");
  assert.ok(accepted.length > 0 && accepted.every((event) => event.linked_event_refs.length > 0));

  // The v1 worker's checkpoint `prepared` equals the v2 finalizer's for the same job state.
  resetModel();
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "v4" } });
  await runMeetingAnalysisStage({ ...input, stage: "conversation_events" });
  const v1Prepared = (jobRow().checkpoint as Row).prepared;
  resetModel();
  seed();
  await runV2Stage();
  assert.deepEqual((jobRow().checkpoint as Row).prepared, v1Prepared);
});

test("[29][15] one handled failed chunk produces conversationEvents=[] in both v1 and v2; the pipeline continues", async () => {
  resetModel();
  model.failStarts.add(planConversationEventChunks(syntheticSource())[5].startSegment - 1);
  const v1 = await v1Events();
  assert.equal(v1.ok, false);
  assert.match(v1.ok ? "" : v1.error, /^Conversation event chunk 6 failed: OpenAI returned empty conversation event output\.$/);
  // v1 still stops launching chunks after a failure (pool of 2).
  assert.ok(model.calls.length < 24, `v1 stopped early after ${model.calls.length} calls`);
  seed();
  const outcome = await runV2Stage();
  assert.deepEqual(outcome, { ok: false, events: 0 });
  assert.deepEqual(v2Events(), []);
  // Same v1 worker outcome.
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "v4" } });
  await runMeetingAnalysisStage({ ...input, stage: "conversation_events" });
  assert.deepEqual(((jobRow().checkpoint as Row).prepared as { source: ExecutionSourceContext }).source.conversationEvents, []);
});

test("[29] the independent engine finalizes through its own v1 apply function with identical events", async () => {
  resetModel();
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "independent" } });
  await runMeetingAnalysisStage({ ...input, stage: "conversation_events" });
  const v1 = jobRow().checkpoint as Row;
  resetModel();
  seed({ checkpoint: { ...b2Checkpoint(), engine: "independent" } });
  await runV2Stage();
  assert.deepEqual((jobRow().checkpoint as Row).prepared, v1.prepared);
  assert.equal((jobRow().checkpoint as Row).engine, "independent");
});

// ================================================================= concurrency / units
test("[4][5] at most two model calls are in flight and each unit makes exactly one call", async () => {
  resetModel();
  seed();
  await runV2Stage();
  assert.equal(model.maxInFlight, 2);
  assert.equal(model.calls.length, 24);
  assert.deepEqual([...model.calls].sort((a, b) => a - b), planConversationEventChunks(syntheticSource()).map((chunk) => chunk.startSegment - 1));
  assert.equal(units().length, 24);
  assert.ok(units().every((unit) => unit.status === "completed" && unit.stage === STAGE));
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /runOrderedAnalysisUnits\(conversationEvents\.units, \(unit\) =>\s*runConversationEventUnitStep/);
});

test("[6][7] a completed unit skips the model on retry; the first completed result wins", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  const unitKey = planned[3].unitKey;
  await v2.runV2ConversationEventUnit({ ...input, unitKey }, 1);
  const stored = structuredClone(units()[0].result);
  // An ambiguous Workflow retry with a model that would now answer differently.
  const ack = await v2.runV2ConversationEventUnit({ ...input, unitKey }, 2, {
    execute: (await import("../lib/meeting-analysis/v2-unit-execution")).executeV2AnalysisUnit,
    persistence: (await import("../lib/meeting-analysis/v2-unit-execution")).b2UnitPersistence,
    loadJob: (await import("../lib/meeting-analysis/jobs")).getMeetingAnalysisJob,
    extract: async () => { throw new Error("the model must not be called again"); }
  });
  assert.deepEqual(ack, { unitKey, ok: true });
  assert.equal(model.calls.length, 1);
  assert.deepEqual(units()[0].result, stored);
});

test("[8][9][11-size] units never write the checkpoint or touch prepared/source, and store only the chunk result", async () => {
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint);
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  const writesBefore = jobWrites().length;
  await runOrderedAnalysisUnits(planned, (unit) => v2.runV2ConversationEventUnit({ ...input, unitKey: unit.unitKey }, 1));
  assert.equal(jobWrites().length, writesBefore, "no job-row writes from units");
  assert.deepEqual(jobRow().checkpoint, before);
  for (const unit of units()) {
    const result = unit.result as Row;
    assert.deepEqual(Object.keys(result).sort(), ["events", "latencyMs", "ok"]);
    const bytes = JSON.stringify(result).length;
    assert.ok(bytes < 20_000, `${unit.unit_key} stores ${bytes} bytes`);
    assert.doesNotMatch(JSON.stringify(result), /Speaker \d: synthetic line|"transcript"|"topics"|"prepared"/);
    // Unit events are raw model events: no canonical refs, no cross-chunk dedup/linking yet.
    assert.ok((result.events as ConversationEvent[]).every((event) => /^[ra]\d+$/.test(event.client_ref)));
  }
});

test("[16] a handled model failure completes its unit with ok:false (no Workflow retry)", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  model.failStarts.add(planConversationEventChunks(syntheticSource())[2].startSegment - 1);
  const ack = await v2.runV2ConversationEventUnit({ ...input, unitKey: planned[2].unitKey }, 1);
  assert.deepEqual(ack, { unitKey: planned[2].unitKey, ok: false });
  assert.deepEqual([units()[0].status, units()[0].attempt], ["completed", 1]);
  assert.deepEqual(units()[0].result, { ok: false, error: "OpenAI returned empty conversation event output.", latencyMs: (units()[0].result as Row).latencyMs });
  // A thrown model-client error is also a handled result (extractConversationEvents never throws).
  model.gate = async () => { throw new Error("socket hang up"); };
  const thrownByClient = await v2.runV2ConversationEventUnit({ ...input, unitKey: planned[3].unitKey }, 1);
  assert.equal(thrownByClient.ok, false);
  assert.match(String((units()[1].result as Row).details), /socket hang up/);
});

test("[17] a thrown DB/infrastructure error stays Workflow-retryable, then the retry calls the model once", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  const unitKey = planned[0].unitKey;
  const realDeps = {
    execute: (await import("../lib/meeting-analysis/v2-unit-execution")).executeV2AnalysisUnit,
    persistence: (await import("../lib/meeting-analysis/v2-unit-execution")).b2UnitPersistence,
    loadJob: (await import("../lib/meeting-analysis/jobs")).getMeetingAnalysisJob,
    extract: extractConversationEvents
  };
  const { FatalError } = await import("workflow");
  await assert.rejects(
    v2.runV2ConversationEventUnit({ ...input, unitKey }, 1, { ...realDeps, loadJob: async () => { throw new Error("connection reset"); } }),
    (error) => !(error instanceof FatalError) && /connection reset/.test((error as Error).message)
  );
  assert.deepEqual([units()[0].status, units()[0].attempt], ["failed", 1]);
  assert.equal(model.calls.length, 0);
  await v2.runV2ConversationEventUnit({ ...input, unitKey }, 2, realDeps);
  assert.deepEqual([units()[0].status, units()[0].attempt, model.calls.length], ["completed", 2, 1]);
});

// ================================================================= merge semantics
test("[10][11] completion order 1,0,3,2 (and any permutation) merges exactly like 0,1,2,3", async () => {
  resetModel();
  seed();
  await runV2Stage(Array.from({ length: 24 }, (_, i) => i));
  const inOrder = structuredClone(v2Events());
  const permutations = [
    [1, 0, 3, 2, ...Array.from({ length: 20 }, (_, i) => i + 4)],
    Array.from({ length: 24 }, (_, i) => 23 - i)
  ];
  for (const order of permutations) {
    resetModel();
    seed();
    await runV2Stage(order);
    assert.deepEqual(v2Events(), inOrder);
  }
  // Overlap: segments shared by adjacent chunks are emitted twice by the model and collapse once.
  const raw = units().reduce((sum, unit) => sum + ((unit.result as Row).events as unknown[]).length, 0);
  assert.ok(raw > inOrder!.length, `dedup collapsed ${raw - inOrder!.length} overlap duplicates`);
  const segmentsWithEvents = inOrder!.map((event) => `${event.type}:${event.source_segment_ids[0]}`);
  assert.equal(new Set(segmentsWithEvents).size, segmentsWithEvents.length, "each overlapped event survives once");
});

test("[13] dedup is order dependent; the merge always consumes chunks in chunk-index order", () => {
  const seg = segmentId(42);
  const make = (ref: string, confidence: number, actor: string): ConversationEvent => ({
    client_ref: ref, type: "request", actors: [actor], action: "prepare", object: "deliverable 4",
    temporal_state: "future", commitment_signal: "requested", source_quote: "synthetic line 42",
    source_segment_ids: [seg], linked_event_refs: [], confidence
  });
  const chunk0: ConversationEventStageResult = { ok: true, latencyMs: 1, events: [make("x", 0.5, "first")] };
  const chunk1: ConversationEventStageResult = { ok: true, latencyMs: 1, events: [make("y", 0.9, "second")] };
  const transcript = `[${seg}] A: synthetic line 42`;
  const forward = mergeConversationEventChunkResults({ results: [chunk0, chunk1], transcript, generation: 5 });
  assert.ok(forward.ok);
  // The first event (chunk 0) survives and absorbs the later duplicate: max confidence, own fields.
  assert.deepEqual(forward.events.map((event) => [event.client_ref, event.actors, event.confidence]), [["g5_c1_e001", ["first"], 0.9]]);
  // Feeding chunks out of order would change which event survives -- the finalizer never does.
  const reversed = mergeConversationEventChunkResults({ results: [chunk1, chunk0], transcript, generation: 5 });
  assert.ok(reversed.ok);
  assert.deepEqual(reversed.events.map((event) => event.actors), [["second"]]);
  const unitsOutOfOrder = [unit(1, chunk1), unit(0, chunk0)];
  assert.deepEqual(v2.orderConversationEventUnits(2, unitsOutOfOrder), [chunk0, chunk1]);
});

function unit(index: number, result: unknown, patch: Partial<AnalysisJobUnit> = {}): AnalysisJobUnit {
  return {
    job_id: JOB, stage: STAGE, unit_key: v2.conversationEventUnitKey(index), status: "completed",
    result: result as AnalysisJobUnit["result"], error: null, attempt: 1, started_at: null, completed_at: null,
    created_at: "x", updated_at: "x", ...patch
  };
}

// ================================================================= finalizer validation
test("[18][19][20] missing, unexpected, duplicate, incomplete and malformed units fail finalization with no checkpoint write", async () => {
  const ok: ConversationEventStageResult = { ok: true, latencyMs: 1, events: [] };
  const cases: Array<[string, AnalysisJobUnit[], RegExp]> = [
    ["missing", [unit(0, ok), unit(2, ok)], /Missing conversation event unit chunk:000001/],
    ["unexpected index", [unit(0, ok), unit(1, ok), unit(2, ok), unit(3, ok)], /Unexpected conversation event unit chunk:000003/],
    ["unexpected key", [unit(0, ok), unit(1, ok), unit(2, ok), { ...unit(0, ok), unit_key: "window:000000" }], /Unexpected conversation event unit window:000000/],
    ["duplicate", [unit(0, ok), unit(1, ok), unit(1, ok), unit(2, ok)], /Duplicate conversation event unit chunk:000001/],
    ["running", [unit(0, ok), unit(1, null, { status: "running" }), unit(2, ok)], /chunk:000001 is not completed/],
    ["failed", [unit(0, ok), unit(1, null, { status: "failed" }), unit(2, ok)], /chunk:000001 is not completed/],
    ["malformed", [unit(0, ok), unit(1, { ok: true }), unit(2, ok)], /Malformed conversation event unit chunk:000001/]
  ];
  for (const [label, list, message] of cases) {
    assert.throws(() => v2.orderConversationEventUnits(3, list), (error) => error instanceof AnalysisUnitValidationError && message.test((error as Error).message), label);
  }
  // Through the real finalizer: a partially completed stage never reaches the checkpoint.
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint);
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  for (const plannedUnit of planned.slice(0, 23)) await v2.runV2ConversationEventUnit({ ...input, unitKey: plannedUnit.unitKey }, 1);
  await assert.rejects(v2.finalizeV2ConversationEvents(input, 1), /Missing conversation event unit chunk:000023/);
  assert.deepEqual(jobRow().checkpoint, before);
});

// ================================================================= checkpoint preservation
test("[23][24][25][26] the finalizer replaces only `prepared` and keeps version, topology, normalization, unknown keys and engine", async () => {
  resetModel();
  seed({ checkpoint: { ...b2Checkpoint(), v4State: { tag: "untouched" } } });
  const before = structuredClone(jobRow().checkpoint as Row);
  await runV2Stage();
  const saved = jobRow().checkpoint as Row;
  const { prepared: _prepared, ...rest } = saved;
  const { prepared: _before, ...restBefore } = before;
  assert.deepEqual(rest, restBefore);
  assert.deepEqual([saved.checkpointVersion, saved.v2Topology, saved.engine], [2, "b2", "v4"]);
  assert.deepEqual(saved.normalization, NORMALIZATION);
  assert.deepEqual(saved.unknownFutureKey, UNKNOWN);
  const { conversationEvents, ...sourceRest } = (saved.prepared as { source: Row }).source;
  assert.ok(Array.isArray(conversationEvents) && conversationEvents.length > 0);
  assert.deepEqual(sourceRest, (before.prepared as { source: Row }).source);
  // Re-running the finalizer is idempotent.
  await v2.finalizeV2ConversationEvents(input, 2);
  assert.deepEqual(jobRow().checkpoint, saved);
});

// ================================================================= topology / stale guards
test("[21] an old B1 job (no v2Topology) is rejected by plan, unit and finalizer before any model call or write", async () => {
  resetModel();
  const { v2Topology: _dropped, ...b1Checkpoint } = b2Checkpoint();
  seed({ checkpoint: b1Checkpoint });
  const before = structuredClone(jobRow());
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.planV2ConversationEvents(input, 1), /B2 v2 topology/);
  await assert.rejects(v2.runV2ConversationEventUnit({ ...input, unitKey: "chunk:000000" }, 1),
    (error) => error instanceof FatalError && /B2 v2 topology/.test((error as Error).message));
  await assert.rejects(v2.finalizeV2ConversationEvents(input, 1), /B2 v2 topology/);
  assert.equal(model.calls.length, 0);
  assert.deepEqual(units(), []);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(jobRow(), before);
});

test("[22] a stale or superseded generation is rejected by plan, unit and finalizer", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  for (const plannedUnit of planned) await v2.runV2ConversationEventUnit({ ...input, unitKey: plannedUnit.unitKey }, 1);
  const callsBefore = model.calls.length;
  const checkpoint = structuredClone(jobRow().checkpoint);
  db.rows("meetings")[0].execution_graph_generation = GENERATION + 1;
  await assert.rejects(v2.planV2ConversationEvents(input, 1), /Stale analysis generation/);
  await assert.rejects(v2.runV2ConversationEventUnit({ ...input, unitKey: "chunk:000000" }, 2), /Stale analysis generation/);
  await assert.rejects(v2.finalizeV2ConversationEvents(input, 1), /Stale analysis generation/);
  // A newer claim landing between validation and the checkpoint write.
  db.rows("meetings")[0].execution_graph_generation = GENERATION;
  await assert.rejects(v2.finalizeV2ConversationEvents(input, 1, {
    validate: (await import("../lib/meeting-analysis/v2-validation")).assertB2AnalysisJob,
    markRunning: async () => { Object.assign(jobRow(), { status: "stale" }); },
    listUnits: listAnalysisStageUnits,
    saveCheckpoint: (await import("../lib/meeting-analysis/checkpoint")).saveV2Checkpoint
  }), /Stale analysis generation/);
  assert.deepEqual(jobRow().checkpoint, checkpoint);
  assert.equal(model.calls.length, callsBefore);
});

// ================================================================= barrier / scope
test("[27][30] candidates start only after the finalizer; downstream stages are the unchanged v1 steps", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  const body = workflow.slice(workflow.indexOf("export async function meetingAnalysisV2Workflow"));
  const order = ["finalizeTopicExtractionStep(input)", "planConversationEventsStep(input)", "runConversationEventUnitStep(", "finalizeConversationEventsStep(input)", "planCandidatesStep(input)"]
    .map((marker) => body.indexOf(marker));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `ordered: ${order}`);
  assert.match(workflow, /const STAGES_AFTER_CANDIDATES = ANALYSIS_STAGE_ORDER\.slice\(\s*ANALYSIS_STAGE_ORDER\.indexOf\("candidates"\) \+ 1\s*\);/);
  assert.deepEqual(ANALYSIS_STAGE_ORDER.slice(ANALYSIS_STAGE_ORDER.indexOf("candidates") + 1),
    ["global_correction", "verification", "completeness", "final_verification", "task_consolidation", "synthesis", "persistence"]);
  assert.match(body, /await runV2AnalysisStageStep\(\{ \.\.\.input, stage \}\);/);
  // Candidates read only the canonical checkpoint, never conversation-event unit rows.
  const worker = await readFile(new URL("../lib/meeting-analysis/worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /listAnalysisStageUnits|loadAnalysisJobUnit|loadCompletedAnalysisUnit|meeting_analysis_job_units/);
  // The steps are thin, serializable wrappers.
  const steps = await readFile(new URL("../lib/meeting-analysis/v2-conversation-event-steps.ts", import.meta.url), "utf8");
  assert.equal(steps.match(/"use step";/g)?.length, 3);
  assert.equal(steps.match(/getStepMetadata\(\)\.attempt/g)?.length, 3);
  assert.doesNotMatch(steps, /checkpoint|meeting_analysis_jobs/);
});

test("[9] v1 extractAndLinkConversationEvents keeps its pool: two workers, one call per chunk, results by chunk index", async () => {
  resetModel();
  const releases: Array<() => void> = [];
  model.gate = (start) => new Promise<void>((resolve) => {
    // Complete chunk 1 before chunk 0, chunk 3 before chunk 2, ...
    releases.push(resolve);
    if (releases.length % 2 === 0) { releases[releases.length - 1](); releases[releases.length - 2](); }
    void start;
  });
  const gated = await v1Events();
  resetModel();
  const plain = await v1Events();
  assert.ok(gated.ok && plain.ok);
  assert.deepEqual(gated.events, plain.events);
  assert.equal(model.maxInFlight, 2);
  assert.equal(model.calls.length, 24);
});

// ================================================================= transient provider failures
/** The OpenAI SDK's own construction of an HTTP error response (generation 20: chunk:000006). */
const providerError = (status: number) => APIError.generate(status, undefined, "no healthy upstream", {});
const RETRYABLE_MESSAGE = "Conversation event extraction hit a retryable provider error (HTTP 503).";

/** Workflow SDK step contract: default maxRetries 3 (4 attempts, one-based), FatalError never retried. */
const STEP_MAX_ATTEMPTS = 4;
async function asWorkflowStep<T>(run: (attempt: number) => Promise<T>): Promise<T> {
  const { FatalError } = await import("workflow");
  let lastError: unknown;
  for (let attempt = 1; attempt <= STEP_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (error instanceof FatalError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** 880 synthetic segments plan 25 chunks: the generation-20 shape. */
const GEN20_SEGMENTS = 880;
const seedGen20 = () => seed({ checkpoint: { ...b2Checkpoint(), prepared: { ...PREPARED(), source: syntheticSource(GEN20_SEGMENTS) } } });
const gen20ChunkStart = (index: number) => planConversationEventChunks(syntheticSource(GEN20_SEGMENTS))[index].startSegment - 1;
/** Fails the model call for one chunk with `error` for its first `times` calls. */
function failChunk(start: number, error: () => unknown, times: number) {
  let remaining = times;
  model.gate = async (callStart) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (callStart === start && remaining > 0) {
      remaining -= 1;
      throw error();
    }
  };
}
/** meetingAnalysisV2Workflow's conversation_events stage, every step under the retry contract. */
async function runV2StageWithRetries() {
  const { units: planned } = await asWorkflowStep((attempt) => v2.planV2ConversationEvents(input, attempt));
  await runOrderedAnalysisUnits(planned, (unit) =>
    asWorkflowStep((attempt) => v2.runV2ConversationEventUnit({ ...input, unitKey: unit.unitKey }, attempt)));
  return asWorkflowStep((attempt) => v2.finalizeV2ConversationEvents(input, attempt));
}
const unitRow = (unitKey: string) => units().find((row) => row.unit_key === unitKey)!;

test("[T6][T7] a retryable provider error throws from the unit: failed row, no completed ok:false, Workflow-retryable", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  const unitKey = planned[6].unitKey;
  failChunk(planConversationEventChunks(syntheticSource())[6].startSegment - 1, () => providerError(503), 1);
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runV2ConversationEventUnit({ ...input, unitKey }, 1),
    (error) => error instanceof RetryableProviderError && !(error instanceof FatalError) && error.message === RETRYABLE_MESSAGE);
  const row = unitRow(unitKey);
  assert.deepEqual([row.status, row.attempt, row.result], ["failed", 1, null]);
  assert.equal(row.error, RETRYABLE_MESSAGE, "only the classification is persisted");
  assert.doesNotMatch(JSON.stringify(units()), /healthy upstream/);
  // The next Workflow attempt reruns the chunk and stores the success.
  const ack = await v2.runV2ConversationEventUnit({ ...input, unitKey }, 2);
  assert.deepEqual(ack, { unitKey, ok: true });
  assert.deepEqual([unitRow(unitKey).status, unitRow(unitKey).attempt, model.calls.length], ["completed", 2, 2]);
  assert.equal((unitRow(unitKey).result as Row).ok, true);
});

test("[T8-T11][T15][T16] generation-20 shape: 25 chunks, chunk:000006 hits one 503, its retry succeeds, all 25 contribute", async () => {
  // Baseline: the same 25 chunks with no failure, through v2 and through v1.
  resetModel();
  seedGen20();
  const clean = await runV2StageWithRetries();
  const cleanEvents = structuredClone(v2Events());
  assert.equal(model.calls.length, 25);
  resetModel();
  const v1 = await extractAndLinkConversationEvents(syntheticSource(GEN20_SEGMENTS), { generation: GENERATION });
  assert.ok(v1.ok);
  assert.deepEqual(cleanEvents, v1.events, "v2 clean finalization equals v1");

  resetModel();
  seedGen20();
  const target = gen20ChunkStart(6);
  failChunk(target, () => providerError(503), 1);
  const outcome = await runV2StageWithRetries();
  assert.deepEqual(outcome, clean);
  assert.ok(outcome.ok && outcome.events > 0);
  // Every chunk's events are present: identical to the failure-free run (order, dedup, refs, links).
  assert.deepEqual(v2Events(), cleanEvents);
  assert.ok(cleanEvents!.some((event) => event.client_ref.startsWith(`g${GENERATION}_c7_`)), "chunk 6 (c7) contributed events");
  // Only the failed chunk was called again; completed siblings were not repeated.
  assert.equal(model.calls.length, 26);
  assert.equal(model.calls.filter((start) => start === target).length, 2);
  const others = model.calls.filter((start) => start !== target);
  assert.equal(new Set(others).size, 24);
  assert.equal(units().length, 25);
  for (const row of units()) {
    assert.equal(row.status, "completed", String(row.unit_key));
    assert.equal(row.attempt, row.unit_key === "chunk:000006" ? 2 : 1, String(row.unit_key));
    assert.equal((row.result as Row).ok, true, String(row.unit_key));
  }
  // First completed result wins: a later ambiguous retry neither calls the model nor replaces it.
  const stored = structuredClone(unitRow("chunk:000006").result);
  const ack = await v2.runV2ConversationEventUnit({ ...input, unitKey: "chunk:000006" }, 3, {
    execute: (await import("../lib/meeting-analysis/v2-unit-execution")).executeV2AnalysisUnit,
    persistence: (await import("../lib/meeting-analysis/v2-unit-execution")).b2UnitPersistence,
    loadJob: (await import("../lib/meeting-analysis/jobs")).getMeetingAnalysisJob,
    extract: async () => { throw new Error("the model must not be called again"); }
  });
  assert.deepEqual(ack, { unitKey: "chunk:000006", ok: true });
  assert.deepEqual(unitRow("chunk:000006").result, stored);
  assert.equal(model.calls.length, 26);
});

test("[T12][T13] exhausted retryable failures fail the stage; conversationEvents is never canonicalized as []", async () => {
  resetModel();
  seedGen20();
  const before = structuredClone(jobRow().checkpoint);
  const target = gen20ChunkStart(6);
  failChunk(target, () => providerError(503), Number.POSITIVE_INFINITY);
  let thrown: unknown;
  await assert.rejects(runV2StageWithRetries(), (error) => {
    thrown = error;
    return error instanceof RetryableProviderError && error.message === RETRYABLE_MESSAGE;
  });
  // The workflow catch records exactly this message through failV2AnalysisStep.
  assert.equal(workflowErrorMessage(thrown), RETRYABLE_MESSAGE);
  assert.equal(model.calls.filter((start) => start === target).length, STEP_MAX_ATTEMPTS);
  assert.deepEqual([unitRow("chunk:000006").status, unitRow("chunk:000006").attempt], ["failed", STEP_MAX_ATTEMPTS]);
  assert.ok(units().every((row) => row.unit_key === "chunk:000006" || row.status === "completed"));
  // The finalizer never ran: the checkpoint is untouched and carries no conversationEvents at all.
  assert.deepEqual(jobRow().checkpoint, before);
  const source = ((jobRow().checkpoint as Row).prepared as { source: ExecutionSourceContext }).source;
  assert.equal(source.conversationEvents, undefined);
  // Even a finalizer invoked directly refuses the failed unit and writes nothing.
  await assert.rejects(v2.finalizeV2ConversationEvents(input, 1),
    (error) => error instanceof AnalysisUnitValidationError && /chunk:000006 is not completed|Missing conversation event unit/.test(error.message));
  assert.deepEqual(jobRow().checkpoint, before);
});

test("[T5] a request timeout (this call's own abort timer) is retryable in v2 and handled in v1", async () => {
  const previous = process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS;
  process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS = "1000";
  try {
    const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new APIUserAbortError()));
    });
    const chunk = planConversationEventChunks(syntheticSource())[0].source;
    await assert.rejects(extractConversationEvents(chunk, { createResponse: hang, throwRetryableProviderErrors: true }),
      (error) => error instanceof RetryableProviderError && error.failure.kind === "timeout");
    const handled = await extractConversationEvents(chunk, { createResponse: hang });
    assert.deepEqual([handled.ok, handled.ok ? "" : handled.error], [false, "Conversation event extraction failed."]);
  } finally {
    if (previous === undefined) delete process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS;
    else process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS = previous;
  }
});

test("[T14] non-transient failures keep the handled ok:false unit (completed, attempt 1, no Workflow retry)", async () => {
  resetModel();
  seed();
  const { units: planned } = await v2.planV2ConversationEvents(input, 1);
  const chunks = planConversationEventChunks(syntheticSource());
  const cases: Array<[number, () => unknown, RegExp]> = [
    [0, () => providerError(400), /^400 no healthy upstream$/],
    [1, () => providerError(401), /^401 /],
    [2, () => providerError(422), /^422 /],
    [3, () => new APIUserAbortError(), /Request was aborted/],
    [4, () => new Error("socket hang up"), /socket hang up/]
  ];
  for (const [index, error, details] of cases) {
    failChunk(chunks[index].startSegment - 1, error, 1);
    const ack = await v2.runV2ConversationEventUnit({ ...input, unitKey: planned[index].unitKey }, 1);
    assert.deepEqual(ack, { unitKey: planned[index].unitKey, ok: false });
    const row = unitRow(planned[index].unitKey);
    assert.deepEqual([row.status, row.attempt], ["completed", 1], String(index));
    const result = row.result as Row;
    assert.equal(result.error, "Conversation event extraction failed.");
    assert.match(String(result.details), details);
  }
  // Empty/invalid model output is still a completed ok:false (existing semantic failure path).
  model.gate = null;
  model.failStarts.add(chunks[5].startSegment - 1);
  await v2.runV2ConversationEventUnit({ ...input, unitKey: planned[5].unitKey }, 1);
  assert.deepEqual([unitRow(planned[5].unitKey).status, (unitRow(planned[5].unitKey).result as Row).error],
    ["completed", "OpenAI returned empty conversation event output."]);
  assert.equal(model.calls.length, 6, "one call per unit: none of these were retried");
});

test("[T18] v1 is unchanged: a 503 is still a handled chunk failure and the v1 stage still continues with []", async () => {
  resetModel();
  const target = planConversationEventChunks(syntheticSource())[6].startSegment - 1;
  failChunk(target, () => providerError(503), Number.POSITIVE_INFINITY);
  const v1 = await extractAndLinkConversationEvents(syntheticSource(), { generation: GENERATION });
  assert.equal(v1.ok, false);
  assert.equal(v1.ok ? "" : v1.error, "Conversation event chunk 7 failed: Conversation event extraction failed.");
  assert.equal(v1.ok ? "" : v1.details, "503 no healthy upstream");
  assert.equal(model.calls.filter((start) => start === target).length, 1, "v1 never retries the chunk");
  failChunk(target, () => providerError(503), Number.POSITIVE_INFINITY);
  seed({ pipeline_version: 1, checkpoint: { prepared: PREPARED(), engine: "v4" } });
  await runMeetingAnalysisStage({ ...input, stage: "conversation_events" });
  assert.deepEqual(((jobRow().checkpoint as Row).prepared as { source: ExecutionSourceContext }).source.conversationEvents, []);
  // The direct call without the opt-in is also unchanged.
  failChunk(target, () => providerError(503), 1);
  const direct = await extractConversationEvents(planConversationEventChunks(syntheticSource())[6].source);
  assert.deepEqual([direct.ok, direct.ok ? "" : direct.details], [false, "503 no healthy upstream"]);
});
