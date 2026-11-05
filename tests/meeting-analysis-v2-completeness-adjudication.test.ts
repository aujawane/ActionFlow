import assert from "node:assert/strict";
import test from "node:test";

import type { CompletenessAdjudicationModelResult } from "../lib/execution-intelligence/work-item-model";
import {
  planCompletenessAdjudicationBatches,
  runCompletenessRecoveryAfterHarvest,
  type AtomicActionHarvestPassResult,
  type HarvestedCandidate
} from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemAddition } from "../lib/execution-intelligence/work-item-schemas";
import { assembleV4WorkItemState, type V4ExecutionState } from "../lib/execution-intelligence/v4-pipeline";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getMeetingAnalysisJob } from "../lib/meeting-analysis/jobs";
import { executeV2AnalysisUnit, b2UnitPersistence } from "../lib/meeting-analysis/v2-unit-execution";
import { runMeetingAnalysisStage, type MeetingAnalysisStageDeps } from "../lib/meeting-analysis/worker";
import * as v2 from "../lib/meeting-analysis/v2-completeness-adjudication";
import { V2StageFailedError } from "../lib/meeting-analysis/v2-lifecycle";
import { AnalysisUnitValidationError, type AnalysisJobUnit } from "../lib/meeting-analysis/job-units";
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
const MEETING = "meeting-b24";
const JOB = "job-b24";
const GENERATION = 24;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };
const segmentId = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function source(): ExecutionSourceContext {
  return {
    meetingId: MEETING,
    meetingDate: "2026-11-04",
    project: null,
    transcript: Array.from({ length: 854 }, (_, index) =>
      `[${segmentId(index)}] Speaker ${index % 4}: synthetic generation nineteen action ${index}`).join("\n"),
    transcriptSegmentCount: 854,
    topics: [],
    insights: [],
    conversationEvents: []
  };
}

function candidate(index: number): HarvestedCandidate {
  const evidenceIndex = index === 1 ? 0 : index === 36 ? 29 : index;
  return {
    candidate_id: `local-${index}`,
    canonicalRef: `hc_w${Math.floor(index / 2)}_${(index % 2) + 1}`,
    windowIndex: Math.floor(index / 2),
    owner: `Owner ${index % 3}`,
    owners: [],
    outcome: `Deliver synthetic outcome ${evidenceIndex}`,
    source_quote: `synthetic generation nineteen action ${evidenceIndex}`,
    source_segment_ids: [segmentId(evidenceIndex)],
    harvest_reason: "Synthetic candidate"
  };
}

const CANDIDATES = Array.from({ length: 37 }, (_, index) => candidate(index));
const HARVEST: Extract<AtomicActionHarvestPassResult, { ok: true }> = {
  ok: true,
  candidates: CANDIDATES,
  harvestedByWindow: [{ windowIndex: 0, harvested: CANDIDATES.length }],
  groundingRejected: 0,
  latencyMs: 25,
  salvagedItems: 0,
  usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  harvestTrace: CANDIDATES.map((item) => ({
    windowIndex: item.windowIndex,
    candidateId: item.canonicalRef,
    owner: item.owner,
    owners: item.owners,
    outcome: item.outcome,
    sourceSegmentIds: item.source_segment_ids,
    sourceQuote: item.source_quote
  })),
  groundingRejectionTrace: [],
  traceTruncated: false
};

function state(): V4ExecutionState {
  return assembleV4WorkItemState(
    { source: source(), fallbackUsed: false },
    { ok: true, topics: [], latencyMs: 0, usage: null }
  );
}

const NORMALIZATION = { enabled: true, segments: 854 };
const UNKNOWN = { future: { keep: true } };
function checkpoint() {
  const v4State = state();
  return {
    checkpointVersion: 2,
    v2Topology: "b2",
    normalization: structuredClone(NORMALIZATION),
    unknownFutureKey: structuredClone(UNKNOWN),
    prepared: { source: v4State.source, fallbackUsed: false, meetingContextByTopicId: [] },
    engine: "v4",
    v4State,
    gcV2: { harvest: structuredClone(HARVEST) }
  };
}

let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);
function seed(patch: Row = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running",
      started_at: "x", retry_count: 0, current_stage: "atomic_action_harvest", progress: 37,
      checkpoint: checkpoint(), ...patch
    }]
  });
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const units = () => db.rows("meeting_analysis_job_units") as unknown as AnalysisJobUnit[];
const savedCheckpoint = () => jobRow().checkpoint as Row;

function additionFor(item: HarvestedCandidate): GlobalWorkItemAddition {
  return {
    title: item.outcome,
    description: null,
    owner: item.owner,
    owners: item.owners,
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "open_task",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "Synthetic active work",
    source_quote: item.source_quote,
    source_segment_ids: item.source_segment_ids,
    extraction_reason: "Synthetic missing work",
    confidence: 0.8
  };
}

function decision(ref: string, disposition: "add" | "already_represented" = "already_represented") {
  const item = CANDIDATES.find((candidate) => candidate.canonicalRef === ref)!;
  return {
    candidate_id: ref,
    disposition,
    addition: disposition === "add" ? additionFor(item) : null,
    reason: disposition === "add" ? "Missing from ledger" : "Already represented"
  } as const;
}

const PLAN = planCompletenessAdjudicationBatches(CANDIDATES);
function primaryResult(batchIndex: number): CompletenessAdjudicationModelResult {
  const refs = PLAN[batchIndex].candidateRefs;
  const omitLast = batchIndex !== 1;
  return {
    ok: true,
    decisions: refs.slice(0, omitLast ? -1 : undefined).map((ref, index) =>
      decision(ref, batchIndex === 0 && index < 2 ? "add" : "already_represented")),
    latencyMs: 20,
    salvagedItems: 0,
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
  };
}

function coverageResult(retryIndex: number): CompletenessAdjudicationModelResult {
  const ref = retryIndex === 0 ? PLAN[0].candidateRefs.at(-1)! : PLAN[2].candidateRefs.at(-1)!;
  return {
    ok: true,
    decisions: [decision(ref, "add")],
    latencyMs: 11,
    salvagedItems: 0,
    usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48 }
  };
}

function unitDeps(request: v2.V2CompletenessUnitDeps["request"]): v2.V2CompletenessUnitDeps {
  return { execute: executeV2AnalysisUnit, persistence: b2UnitPersistence, loadJob: getMeetingAnalysisJob, request };
}

test("[1-6][21] generation-19-shaped primary plan is deterministic: 37 candidates -> three stable sequential batches", async () => {
  assert.deepEqual(PLAN.map((batch) => [batch.batchIndex, batch.candidateRefs.length]), [[0, 15], [1, 15], [2, 7]]);
  assert.deepEqual(planCompletenessAdjudicationBatches(structuredClone(CANDIDATES)), PLAN);
  seed();
  const planned = await v2.planV2CompletenessPrimary(input, 1);
  assert.deepEqual(planned.units.map((item) => item.unitKey), ["batch:000000", "batch:000001", "batch:000002"]);
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  for (const item of planned.units) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: item.unitKey }, 1, unitDeps(async ({ refs, candidates, source: requestSource }) => {
      const batchIndex = calls++;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      assert.deepEqual(refs, PLAN[batchIndex].candidateRefs);
      assert.equal(candidates, (savedCheckpoint().gcV2 as Row).harvest && ((savedCheckpoint().gcV2 as Row).harvest as Row).candidates);
      assert.equal(requestSource.transcriptSegmentCount, 854);
      inFlight -= 1;
      return primaryResult(batchIndex);
    }));
  }
  assert.equal(calls, 3);
  assert.equal(maxInFlight, 1);
  assert.ok(units().every((unit) => unit.stage === v2.COMPLETENESS_PRIMARY_STAGE));
});

test("[7-12] primary unit is compact/checkpoint-free, first-result-wins, never covers, and infra failures retry", async () => {
  seed();
  const before = structuredClone(savedCheckpoint());
  let calls = 0;
  await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: "batch:000000" }, 1,
    unitDeps(async () => { calls += 1; return primaryResult(0); }));
  assert.deepEqual(savedCheckpoint(), before);
  const stored = structuredClone(units()[0].result);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 10_000);
  assert.doesNotMatch(JSON.stringify(stored), /checkpointVersion|v4State|prepared|transcriptSegmentCount/);
  await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: "batch:000000" }, 2,
    unitDeps(async () => { throw new Error("completed primary must not call model"); }));
  assert.equal(calls, 1);
  assert.deepEqual(units()[0].result, stored);

  seed();
  await assert.rejects(v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: "batch:000000" }, 1,
    unitDeps(async () => { throw new Error("primary transport failure"); })), /primary transport failure/);
  assert.equal(units()[0].status, "failed");
});

test("[11][13-17] handled primary failure is terminal; exact-set validation and shuffled completion preserve coverage plan", async () => {
  seed();
  const failure = { ok: false as const, error: "primary failed", latencyMs: 4, validationFailure: false };
  for (const [index, descriptor] of PLAN.entries()) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => index === 1 ? failure : primaryResult(descriptor.batchIndex)));
  }
  await assert.rejects(v2.finalizeV2CompletenessPrimary(input, 1),
    (error) => error instanceof V2StageFailedError && error.message === "v4_completeness_recovery: primary failed");
  assert.deepEqual([jobRow().status, jobRow().current_stage, jobRow().progress], ["failed", "completeness_adjudication", 39]);

  const good = (key: string): AnalysisJobUnit => ({
    job_id: JOB, stage: v2.COMPLETENESS_PRIMARY_STAGE, unit_key: key, status: "completed",
    result: primaryResult(0) as unknown as AnalysisJobUnit["result"], error: null, attempt: 1,
    started_at: "x", completed_at: "x", created_at: "x", updated_at: "x"
  });
  assert.throws(() => v2.orderCompletenessUnits(["batch:000000"], [], "primary"), /Missing/);
  assert.throws(() => v2.orderCompletenessUnits(["batch:000000"], [good("batch:000001")], "primary"), /Unexpected/);
  assert.throws(() => v2.orderCompletenessUnits(["batch:000000"], [{ ...good("batch:000000"), result: { bad: true } }], "primary"), /Malformed/);

  seed();
  for (const index of [2, 0, 1]) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => primaryResult(index)));
  }
  const barrier = await v2.finalizeV2CompletenessPrimary(input, 1);
  assert.deepEqual(barrier.units, [{ unitKey: "retry:000000" }, { unitKey: "retry:000001" }]);
  const primary = ((((savedCheckpoint().gcV2 as Row).completeness as Row).primary as Row));
  assert.deepEqual((primary.coveragePlan as Row[]).map((item) => [item.retryIndex, item.batchIndex, (item.candidateRefs as string[]).length]),
    [[0, 0, 1], [1, 2, 1]]);
});

test("[18-27] coverage is a separate one-call wave, tolerates handled failure, retries infra, and zero coverage creates no rows", async () => {
  const coverageRow = (key: string): AnalysisJobUnit => ({
    job_id: JOB, stage: v2.COMPLETENESS_COVERAGE_STAGE, unit_key: key, status: "completed",
    result: coverageResult(0) as unknown as AnalysisJobUnit["result"], error: null, attempt: 1,
    started_at: "x", completed_at: "x", created_at: "x", updated_at: "x"
  });
  assert.throws(() => v2.orderCompletenessUnits(["retry:000000"], [], "coverage"), /Missing/);
  assert.throws(() => v2.orderCompletenessUnits(["retry:000000"], [coverageRow("retry:000001")], "coverage"), /Unexpected/);
  seed();
  for (let index = 0; index < PLAN.length; index += 1) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => primaryResult(index)));
  }
  const coverage = await v2.finalizeV2CompletenessPrimary(input, 1);
  let calls = 0;
  for (const item of [...coverage.units].reverse()) {
    const retryIndex = Number(item.unitKey.slice(-6));
    await v2.runV2CompletenessCoverageUnit({ ...input, unitKey: item.unitKey }, 1,
      unitDeps(async ({ refs }) => { calls += 1; assert.equal(refs.length, 1); return coverageResult(retryIndex); }));
  }
  assert.equal(calls, 2);
  const first = structuredClone(units().find((unit) => unit.unit_key === "retry:000000")!.result);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2_000);
  await v2.runV2CompletenessCoverageUnit({ ...input, unitKey: "retry:000000" }, 2,
    unitDeps(async () => { throw new Error("completed coverage must not call model"); }));
  assert.deepEqual(units().find((unit) => unit.unit_key === "retry:000000")!.result, first);

  const failedResult = { ok: false as const, error: "coverage failed", latencyMs: 5, validationFailure: false };
  Object.assign(units().find((unit) => unit.unit_key === "retry:000001")!, { result: failedResult });
  await v2.finalizeV2Completeness(input, 1);
  const final = (((savedCheckpoint().gcV2 as Row).completeness as Row).final as Row);
  assert.deepEqual(final.missingCandidateRefsAfterRetry, [PLAN[2].candidateRefs.at(-1)]);

  seed();
  for (let index = 0; index < PLAN.length; index += 1) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => ({ ...primaryResult(index), decisions: PLAN[index].candidateRefs.map((ref) => decision(ref)) })));
  }
  const zero = await v2.finalizeV2CompletenessPrimary(input, 1);
  assert.deepEqual(zero.units, []);
  await v2.finalizeV2Completeness(input, 1);
  assert.equal(units().filter((unit) => unit.stage === v2.COMPLETENESS_COVERAGE_STAGE).length, 0);

  seed();
  for (let index = 0; index < PLAN.length; index += 1) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => primaryResult(index)));
  }
  await v2.finalizeV2CompletenessPrimary(input, 1);
  await assert.rejects(v2.runV2CompletenessCoverageUnit({ ...input, unitKey: "retry:000000" }, 1,
    unitDeps(async () => { throw new Error("coverage transport failure"); })), /coverage transport failure/);
});

test("[28-38][48] durable primary+coverage deep-equals v1 additions/dedup/order/grounding/diagnostics and preserves checkpoint", async () => {
  seed();
  for (let index = 0; index < PLAN.length; index += 1) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => primaryResult(index)));
  }
  const coverage = await v2.finalizeV2CompletenessPrimary(input, 1);
  for (const item of [...coverage.units].reverse()) {
    const retryIndex = Number(item.unitKey.slice(-6));
    await v2.runV2CompletenessCoverageUnit({ ...input, unitKey: item.unitKey }, 1,
      unitDeps(async () => coverageResult(retryIndex)));
  }
  await v2.finalizeV2Completeness(input, 1);
  const saved = savedCheckpoint();
  const durable = (((saved.gcV2 as Row).completeness as Row).final as Row);

  const responseQueue = [primaryResult(0), coverageResult(0), primaryResult(1), primaryResult(2), coverageResult(1)];
  let responseIndex = 0;
  const v1 = await runCompletenessRecoveryAfterHarvest({
    source: (saved.v4State as V4ExecutionState).source,
    workItems: (saved.v4State as V4ExecutionState).mergedWorkItems,
    harvest: HARVEST,
    createAdjudicationResponse: (async () => {
      const result = responseQueue[responseIndex++];
      assert.equal(result.ok, true);
      return { output_text: JSON.stringify({ decisions: result.ok ? result.decisions : [] }), usage: result.ok ? result.usage : null };
    }) as never
  });
  assert.equal(v1.ok, true);
  assert.deepEqual({ ...durable, latencyMs: 0 }, { ...v1, latencyMs: 0 });
  assert.equal((durable.additions as unknown[]).length, 2);
  assert.equal((durable.duplicatesRemoved as unknown[]).length, 2);
  assert.deepEqual([saved.checkpointVersion, saved.v2Topology, saved.normalization, saved.unknownFutureKey],
    [2, "b2", NORMALIZATION, UNKNOWN]);
  assert.deepEqual((saved.gcV2 as Row).harvest, HARVEST);
  assert.equal(JSON.stringify((saved.gcV2 as Row).completeness).includes((saved.v4State as V4ExecutionState).source.transcript), false);
});

function workerDeps(after: MeetingAnalysisStageDeps["runV4GlobalCorrectionAfterCompleteness"], counters: Row): MeetingAnalysisStageDeps {
  const noop = async (value: unknown) => value as never;
  return {
    normalizeMeetingTranscriptForAnalysis: noop,
    prepareMeetingAnalysis: noop,
    getExecutionIntelligenceEngine: () => "v4",
    runConversationEventExtraction: noop,
    runV4ConversationEventExtraction: noop,
    runActionExtraction: noop,
    runV4WorkItemExtraction: noop,
    runV4GlobalCorrection: async (value: V4ExecutionState) => { counters.harvest = Number(counters.harvest) + 1; return value; },
    runV4GlobalCorrectionAfterHarvest: async (value: V4ExecutionState) => { counters.primary = Number(counters.primary) + 1; return value; },
    runV4GlobalCorrectionAfterCompleteness: after,
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

test("[39-47] post-completeness handoff calls no harvest/primary/coverage, retains retry state on failure, and cleans it on success", async () => {
  seed();
  for (let index = 0; index < PLAN.length; index += 1) {
    await v2.runV2CompletenessPrimaryUnit({ ...input, unitKey: v2.completenessPrimaryUnitKey(index) }, 1,
      unitDeps(async () => ({ ...primaryResult(index), decisions: PLAN[index].candidateRefs.map((ref) => decision(ref)) })));
  }
  await v2.finalizeV2CompletenessPrimary(input, 1);
  await v2.finalizeV2Completeness(input, 1);
  const before = structuredClone(savedCheckpoint().gcV2);
  const counters: Row = { harvest: 0, primary: 0, lifecycle: 0 };
  await assert.rejects(runMeetingAnalysisStage({ ...input, stage: "global_correction" }, workerDeps(
    async () => { counters.lifecycle = Number(counters.lifecycle) + 1; throw new Error("lifecycle timeout"); }, counters)), /lifecycle timeout/);
  assert.deepEqual(savedCheckpoint().gcV2, before);
  Object.assign(jobRow(), { status: "running", error: null });
  await runMeetingAnalysisStage({ ...input, stage: "global_correction" }, workerDeps(
    async (value) => { counters.lifecycle = Number(counters.lifecycle) + 1; return value; }, counters));
  assert.deepEqual(counters, { harvest: 0, primary: 0, lifecycle: 2 });
  assert.equal(savedCheckpoint().gcV2, undefined);

  seed({ generation: GENERATION - 1 });
  await assert.rejects(v2.planV2CompletenessPrimary(input, 1), /Stale analysis generation/);
  seed({ checkpoint: { ...checkpoint(), v2Topology: undefined } });
  await assert.rejects(v2.planV2CompletenessPrimary(input, 1), /B2 v2 topology/);
});
