import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getOpenAIClient } from "../lib/openai";
import { saveV2Checkpoint } from "../lib/meeting-analysis/checkpoint";
import { AnalysisUnitValidationError, listAnalysisStageUnits, type AnalysisJobUnit } from "../lib/meeting-analysis/job-units";
import {
  chunkSegmentsForNormalization,
  finishNormalization,
  loadOrderedTranscriptSegments,
  normalizeMeetingTranscriptForAnalysis,
  requestNormalizationBatch,
  type NormalizationStageResult,
  type SegmentPersistencePatch
} from "../lib/meeting-analysis/normalization";
import { markV2StageRunning } from "../lib/meeting-analysis/v2-lifecycle";
import * as v2 from "../lib/meeting-analysis/v2-normalization";
import { b2UnitPersistence, executeV2AnalysisUnit } from "../lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import { runOrderedAnalysisUnits } from "../lib/meeting-analysis/workflow-concurrency";

// Clients are lazy and read these on first use; nothing here reaches a network.
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_ENV: "staging",
  NEXT_PUBLIC_STAGING_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY: "anon",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test",
  RECALL_API_KEY: "test",
  RECALL_WEBHOOK_SECRET: "test",
  TRANSCRIPT_NORMALIZATION_ENABLED: "true"
});
delete process.env.TRANSCRIPT_NORMALIZATION_AUTO_THRESHOLD;

type Row = Record<string, unknown>;
const MEETING = "meeting-norm";
const PROJECT = "project-norm";
const JOB = "job-norm";
const GENERATION = 30;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };
const STAGE = v2.NORMALIZATION_STAGE;

// --------------------------------------------------------- synthetic transcript (no real content)
const segmentId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const segmentIndex = (id: string) => Number(id.slice(-12));
function segmentText(i: number) {
  if (i === 3) return "the parfa roadmap";
  if (i === 5) return "the wrk item";
  if (i === 36) return "acme again";
  if (i === 37) return "zed needs help";
  if (i % 10 === 0) return `acme rollout ${i}`;
  return `synthetic line ${i}`;
}
const segments = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({
  id: segmentId(i), meeting_id: MEETING, speaker: `Speaker ${i % 3}`, participant_name: null, text: segmentText(i),
  timestamp: new Date(Date.UTC(2026, 9, 30, 12, 0, i)).toISOString(), raw_payload: {}, created_at: "2026-10-30T12:00:00.000Z",
  normalized_text: null, normalization_corrections: null, normalized_at: null, normalization_failed_at: null
}));
const APPROVED_TERM = {
  id: "term-1", project_id: PROJECT, canonical_term: "Parfait", aliases: ["parfa"], term_type: "tool", source: "user_added",
  status: "approved", confidence: 1, evidence_meeting_id: null, evidence_segment_ids: [], created_at: "x", updated_at: "x"
};

// --------------------------------------------------------- deterministic fake model
type Correction = { segment_id: string; original_text: string; normalized_text: string; original_token: string; replacement: string; reason: string; confidence: number; evidence: null };
const fix = (i: number, token: string, replacement: string, confidence: number): Correction => ({
  segment_id: segmentId(i), original_text: token, normalized_text: replacement, original_token: token, replacement,
  reason: "synthetic", confidence, evidence: null
});
/** Depends only on the batch's segments and its first segment, so overlapping batches re-propose
 * and disagree in known ways. */
function modelOutput(start: number, ids: number[]) {
  const corrections = ids.flatMap((i) => {
    if (i === 5) return [fix(5, "wrk", "work", 0.5)]; // below threshold: recorded, never applied
    if (i === 36) return [fix(36, "acme", "Acme", start === 0 ? 0.92 : 0.99)]; // duplicate: highest confidence wins
    if (i === 37) return [fix(37, "zed", start === 0 ? "Zed One" : "Zed Two", 0.95)]; // conflict: batch order decides
    if (i % 10 === 0) return [fix(i, "acme", "Acme", 0.95)];
    return [];
  });
  if (start === 0) corrections.push(fix(500, "acme", "Hallucinated", 0.99)); // out of batch: dropped
  const vocabulary_candidates = start === 0
    ? [{ canonical_term: "Acme", observed_alias: "acme", confidence: 0.9, evidence_segment_ids: [segmentId(0), segmentId(500)] }]
    : start === 35 ? [{ canonical_term: "Acme", observed_alias: "ACME", confidence: 0.8, evidence_segment_ids: [segmentId(36)] }] : [];
  return { corrections, vocabulary_candidates };
}
const model = {
  starts: [] as number[],
  contexts: [] as Row[],
  inFlight: 0,
  maxInFlight: 0,
  failStarts: new Set<number>()
};
function resetModel() {
  Object.assign(model, { starts: [], contexts: [], inFlight: 0, maxInFlight: 0, failStarts: new Set<number>() });
}
Object.assign(getOpenAIClient().responses, {
  create: async (body: { input: Array<{ content: string }>; text: { format: { name: string } } }) => {
    assert.equal(body.text.format.name, "execution_v4_transcript_normalization");
    const context = JSON.parse(body.input[1].content) as { transcript: string };
    const ids = Array.from(context.transcript.matchAll(/^\[([0-9a-f-]{36})\]/gim), (match) => segmentIndex(match[1]));
    const start = ids[0];
    model.starts.push(start);
    model.contexts.push(context as unknown as Row);
    model.inFlight += 1;
    model.maxInFlight = Math.max(model.maxInFlight, model.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (model.failStarts.has(start)) return { output_text: "" };
      return { output_text: JSON.stringify(modelOutput(start, ids)), usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    } finally {
      model.inFlight -= 1;
    }
  }
});

// --------------------------------------------------------- fake database
let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);
const NORMALIZATION_FREE_CHECKPOINT = { checkpointVersion: 2, v2Topology: "b2", unknownFutureKey: { keep: true } };
function seed(options: { job?: Row; count?: number; vocabulary?: Row[] } = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, project_id: PROJECT, created_at: "2026-10-30T11:00:00.000Z", execution_graph_generation: GENERATION, deleted_at: null }],
    transcript_segments: segments(options.count ?? 120),
    project_vocabulary: options.vocabulary ?? [APPROVED_TERM],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running", started_at: "x",
      retry_count: 0, current_stage: "queued", progress: 0, error: null, checkpoint: { ...NORMALIZATION_FREE_CHECKPOINT }, ...options.job
    }]
  });
  return db;
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const batchUnits = () => db.rows("meeting_analysis_job_units").filter((unit) => unit.stage === STAGE);
const transcriptWrites = () => db.writes.filter((write) => write.table === "transcript_segments").length;
const unitDeps = (): v2.V2NormalizationUnitDeps => ({
  execute: executeV2AnalysisUnit, persistence: b2UnitPersistence, loadPlan: v2.loadV2NormalizationPlan,
  loadSegments: loadOrderedTranscriptSegments, request: requestNormalizationBatch
});
const finalizeDeps = (overrides: Partial<v2.V2NormalizationFinalizeDeps> = {}): v2.V2NormalizationFinalizeDeps => ({
  validate: assertB2AnalysisJob, markRunning: markV2StageRunning, loadPlan: v2.loadV2NormalizationPlan,
  loadSegments: loadOrderedTranscriptSegments, listUnits: listAnalysisStageUnits,
  writeSegment: async (id: string, patch: SegmentPersistencePatch) => {
    const { error } = await getSupabaseAdmin().from("transcript_segments").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
  },
  finish: finishNormalization, saveCheckpoint: saveV2Checkpoint, ...overrides
});

/** Mirrors meetingAnalysisV2Workflow's normalization stage (steps are thin wrappers). */
async function runV2Stage(order?: number[]) {
  const plan = await v2.planV2Normalization(input, 1);
  if (order) {
    for (const index of order) await v2.runV2NormalizationUnit({ ...input, unitKey: plan.units[index].unitKey }, 1);
  } else {
    await runOrderedAnalysisUnits(plan.units, (unit) => v2.runV2NormalizationUnit({ ...input, unitKey: unit.unitKey }, 1));
  }
  return { plan, finalized: await v2.finalizeV2Normalization(input, 1) };
}
/** The persisted transcript, minus the run's timestamp values. */
function transcriptState() {
  return db.rows("transcript_segments").map((row) => ({
    id: row.id, text: row.text, normalized_text: row.normalized_text, corrections: row.normalization_corrections,
    normalized: row.normalized_at !== null, failed: row.normalization_failed_at !== null
  }));
}
const vocabularyState = () => db.rows("project_vocabulary").map((row) => [row.canonical_term, row.aliases, row.status, row.evidence_segment_ids]);
async function runV1() {
  seed({ job: { pipeline_version: 1 } });
  const result = await normalizeMeetingTranscriptForAnalysis(MEETING);
  return { result, transcript: transcriptState(), vocabulary: vocabularyState(), starts: [...model.starts], contexts: [...model.contexts] };
}
const byStart = (contexts: Row[]) => [...contexts].sort((a, b) => String(a.transcript).localeCompare(String(b.transcript)));

function unit(index: number, result: unknown, patch: Partial<AnalysisJobUnit> = {}): AnalysisJobUnit {
  return {
    job_id: JOB, stage: STAGE, unit_key: v2.normalizationUnitKey(index), status: "completed", result: result as AnalysisJobUnit["result"],
    error: null, attempt: 1, started_at: null, completed_at: null, created_at: "x", updated_at: "x", ...patch
  };
}

// ================================================================= plan / keys
test("[1][2][3][4] the plan is v1's batching: deterministic, stable keys, same boundaries, overlap and model inputs", async () => {
  resetModel();
  const v1 = await runV1();
  resetModel();
  seed();
  const first = await v2.planV2Normalization(input, 1);
  assert.deepEqual(await v2.planV2Normalization(input, 2), first, "a retried plan returns the same durable plan");
  assert.equal(model.starts.length, 0, "planning makes no model call");
  assert.equal(transcriptWrites(), 0, "planning makes no transcript write");
  assert.deepEqual(first, { mode: "batches", units: ["batch:000000", "batch:000001", "batch:000002", "batch:000003"].map((unitKey) => ({ unitKey })) });
  assert.deepEqual([jobRow().current_stage, jobRow().progress], ["transcript_normalization", 5]);
  // Same boundaries and the exact same model request for every batch (prompt context included).
  await runOrderedAnalysisUnits(first.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  assert.deepEqual(byStart(model.contexts), byStart(v1.contexts));
  assert.deepEqual([...model.starts].sort((a, b) => a - b), v1.starts);
  assert.deepEqual(v1.starts, [0, 35, 70, 105], "40-segment batches with a 5-segment overlap");
  assert.deepEqual([v2.parseNormalizationUnitKey("batch:000024"), v2.normalizationUnitKey(24)], [24, "batch:000024"]);
  for (const bad of ["batch:1", "batch:0000001", "chunk:000001", "plan:000000"]) {
    assert.throws(() => v2.parseNormalizationUnitKey(bad), AnalysisUnitValidationError);
  }
});

test("[854] a generation-19-shaped transcript plans the algorithm's real batch count, with stable keys and small results", async () => {
  const shape = Array.from({ length: 854 }, (_, i) => i);
  const batches = chunkSegmentsForNormalization(shape);
  assert.equal(batches.length, 25, "854 segments at size 40 / overlap 5");
  assert.deepEqual(batches.slice(0, -1).map((batch) => batch.length), Array.from({ length: 24 }, () => 40));
  assert.deepEqual([batches[24][0], batches[24].at(-1), batches[24].length], [840, 853, 14]);
  batches.slice(1).forEach((batch, index) => assert.equal(batches[index].at(-1)! - batch[0] + 1, 5, "5-segment overlap"));
  resetModel();
  seed({ count: 854 });
  const plan = await v2.planV2Normalization(input, 1);
  assert.deepEqual(plan.units.map(({ unitKey }) => unitKey), Array.from({ length: 25 }, (_, i) => `batch:${String(i).padStart(6, "0")}`));
  const planRow = db.rows("meeting_analysis_job_units").find((row) => row.stage === v2.NORMALIZATION_PLAN_STAGE)!;
  assert.ok(JSON.stringify(planRow.result).length < 2_000, "the durable plan holds a snapshot, not the transcript");
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  assert.equal(batchUnits().length, 25);
  assert.equal(model.starts.length, 25);
  assert.ok(batchUnits().every((row) => JSON.stringify(row.result).length < 4_000), "unit results stay small");
});

// ================================================================= units
test("[5][8][9][10] a unit makes one model call, never touches the transcript or checkpoint, and stores only its result", async () => {
  resetModel();
  seed();
  const before = { checkpoint: structuredClone(jobRow().checkpoint), transcript: transcriptState() };
  const plan = await v2.planV2Normalization(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  assert.equal(model.starts.length, plan.units.length, "exactly one call per batch");
  assert.equal(transcriptWrites(), 0, "no canonical transcript write before the finalizer");
  assert.deepEqual(transcriptState(), before.transcript);
  assert.deepEqual(jobRow().checkpoint, before.checkpoint);
  for (const row of batchUnits()) {
    assert.deepEqual(Object.keys(row.result as Row).sort(), ["corrections", "latencyMs", "ok", "salvagedItems", "usage", "vocabularyCandidates"]);
    assert.doesNotMatch(JSON.stringify(row.result), /synthetic line|"transcript"|"prepared"|"checkpoint"/);
  }
  const planRow = db.rows("meeting_analysis_job_units").find((row) => row.stage === v2.NORMALIZATION_PLAN_STAGE)!;
  assert.doesNotMatch(JSON.stringify(planRow.result), /synthetic line|acme rollout/);
});

test("[6][7] a completed unit skips the model on retry; the first completed result wins", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  const unitKey = plan.units[1].unitKey;
  await v2.runV2NormalizationUnit({ ...input, unitKey }, 1);
  const stored = structuredClone(batchUnits()[0].result);
  const ack = await v2.runV2NormalizationUnit({ ...input, unitKey }, 2, {
    ...unitDeps(),
    request: async () => { throw new Error("the model must not be called again"); },
    loadSegments: async () => { throw new Error("a completed unit must not reload the transcript"); }
  });
  assert.deepEqual(ack, { unitKey, ok: true });
  assert.equal(model.starts.length, 1);
  assert.deepEqual(batchUnits()[0].result, stored);
});

test("[concurrency] batches are independent, so they run at most two at a time", async () => {
  resetModel();
  seed();
  await runV2Stage();
  assert.equal(model.maxInFlight, 2);
  assert.equal(model.starts.length, 4);
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  assert.match(workflow, /runOrderedAnalysisUnits\(normalization\.units, \(unit\) =>\s*runNormalizationUnitStep/);
  // Independence: a batch's request depends only on the plan, never on another batch's output.
  const library = await readFile(new URL("../lib/meeting-analysis/normalization.ts", import.meta.url), "utf8");
  const request = library.match(/export function requestNormalizationBatch\([\s\S]*?\n\}/)![0];
  assert.doesNotMatch(request, /merge|proposedBySegment|normalized_text/);
});

test("[12] a thrown DB/infrastructure error stays Workflow-retryable; the retry calls the model once", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  const unitKey = plan.units[0].unitKey;
  const { FatalError } = await import("workflow");
  await assert.rejects(
    v2.runV2NormalizationUnit({ ...input, unitKey }, 1, { ...unitDeps(), loadSegments: async () => { throw new Error("connection reset"); } }),
    (error) => !(error instanceof FatalError) && /connection reset/.test((error as Error).message)
  );
  assert.deepEqual([batchUnits()[0].status, batchUnits()[0].attempt, model.starts.length], ["failed", 1, 0]);
  await v2.runV2NormalizationUnit({ ...input, unitKey }, 2, unitDeps());
  assert.deepEqual([batchUnits()[0].status, batchUnits()[0].attempt, model.starts.length], ["completed", 2, 1]);
});

// ================================================================= v1 parity
test("[21][23][30] the final transcript, vocabulary and checkpoint.normalization deep-equal v1 for the same model outputs", async () => {
  resetModel();
  const v1 = await runV1();
  assert.equal(v1.result.status, "completed");
  assert.ok(v1.result.modelCorrectionCount > 0);
  resetModel();
  seed();
  const { finalized } = await runV2Stage();
  assert.deepEqual(finalized, { status: "completed", alreadyFinalized: false });
  assert.deepEqual(transcriptState(), v1.transcript);
  assert.deepEqual(vocabularyState(), v1.vocabulary);
  assert.deepEqual((jobRow().checkpoint as Row).normalization, v1.result);
  // The deterministic alias pass, the below-threshold audit entry and the hallucination guard all ran.
  const rows = db.rows("transcript_segments");
  assert.equal(rows[3].normalized_text, "the Parfait roadmap");
  assert.equal(rows[5].normalized_text, null);
  assert.deepEqual((rows[5].normalization_corrections as Row[]).map((c) => c.applied), [false]);
  assert.ok(!JSON.stringify(rows).includes("Hallucinated"));
  // Raw text is never touched.
  assert.deepEqual(rows.map((row) => row.text), segments(120).map((row) => row.text));
});

test("[19][20] overlap conflicts resolve by batch order and duplicates by highest confidence, exactly like v1", async () => {
  resetModel();
  const v1 = await runV1();
  resetModel();
  seed();
  await runV2Stage();
  const rows = db.rows("transcript_segments");
  assert.equal(rows[37].normalized_text, "Zed One needs help", "the earlier batch's replacement is applied first");
  assert.deepEqual((rows[37].normalization_corrections as Row[]).map((c) => c.replacement), ["Zed One", "Zed Two"], "both stay in the audit trail");
  const duplicate = rows[36].normalization_corrections as Row[];
  assert.deepEqual(duplicate.map((c) => [c.replacement, c.confidence]), [["Acme", 0.99]], "one record, highest confidence");
  assert.deepEqual(transcriptState()[37], v1.transcript[37]);
  assert.deepEqual(transcriptState()[36], v1.transcript[36]);
});

test("[18] completion order never changes the merged result", async () => {
  resetModel();
  seed();
  await runV2Stage([0, 1, 2, 3]);
  const expected = { transcript: transcriptState(), vocabulary: vocabularyState(), normalization: (jobRow().checkpoint as Row).normalization };
  for (const order of [[3, 2, 1, 0], [1, 0, 3, 2], [2, 0, 3, 1]]) {
    resetModel();
    seed();
    await runV2Stage(order);
    assert.deepEqual(transcriptState(), expected.transcript, order.join());
    assert.deepEqual(vocabularyState(), expected.vocabulary, order.join());
    assert.deepEqual((jobRow().checkpoint as Row).normalization, expected.normalization, order.join());
  }
  assert.equal(db.rows("transcript_segments")[37].normalized_text, "Zed One needs help");
});

test("[11] a handled model failure skips that batch and the job continues, exactly like v1", async () => {
  resetModel();
  model.failStarts = new Set([70]);
  const v1 = await runV1();
  assert.deepEqual([v1.result.status, v1.result.reason, v1.result.failureDetail],
    ["failed", "model_error", "OpenAI returned empty transcript_normalization output."]);
  resetModel();
  model.failStarts = new Set([70]);
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  const failedUnit = batchUnits().find((row) => row.unit_key === "batch:000002")!;
  assert.deepEqual([failedUnit.status, failedUnit.attempt, (failedUnit.result as Row).ok], ["completed", 1, false], "completes, no Workflow retry");
  assert.deepEqual(await v2.finalizeV2Normalization(input, 1), { status: "failed", alreadyFinalized: false }, "the finalizer does not throw");
  assert.deepEqual(transcriptState(), v1.transcript);
  assert.deepEqual((jobRow().checkpoint as Row).normalization, v1.result);
  const rows = db.rows("transcript_segments");
  assert.equal(jobRow().status, "running", "normalization failure never fails the job");
  assert.deepEqual([rows[72].normalized_at !== null, rows[72].normalization_failed_at], [true, null], "covered by a successful overlapping batch");
  assert.deepEqual([rows[90].normalized_at, rows[90].normalization_failed_at !== null], [null, true], "covered only by the failed batch");
  assert.equal(rows[90].normalized_text, null);
});

test("[22] normalized_at semantics match v1: one run timestamp on succeeded rows, null on failed-only rows", async () => {
  resetModel();
  model.failStarts = new Set([70]);
  seed();
  await runV2Stage();
  const rows = db.rows("transcript_segments");
  const stamps = new Set(rows.map((row) => row.normalized_at).filter(Boolean));
  assert.equal(stamps.size, 1);
  assert.ok(rows.every((row) => (row.normalized_at === null) !== (row.normalization_failed_at === null)), "never both set, never neither");
});

test("disabled and empty-transcript runs match v1's skipped results with no units and no model calls", async () => {
  resetModel();
  seed({ count: 0 });
  const v1NoTranscript = await normalizeMeetingTranscriptForAnalysis(MEETING);
  const empty = await runV2Stage();
  assert.deepEqual(empty.plan, { mode: "skipped", units: [] });
  assert.deepEqual((jobRow().checkpoint as Row).normalization, v1NoTranscript);
  assert.equal((v1NoTranscript as NormalizationStageResult).reason, "no_transcript");
  const original = process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
  delete process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
  try {
    seed();
    const v1Disabled = await normalizeMeetingTranscriptForAnalysis(MEETING);
    const disabled = await runV2Stage();
    assert.deepEqual(disabled.plan, { mode: "skipped", units: [] });
    assert.deepEqual((jobRow().checkpoint as Row).normalization, v1Disabled);
    assert.equal(transcriptWrites(), 0);
  } finally {
    process.env.TRANSCRIPT_NORMALIZATION_ENABLED = original;
  }
  assert.equal(model.starts.length, 0);
});

// ================================================================= snapshot consistency
test("one durable plan: a mid-run vocabulary change cannot split a run, and a replaced transcript is rejected", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  // A term approved after planning must not change later batches or the finalizer, as in v1's single read.
  db.rows("project_vocabulary").push({ ...APPROVED_TERM, id: "term-2", canonical_term: "Synthetic Corp", aliases: ["synthetic line"] });
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  await v2.finalizeV2Normalization(input, 1);
  assert.equal(db.rows("transcript_segments")[1].normalized_text, null);
  assert.ok(model.contexts.every((context) => JSON.stringify(context.project_vocabulary) === JSON.stringify([{ canonical_term: "Parfait", aliases: ["parfa"], type: "tool" }])));

  resetModel();
  seed();
  const second = await v2.planV2Normalization(input, 1);
  await v2.runV2NormalizationUnit({ ...input, unitKey: second.units[0].unitKey }, 1);
  db.rows("transcript_segments")[1].text = "the transcript was re-imported";
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.runV2NormalizationUnit({ ...input, unitKey: second.units[1].unitKey }, 1),
    (error) => error instanceof FatalError && /Transcript changed/.test((error as Error).message));
  await assert.rejects(v2.finalizeV2Normalization(input, 1), /Transcript changed/);
  assert.equal(transcriptWrites(), 0);
});

// ================================================================= finalizer validation
test("[15][16][17] missing, unexpected, duplicate, incomplete and malformed units fail finalization with no writes", async () => {
  const ok = { ok: true, corrections: [], vocabularyCandidates: [], latencyMs: 1, salvagedItems: 0, usage: null };
  const cases: Array<[string, AnalysisJobUnit[], RegExp]> = [
    ["missing", [unit(0, ok), unit(2, ok)], /Missing normalization unit batch:000001/],
    ["unexpected index", [unit(0, ok), unit(1, ok), unit(2, ok), unit(3, ok)], /Unexpected normalization unit batch:000003/],
    ["unexpected key", [unit(0, ok), unit(1, ok), unit(2, ok), { ...unit(0, ok), unit_key: "chunk:000000" }], /Unexpected normalization unit chunk:000000/],
    ["duplicate", [unit(0, ok), unit(1, ok), unit(1, ok), unit(2, ok)], /Duplicate normalization unit batch:000001/],
    ["running", [unit(0, ok), unit(1, null, { status: "running" }), unit(2, ok)], /batch:000001 is not completed/],
    ["failed", [unit(0, ok), unit(1, null, { status: "failed" }), unit(2, ok)], /batch:000001 is not completed/],
    ["malformed", [unit(0, ok), unit(1, { ok: true, corrections: [] }), unit(2, ok)], /Malformed normalization unit batch:000001/]
  ];
  for (const [label, list, message] of cases) {
    assert.throws(() => v2.orderNormalizationUnits(3, list), (error) => error instanceof AnalysisUnitValidationError && message.test((error as Error).message), label);
  }
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  for (const planned of plan.units.slice(0, 3)) await v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1);
  const before = structuredClone(jobRow().checkpoint);
  await assert.rejects(v2.finalizeV2Normalization(input, 1), /Missing normalization unit batch:000003/);
  assert.equal(transcriptWrites(), 0, "a partial stage never reaches the transcript");
  assert.deepEqual(jobRow().checkpoint, before);
});

// ================================================================= checkpoint
test("[24][25][26] the finalizer adds only `normalization` and keeps version, topology and unknown keys", async () => {
  resetModel();
  seed();
  const before = structuredClone(jobRow().checkpoint as Row);
  await runV2Stage();
  const { normalization, ...rest } = jobRow().checkpoint as Row;
  assert.deepEqual(rest, before);
  assert.deepEqual([rest.checkpointVersion, rest.v2Topology, rest.unknownFutureKey], [2, "b2", { keep: true }]);
  assert.deepEqual(Object.keys(normalization as Row).sort(), ["appliedCorrectionCount", "deterministicCorrectionCount", "failureDetail", "modelCorrectionCount", "reason", "segmentCount", "status", "vocabularyCandidateCount"]);
});

// ================================================================= idempotency
test("[27][28] a finalizer killed after writing rows, or redelivered after finishing, can never double-apply", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  // Rows are written, then the invocation dies before the checkpoint is saved.
  await assert.rejects(v2.finalizeV2Normalization(input, 1, finalizeDeps({
    saveCheckpoint: async () => { throw new Error("connection lost after the writes"); }
  })), /connection lost/);
  const afterFirst = { transcript: transcriptState(), vocabulary: vocabularyState() };
  assert.ok(db.rows("transcript_segments").some((row) => row.normalized_text !== null));
  assert.equal((jobRow().checkpoint as Row).normalization, undefined, "only the checkpoint marks the stage done");

  // The redelivered finalizer rewrites from raw text: identical transcript, corrections and vocabulary.
  assert.deepEqual(await v2.finalizeV2Normalization(input, 2), { status: "completed", alreadyFinalized: false });
  assert.deepEqual(transcriptState(), afterFirst.transcript);
  assert.deepEqual(vocabularyState(), afterFirst.vocabulary);
  assert.equal(db.rows("project_vocabulary").filter((row) => row.canonical_term === "Acme").length, 1);
  assert.equal(db.rows("transcript_segments")[37].normalized_text, "Zed One needs help");
  const checkpoint = structuredClone(jobRow().checkpoint);

  // A redelivery after completion does nothing at all, and no model call is ever repeated.
  const writes = transcriptWrites();
  const calls = model.starts.length;
  assert.deepEqual(await v2.finalizeV2Normalization(input, 3), { status: "completed", alreadyFinalized: true });
  assert.equal(transcriptWrites(), writes);
  assert.deepEqual(jobRow().checkpoint, checkpoint);
  assert.equal(model.starts.length, calls);
});

test("[27] a partially written finalizer converges on retry, and a failed row write throws a retryable error", async () => {
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  let writesAllowed = 40;
  const { FatalError } = await import("workflow");
  await assert.rejects(v2.finalizeV2Normalization(input, 1, finalizeDeps({
    writeSegment: async (id, patch) => {
      if (writesAllowed-- <= 0) throw new Error("database unavailable");
      await finalizeDeps().writeSegment(id, patch);
    }
  })), (error) => !(error instanceof FatalError) && /database unavailable/.test((error as Error).message));
  assert.equal((jobRow().checkpoint as Row).normalization, undefined);
  assert.ok(db.rows("transcript_segments").some((row) => row.normalized_at === null), "only some rows were written");
  await v2.finalizeV2Normalization(input, 2);
  const converged = transcriptState();
  resetModel();
  seed();
  await runV2Stage();
  assert.deepEqual(converged, transcriptState(), "same transcript as an uninterrupted run");
});

// ================================================================= guards
test("[14][13] old B1, wrong-version, terminal and stale jobs are rejected before model work or writes", async () => {
  const { v2Topology: _dropped, ...b1Checkpoint } = NORMALIZATION_FREE_CHECKPOINT;
  const { FatalError } = await import("workflow");
  for (const [label, patch, message] of [
    ["old B1 job", { checkpoint: b1Checkpoint }, /B2 v2 topology/],
    ["pipeline v1", { pipeline_version: 1 }, /version 2/],
    ["missing checkpointVersion", { checkpoint: { v2Topology: "b2" } }, /version 2/],
    ["failed job", { status: "failed" }, /terminal/],
    ["completed job", { status: "completed" }, /terminal/],
    ["stale generation", { generation: GENERATION - 1 }, /Stale analysis generation/]
  ] as const) {
    resetModel();
    seed({ job: patch as Row });
    const before = structuredClone(jobRow());
    await assert.rejects(v2.planV2Normalization(input, 1), message, label);
    await assert.rejects(v2.runV2NormalizationUnit({ ...input, unitKey: "batch:000000" }, 1),
      (error) => error instanceof FatalError && message.test((error as Error).message), label);
    await assert.rejects(v2.finalizeV2Normalization(input, 1), message, label);
    assert.equal(model.starts.length, 0, label);
    assert.deepEqual(db.rows("meeting_analysis_job_units"), [], label);
    assert.equal(transcriptWrites(), 0, label);
    assert.deepEqual(jobRow(), before, label);
  }
  // A newer claim landing just before the checkpoint write.
  resetModel();
  seed();
  const plan = await v2.planV2Normalization(input, 1);
  await runOrderedAnalysisUnits(plan.units, (planned) => v2.runV2NormalizationUnit({ ...input, unitKey: planned.unitKey }, 1));
  await assert.rejects(v2.finalizeV2Normalization(input, 1, finalizeDeps({
    finish: async (...args) => {
      const result = await finishNormalization(...args);
      Object.assign(jobRow(), { status: "stale" });
      return result;
    }
  })), /Stale analysis generation/);
  assert.equal((jobRow().checkpoint as Row).normalization, undefined);
});

// ================================================================= scope
test("[29] workflow order: topology, durable normalization, then the unchanged topic, event and candidate stages", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  const body = workflow.slice(workflow.indexOf("export async function meetingAnalysisV2Workflow"));
  const order = ["initializeV2TopologyStep(input)", "planNormalizationStep(input)", "runNormalizationUnitStep(", "finalizeNormalizationStep(input)", "runTopicSegmentationStep(input)", "finalizeTopicExtractionStep(input)", "planConversationEventsStep(input)", "finalizeConversationEventsStep(input)", "planCandidatesStep(input)", "finalizeCandidatesStep(input)", "for (const stage of STAGES_AFTER_CANDIDATES)"]
    .map((marker) => body.indexOf(marker));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `ordered: ${order}`);
  assert.doesNotMatch(body, /stage: "transcript_normalization"/, "the monolithic v1 step is no longer used by v2");
  const steps = await readFile(new URL("../lib/meeting-analysis/v2-normalization-steps.ts", import.meta.url), "utf8");
  assert.equal(steps.match(/"use step";/g)?.length, 3);
  assert.equal(steps.match(/getStepMetadata\(\)\.attempt/g)?.length, 3);
  assert.doesNotMatch(steps, /checkpoint|transcript_segments/);
  // v1 keeps its sequential loop and never touches the unit table.
  const library = await readFile(new URL("../lib/meeting-analysis/normalization.ts", import.meta.url), "utf8");
  const v1 = library.match(/export async function normalizeMeetingTranscriptForAnalysis\([\s\S]*?\n\}/)![0];
  assert.match(v1, /for \(const batch of plan\.batches\) \{\s*applyNormalizationBatchResult\(merge, plan, batch, await requestNormalizationBatch\(plan, batch, options\)\);/);
  assert.doesNotMatch(library, /meeting_analysis_job_units|job-units/);
  const worker = await readFile(new URL("../lib/meeting-analysis/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /deps\.normalizeMeetingTranscriptForAnalysis\(input\.meetingId\)/);
});
