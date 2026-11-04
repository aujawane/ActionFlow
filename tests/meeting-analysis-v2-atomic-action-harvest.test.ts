import assert from "node:assert/strict";
import test from "node:test";

import { assembleV4WorkItemState, type V4ExecutionState } from "../lib/execution-intelligence/v4-pipeline";
import {
  assembleAtomicActionHarvestPass,
  planAtomicActionHarvestWindows,
  runAtomicActionHarvestPass
} from "../lib/execution-intelligence/work-item-stages";
import type { AtomicActionHarvestCandidate } from "../lib/execution-intelligence/work-item-schemas";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import {
  AnalysisUnitValidationError,
  listAnalysisStageUnits,
  type AnalysisJobUnit
} from "../lib/meeting-analysis/job-units";
import { getMeetingAnalysisJob } from "../lib/meeting-analysis/jobs";
import { saveV2Checkpoint } from "../lib/meeting-analysis/checkpoint";
import { markV2AnalysisFailed, V2StageFailedError } from "../lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "../lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import { runOrderedAnalysisUnits } from "../lib/meeting-analysis/workflow-concurrency";
import { runMeetingAnalysisStage, type MeetingAnalysisStageDeps } from "../lib/meeting-analysis/worker";
import * as harvestV2 from "../lib/meeting-analysis/v2-atomic-action-harvest";
import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";

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
const MEETING = "meeting-b23";
const JOB = "job-b23";
const GENERATION = 23;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };
const segmentId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const UNKNOWN = { future: { keep: true } };
const NORMALIZATION = { enabled: true, segments: 854 };

function source(segmentCount = 854): ExecutionSourceContext {
  return {
    meetingId: MEETING,
    meetingDate: "2026-11-04",
    project: null,
    transcript: Array.from({ length: segmentCount }, (_, index) =>
      `[${segmentId(index)}] Speaker ${index % 3}: synthetic action ${index}`).join("\n"),
    transcriptSegmentCount: segmentCount,
    topics: [],
    insights: [],
    conversationEvents: []
  };
}

function v4State(value = source()): V4ExecutionState {
  return assembleV4WorkItemState(
    { source: value, fallbackUsed: false },
    { ok: true, topics: [], latencyMs: 0, usage: null }
  );
}

function checkpoint(value = source()) {
  const state = v4State(value);
  return {
    checkpointVersion: 2,
    v2Topology: "b2",
    normalization: structuredClone(NORMALIZATION),
    unknownFutureKey: structuredClone(UNKNOWN),
    prepared: { source: value, fallbackUsed: false, meetingContextByTopicId: [] },
    engine: "v4",
    v4State: state
  };
}

let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);

function seed(patch: Row = {}, value = source()) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB,
      meeting_id: MEETING,
      generation: GENERATION,
      pipeline_version: 2,
      status: "running",
      started_at: "x",
      retry_count: 0,
      current_stage: "candidates",
      progress: 35,
      checkpoint: checkpoint(value),
      ...patch
    }]
  });
}

const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const unitRows = () => db.rows("meeting_analysis_job_units") as unknown as AnalysisJobUnit[];
const jobCheckpoint = () => jobRow().checkpoint as Row;

function candidate(windowIndex: number, id: string, suffix = "grounded"): AtomicActionHarvestCandidate {
  return {
    candidate_id: `local-${suffix}`,
    owner: `Owner ${windowIndex % 3}`,
    owners: [],
    outcome: `Complete synthetic outcome ${windowIndex} ${suffix}`,
    source_quote: `synthetic action ${windowIndex}`,
    source_segment_ids: [id],
    harvest_reason: "Synthetic test candidate"
  };
}

function windowResult(windowIndex: number, groundedId: string) {
  return {
    ok: true as const,
    candidates: [
      candidate(windowIndex, groundedId),
      candidate(windowIndex, "ffffffff-ffff-4fff-8fff-ffffffffffff", "rejected")
    ],
    latencyMs: 3,
    salvagedItems: 0,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
  };
}

function realUnitDeps(request: harvestV2.V2AtomicActionHarvestUnitDeps["request"]): harvestV2.V2AtomicActionHarvestUnitDeps {
  return {
    execute: executeV2AnalysisUnit,
    persistence: b2UnitPersistence,
    loadJob: getMeetingAnalysisJob,
    request
  };
}

const finalizeDeps: harvestV2.V2AtomicActionHarvestFinalizeDeps = {
  validate: assertB2AnalysisJob,
  markRunning: async ({ jobId, stage }) => {
    const row = db.rows("meeting_analysis_jobs").find((item) => item.id === jobId);
    if (row) Object.assign(row, { current_stage: stage, progress: 37 });
  },
  markFailed: markV2AnalysisFailed,
  listUnits: listAnalysisStageUnits,
  saveCheckpoint: saveV2Checkpoint
};

test("[1-4][18] the 854-segment plan is deterministic, stable, and identical to v1 chunk boundaries/overlap", async () => {
  const value = source();
  const first = planAtomicActionHarvestWindows(value);
  const second = planAtomicActionHarvestWindows(structuredClone(value));
  assert.equal(first.length, 25);
  assert.deepEqual(second.map(({ index, startSegment, endSegment }) => ({ index, startSegment, endSegment })),
    first.map(({ index, startSegment, endSegment }) => ({ index, startSegment, endSegment })));
  assert.deepEqual(first.slice(0, 3).map(({ startSegment, endSegment }) => [startSegment, endSegment]),
    [[1, 40], [36, 75], [71, 110]]);
  assert.deepEqual(first.at(-1) && [first.at(-1)!.startSegment, first.at(-1)!.endSegment], [841, 854]);
  seed({}, value);
  const plan = await harvestV2.planV2AtomicActionHarvest(input, 1);
  assert.deepEqual(plan.units.map((unit) => unit.unitKey),
    Array.from({ length: 25 }, (_, index) => `window:${String(index).padStart(6, "0")}`));
  assert.throws(() => harvestV2.atomicActionHarvestUnitKey(-1), AnalysisUnitValidationError);
});

test("[5-10][13] durable units stay at concurrency two, call once, store compact results, retry independently, and never write checkpoint", async () => {
  seed();
  const plan = await harvestV2.planV2AtomicActionHarvest(input, 1);
  const before = structuredClone(jobCheckpoint());
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const deps = realUnitDeps(async ({ window }) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return windowResult(window.index, segmentId((window.startSegment ?? 1) - 1));
  });
  await runOrderedAnalysisUnits(plan.units, (unit) =>
    harvestV2.runV2AtomicActionHarvestUnit({ ...input, unitKey: unit.unitKey }, 1, deps));
  assert.equal(calls, 25);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(jobCheckpoint(), before);
  assert.equal(unitRows().length, 25);
  for (const unit of unitRows()) {
    const json = JSON.stringify(unit.result);
    assert.ok(Buffer.byteLength(json) < 2_000, `representative unit JSONB bytes: ${Buffer.byteLength(json)}`);
    assert.doesNotMatch(json, /checkpointVersion|v4State|prepared|synthetic action 853/);
  }

  const firstStored = structuredClone(unitRows()[0].result);
  const ack = await harvestV2.runV2AtomicActionHarvestUnit({ ...input, unitKey: plan.units[0].unitKey }, 2,
    realUnitDeps(async () => { throw new Error("completed unit must not call model"); }));
  assert.deepEqual(ack, { unitKey: "window:000000", ok: true });
  assert.deepEqual(unitRows()[0].result, firstStored);

  seed({}, source(1));
  await assert.rejects(
    harvestV2.runV2AtomicActionHarvestUnit({ ...input, unitKey: "window:000000" }, 1,
      realUnitDeps(async () => { throw new Error("transient database/model transport"); })),
    /transient database\/model transport/
  );
  assert.equal(unitRows()[0].status, "failed");
});

test("[11-12] handled harvest failure is durable ok:false and the finalizer fails at atomic_action_harvest/37", async () => {
  seed({}, source(1));
  const failure = { ok: false as const, error: "model failed", details: "invalid JSON", latencyMs: 4, validationFailure: true };
  await harvestV2.runV2AtomicActionHarvestUnit({ ...input, unitKey: "window:000000" }, 1,
    realUnitDeps(async () => failure));
  assert.deepEqual(unitRows()[0].result, failure);
  assert.equal(unitRows()[0].status, "completed");
  await assert.rejects(harvestV2.finalizeV2AtomicActionHarvest(input, 1, finalizeDeps),
    (error) => error instanceof V2StageFailedError && error.message === "v4_completeness_recovery: model failed: invalid JSON");
  assert.deepEqual([jobRow().status, jobRow().current_stage, jobRow().progress], ["failed", "atomic_action_harvest", 37]);
  assert.equal(jobCheckpoint().gcV2, undefined);
});

test("[14-18] stale/no-topology jobs and missing, unexpected, duplicate, or malformed unit sets are rejected", async () => {
  seed({ generation: GENERATION - 1 }, source(1));
  await assert.rejects(harvestV2.planV2AtomicActionHarvest(input, 1), /Stale analysis generation/);
  seed({ checkpoint: { ...checkpoint(source(1)), v2Topology: undefined } }, source(1));
  await assert.rejects(harvestV2.planV2AtomicActionHarvest(input, 1), /B2 v2 topology/);

  const good = (key: string): AnalysisJobUnit => ({
    job_id: JOB, stage: harvestV2.ATOMIC_ACTION_HARVEST_STAGE, unit_key: key, status: "completed",
    result: windowResult(0, segmentId(0)) as unknown as AnalysisJobUnit["result"], error: null, attempt: 1,
    started_at: "x", completed_at: "x", created_at: "x", updated_at: "x"
  });
  assert.throws(() => harvestV2.orderAtomicActionHarvestUnits(["window:000000"], []), /Missing/);
  assert.throws(() => harvestV2.orderAtomicActionHarvestUnits(["window:000000"], [good("window:000001")]), /Unexpected/);
  assert.throws(() => harvestV2.orderAtomicActionHarvestUnits(["window:000000"], [good("window:000000"), good("window:000000")]), /Duplicate/);
  assert.throws(() => harvestV2.orderAtomicActionHarvestUnits(["window:000000"], [{ ...good("window:000000"), result: { broken: true } }]), /Malformed/);
  assert.throws(() => harvestV2.atomicActionHarvestUnitKey(1_000_000), /Invalid/);
});

test("[19-26][31] reversed durable completion has v1-equivalent refs, grounding, metrics, traces, and preserves the checkpoint", async () => {
  const value = source(90);
  const windows = planAtomicActionHarvestWindows(value);
  const deterministicResults = windows.map((window) => windowResult(window.index, segmentId(window.startSegment - 1)));
  const expected = assembleAtomicActionHarvestPass({ source: value, windows, results: deterministicResults, latencyMs: 9 });
  seed({}, value);
  const plan = await harvestV2.planV2AtomicActionHarvest(input, 1);
  for (const planned of [...plan.units].reverse()) {
    await harvestV2.runV2AtomicActionHarvestUnit({ ...input, unitKey: planned.unitKey }, 1,
      realUnitDeps(async ({ window }) => windowResult(window.index, segmentId(window.startSegment - 1))));
  }
  await harvestV2.finalizeV2AtomicActionHarvest(input, 1, finalizeDeps);
  const saved = jobCheckpoint();
  const actual = (saved.gcV2 as Row).harvest as Row;
  assert.deepEqual({ ...actual, latencyMs: 9 }, expected);
  assert.deepEqual(actual.candidates && (actual.candidates as Row[]).map((item) => item.canonicalRef),
    windows.map((window) => `hc_w${window.index}_1`));
  assert.equal(actual.groundingRejected, windows.length);
  assert.equal((actual.groundingRejectionTrace as unknown[]).length, windows.length);
  assert.deepEqual([saved.checkpointVersion, saved.v2Topology, saved.normalization, saved.unknownFutureKey],
    [2, "b2", NORMALIZATION, UNKNOWN]);
  assert.ok(saved.prepared && saved.engine === "v4" && saved.v4State);
  assert.equal(JSON.stringify(saved.gcV2).includes(value.transcript), false);

  let v1InFlight = 0;
  let v1MaxInFlight = 0;
  let v1NextWindow = 0;
  const v1 = await runAtomicActionHarvestPass({
    source: value,
    createResponse: (async () => {
      const window = windows[v1NextWindow++];
      v1InFlight += 1;
      v1MaxInFlight = Math.max(v1MaxInFlight, v1InFlight);
      await new Promise((resolve) => setImmediate(resolve));
      v1InFlight -= 1;
      return { output_text: JSON.stringify({ candidates: windowResult(window.index, segmentId(window.startSegment - 1)).candidates }),
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    }) as never
  });
  assert.equal(v1MaxInFlight, 2);
  assert.deepEqual({ ...v1, latencyMs: 9 }, { ...actual, latencyMs: 9 });
});

function stageDeps(inputDeps: {
  after: MeetingAnalysisStageDeps["runV4GlobalCorrectionAfterHarvest"];
  onLegacy: () => void;
}): MeetingAnalysisStageDeps {
  const noop = async (value: unknown) => value as never;
  return {
    normalizeMeetingTranscriptForAnalysis: noop,
    prepareMeetingAnalysis: noop,
    getExecutionIntelligenceEngine: () => "v4",
    runConversationEventExtraction: noop,
    runV4ConversationEventExtraction: noop,
    runActionExtraction: noop,
    runV4WorkItemExtraction: noop,
    runV4GlobalCorrection: async (state: V4ExecutionState) => { inputDeps.onLegacy(); return state; },
    runV4GlobalCorrectionAfterHarvest: inputDeps.after,
    runCommitmentExtraction: noop,
    runV4Grouping: noop,
    runRelationshipEvaluation: noop,
    runV4GroupingVerification: noop,
    runEvidenceVerification: noop,
    runV4TreeAssembly: noop,
    runV4TaskConsolidation: noop,
    runV4FinalReconciliation: noop,
    finalizeV4Execution: noop,
    finalizeIndependentExecution: noop
  } as unknown as MeetingAnalysisStageDeps;
}

test("[27-30] post-harvest global correction never calls harvest, retains gcV2 on failure/retry, and removes it only on success", async () => {
  const value = source(1);
  seed({}, value);
  const windows = planAtomicActionHarvestWindows(value);
  const assembled = assembleAtomicActionHarvestPass({ source: value, windows,
    results: [windowResult(0, segmentId(0))], latencyMs: 3 });
  assert.equal(assembled.ok, true);
  (jobCheckpoint() as Row).gcV2 = { harvest: assembled };
  let legacyCalls = 0;
  let afterCalls = 0;
  const failing = stageDeps({
    onLegacy: () => { legacyCalls += 1; },
    after: async () => { afterCalls += 1; throw new Error("remaining monolith timeout"); }
  });
  await assert.rejects(runMeetingAnalysisStage({ ...input, stage: "global_correction" }, failing), /remaining monolith timeout/);
  assert.ok((jobCheckpoint().gcV2 as Row).harvest);
  assert.equal(legacyCalls, 0);

  Object.assign(jobRow(), { status: "running", current_stage: "atomic_action_harvest", progress: 37, error: null });
  const succeeding = stageDeps({
    onLegacy: () => { legacyCalls += 1; },
    after: async (state, harvest) => { afterCalls += 1; assert.equal(harvest, (jobCheckpoint().gcV2 as Row).harvest); return state; }
  });
  await runMeetingAnalysisStage({ ...input, stage: "global_correction" }, succeeding);
  assert.equal(afterCalls, 2);
  assert.equal(legacyCalls, 0);
  assert.equal(jobCheckpoint().gcV2, undefined);
});

test("[15][27][32] post-harvest entry rejects old topology before model work; workflow uses the bounded durable barrier only for v4", async () => {
  const value = source(1);
  seed({ checkpoint: { ...checkpoint(value), v2Topology: undefined, gcV2: { harvest: { ok: true, candidates: [] } } } }, value);
  let calls = 0;
  await assert.rejects(runMeetingAnalysisStage({ ...input, stage: "global_correction" }, stageDeps({
    onLegacy: () => { calls += 1; }, after: async (state) => { calls += 1; return state; }
  })), /B2 v2 topology/);
  assert.equal(calls, 0);
});
