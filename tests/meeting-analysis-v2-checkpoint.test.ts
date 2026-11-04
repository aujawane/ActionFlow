import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import {
  saveV2Checkpoint,
  stageCheckpoint,
  validateB2Topology,
  V2_TOPOLOGY
} from "../lib/meeting-analysis/checkpoint";
import { AnalysisUnitValidationError } from "../lib/meeting-analysis/job-units";
import {
  ANALYSIS_STAGE_ORDER,
  ANALYSIS_STAGES,
  StaleAnalysisError,
  V2_DOWNSTREAM_STAGE_ORDER,
  type WorkerAnalysisStage
} from "../lib/meeting-analysis/jobs";
import {
  initializeV2Topology,
  markV2AnalysisFailed,
  retryCountFromAttempt
} from "../lib/meeting-analysis/v2-lifecycle";
import { b2UnitPersistence, executeV2AnalysisUnit } from "../lib/meeting-analysis/v2-unit-execution";
import { assertB2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import { runMeetingAnalysisStage, type MeetingAnalysisStageDeps } from "../lib/meeting-analysis/worker";

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
const MEETING = "meeting-b2";
const JOB = "job-b2";
const GENERATION = 11;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };

let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);

const PREPARED = { source: { meetingId: MEETING, transcript: "t", topics: [], insights: [] }, fallbackUsed: false, meetingContextByTopicId: [] };
const NORMALIZATION = { enabled: true, segments: 854, modelCorrections: 28 };
const UNKNOWN = { nested: { keep: [1, 2, 3] } };
const HARVEST = {
  ok: true as const, candidates: [], harvestedByWindow: [], groundingRejected: 0, latencyMs: 1,
  salvagedItems: 0, usage: null, harvestTrace: [], groundingRejectionTrace: [], traceTruncated: false
};
/** The full B2 checkpoint shape every downstream v2 write must preserve. */
const fullCheckpoint = () => ({
  checkpointVersion: 2,
  v2Topology: "b2",
  normalization: structuredClone(NORMALIZATION),
  unknownFutureKey: structuredClone(UNKNOWN),
  prepared: structuredClone(PREPARED),
  engine: "v4",
  v4State: { tag: "v4State-before" },
  gcV2: { harvest: structuredClone(HARVEST) }
});

function seed(job: Row = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running",
      started_at: "x", retry_count: 0, checkpoint: fullCheckpoint(), ...job
    }]
  });
  return db;
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];
const checkpointWrites = () => db.writes.filter((write) => write.table === "meeting_analysis_jobs" && write.op === "update");

/** Distinct sentinel output per stage computation, so a test can tell exactly which keys a stage
 * owns. No model or business logic runs. */
function fakeDeps(onCall: (name: string) => void = () => {}): MeetingAnalysisStageDeps {
  const out = (name: string, value: unknown) => async () => { onCall(name); return value; };
  return {
    normalizeMeetingTranscriptForAnalysis: out("normalize", { tag: "normalization-after" }),
    prepareMeetingAnalysis: out("prepare", { tag: "prepared-after" }),
    getExecutionIntelligenceEngine: () => "v4",
    runConversationEventExtraction: out("events", { tag: "source-with-events" }),
    runV4ConversationEventExtraction: out("events", { tag: "source-with-events" }),
    runActionExtraction: out("candidates", { tag: "state-candidates" }),
    runV4WorkItemExtraction: out("candidates", { tag: "v4-candidates" }),
    runV4GlobalCorrection: out("global_correction", { tag: "v4-global-correction" }),
    runV4GlobalCorrectionAfterHarvest: out("global_correction", { tag: "v4-global-correction" }),
    runCommitmentExtraction: out("verification", { tag: "state-verification" }),
    runV4Grouping: out("verification", { tag: "v4-verification" }),
    runRelationshipEvaluation: out("completeness", { tag: "state-completeness" }),
    runV4GroupingVerification: out("completeness", { tag: "v4-completeness" }),
    runEvidenceVerification: out("final_verification", { tag: "state-final" }),
    runV4TreeAssembly: out("final_verification", { tag: "v4-final" }),
    runV4TaskConsolidation: out("task_consolidation", { tag: "v4-consolidation" }),
    runV4FinalReconciliation: out("synthesis", { tag: "v4-reconciled" }),
    finalizeV4Execution: out("synthesis", { tag: "v4-synthesis" }),
    finalizeIndependentExecution: out("synthesis", { tag: "state-synthesis" })
  } as unknown as MeetingAnalysisStageDeps;
}

const runStage = (stage: WorkerAnalysisStage, deps = fakeDeps(), retryCount?: number) =>
  runMeetingAnalysisStage({ ...input, stage, ...(retryCount === undefined ? {} : { retryCount }) }, deps);

/** Keys each downstream v4 stage owns, with the sentinel values fakeDeps produces. */
const V4_OWNED: Array<[WorkerAnalysisStage, Row]> = [
  ["conversation_events", { prepared: { ...PREPARED, source: { tag: "source-with-events" } }, engine: "v4" }],
  ["candidates", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-candidates" } }],
  ["global_correction", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-global-correction" } }],
  ["verification", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-verification" } }],
  ["completeness", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-completeness" } }],
  ["final_verification", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-final" } }],
  ["task_consolidation", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-consolidation" } }],
  ["synthesis", { prepared: PREPARED, engine: "v4", v4State: { tag: "v4-synthesis" } }]
];

// ------------------------------------------------------------------ v2 merge semantics
for (const [stage, owned] of V4_OWNED) {
  test(`[checkpoint] v2 ${stage} keeps checkpointVersion, v2Topology, normalization and unknown keys; replaces only its own keys`, async () => {
    seed();
    const before = structuredClone(jobRow().checkpoint);
    await runStage(stage);
    const saved = jobRow().checkpoint as Row;
    assert.equal(saved.checkpointVersion, 2);
    assert.equal(saved.v2Topology, "b2");
    assert.deepEqual(saved.normalization, NORMALIZATION);
    assert.deepEqual(saved.unknownFutureKey, UNKNOWN);
    const expected = { ...(before as Row), ...owned };
    if (stage === "global_correction") delete expected.gcV2;
    assert.deepEqual(saved, expected);
    assert.equal(checkpointWrites().length, 2, "stage start + one checkpoint write");
  });
}

test("[checkpoint] v2 transcript_normalization and topic_extraction writes keep every other key", async () => {
  seed();
  await runStage("transcript_normalization");
  assert.deepEqual(jobRow().checkpoint, { ...fullCheckpoint(), normalization: { tag: "normalization-after" } });
  seed();
  await runStage("topic_extraction");
  assert.deepEqual(jobRow().checkpoint, { ...fullCheckpoint(), prepared: { tag: "prepared-after" }, engine: "v4" });
});

test("[checkpoint] the full downstream v2 chain never loses version, topology, normalization or unknown keys", async () => {
  seed({ checkpoint: { checkpointVersion: 2, v2Topology: "b2", normalization: NORMALIZATION, unknownFutureKey: UNKNOWN, prepared: PREPARED, engine: "v4", gcV2: { harvest: HARVEST } } });
  for (const [stage] of V4_OWNED) await runStage(stage);
  const saved = jobRow().checkpoint as Row;
  assert.deepEqual(
    [saved.checkpointVersion, saved.v2Topology, saved.normalization, saved.unknownFutureKey, saved.v4State],
    [2, "b2", NORMALIZATION, UNKNOWN, { tag: "v4-synthesis" }]
  );
});

// ------------------------------------------------------------------ v1 parity
/** The exact literals pre-B2 worker.ts (12e4c1b, lines 97-249) wrote for pipeline v1. */
const PRE_B2_V1: Array<[WorkerAnalysisStage, "v4" | "independent", (checkpoint: Row) => Row | "unchanged"]> = [
  ["transcript_normalization", "v4", (c) => ({ ...c, normalization: { tag: "normalization-after" } })],
  ["topic_extraction", "v4", (c) => ({ ...c, prepared: { tag: "prepared-after" }, engine: "v4" })],
  ["conversation_events", "v4", (c) => ({ prepared: { ...(c.prepared as Row), source: { tag: "source-with-events" } }, engine: "v4" })],
  ["conversation_events", "independent", (c) => ({ prepared: { ...(c.prepared as Row), source: { tag: "source-with-events" } }, engine: "independent" })],
  ["candidates", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-candidates" } })],
  ["candidates", "independent", (c) => ({ prepared: c.prepared as Row, engine: "independent", state: { tag: "state-candidates" } })],
  ["global_correction", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-global-correction" } })],
  ["global_correction", "independent", () => "unchanged"],
  ["verification", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-verification" } })],
  ["verification", "independent", (c) => ({ prepared: c.prepared as Row, engine: "independent", state: { tag: "state-verification" } })],
  ["completeness", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-completeness" } })],
  ["completeness", "independent", (c) => ({ prepared: c.prepared as Row, engine: "independent", state: { tag: "state-completeness" } })],
  ["final_verification", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-final" } })],
  ["final_verification", "independent", (c) => ({ prepared: c.prepared as Row, engine: "independent", state: { tag: "state-final" } })],
  ["task_consolidation", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-consolidation" } })],
  ["task_consolidation", "independent", () => "unchanged"],
  ["synthesis", "v4", (c) => ({ prepared: c.prepared as Row, engine: "v4", v4State: { tag: "v4-synthesis" } })],
  ["synthesis", "independent", (c) => ({ prepared: c.prepared as Row, engine: "independent", state: { tag: "state-synthesis" } })]
];

for (const [stage, engine, expected] of PRE_B2_V1) {
  test(`[v1 parity] ${stage} (${engine}) writes exactly the pre-B2 checkpoint literal`, async () => {
    const checkpoint = {
      normalization: NORMALIZATION, unknownFutureKey: UNKNOWN, prepared: PREPARED, engine,
      ...(engine === "v4" ? { v4State: { tag: "v4State-before" } } : { state: { tag: "state-before" } })
    };
    seed({ pipeline_version: 1, checkpoint: structuredClone(checkpoint) });
    const before = structuredClone(jobRow().checkpoint as Row);
    await runStage(stage);
    const want = expected(before);
    const saved = jobRow().checkpoint;
    if (want === "unchanged") {
      assert.deepEqual(saved, before);
      assert.equal(checkpointWrites().length, 1, "stage start only, no checkpoint write");
      return;
    }
    // Key order included: the serialized JSON is identical to the pre-B2 literal.
    assert.equal(JSON.stringify(saved), JSON.stringify(want));
  });
}

test("[v1 parity] stageCheckpoint returns the v1 literal itself and never merges for pipeline v1", () => {
  const owned = { prepared: PREPARED, engine: "v4" };
  const current = { checkpointVersion: 2, normalization: NORMALIZATION };
  assert.equal(stageCheckpoint({ pipeline_version: 1 }, current, owned), owned);
  assert.throws(() => stageCheckpoint({ pipeline_version: 1 }, current, owned, { remove: ["engine"] }), AnalysisUnitValidationError);
});

// ------------------------------------------------------------------ pure helper
test("[checkpoint] stageCheckpoint never mutates inputs, removes only listed keys, and protects version/topology", () => {
  const current = Object.freeze(fullCheckpoint());
  const owned = Object.freeze({ v4State: { tag: "new" } });
  const merged = stageCheckpoint({ pipeline_version: 2 }, current, owned);
  assert.deepEqual(merged, { ...fullCheckpoint(), v4State: { tag: "new" } });
  assert.notEqual(merged, current);
  assert.deepEqual(stageCheckpoint({ pipeline_version: 2 }, current, {}, { remove: ["unknownFutureKey"] }),
    (({ unknownFutureKey: _removed, ...rest }) => rest)(fullCheckpoint()));
  // A spread of the current checkpoint carries protected keys through unchanged.
  assert.deepEqual(stageCheckpoint({ pipeline_version: 2 }, current, { ...current, engine: "independent" }),
    { ...fullCheckpoint(), engine: "independent" });
  for (const bad of [{ checkpointVersion: 3 }, { v2Topology: "b3" }]) {
    assert.throws(() => stageCheckpoint({ pipeline_version: 2 }, current, bad), AnalysisUnitValidationError);
  }
  for (const key of ["checkpointVersion", "v2Topology"]) {
    assert.throws(() => stageCheckpoint({ pipeline_version: 2 }, current, {}, { remove: [key] }), AnalysisUnitValidationError);
  }
  // A v2 checkpoint that already lost its version is never silently re-versioned.
  assert.throws(() => stageCheckpoint({ pipeline_version: 2 }, { prepared: PREPARED, engine: "v4" }, { v4State: {} }), /checkpointVersion 2/);
  assert.deepEqual(current, fullCheckpoint());
});

// ------------------------------------------------------------------ guarded save
test("[stale/terminal] guarded v2 checkpoint writes reject stale, superseded, terminal and non-v2 jobs without side effects", async () => {
  const cases: Array<[string, Row, number]> = [
    ["stale generation", {}, GENERATION - 1],
    ["superseded generation", { generation: GENERATION + 1 }, GENERATION],
    ["completed job", { status: "completed" }, GENERATION],
    ["failed job", { status: "failed" }, GENERATION],
    ["stale job", { status: "stale" }, GENERATION],
    ["wrong pipeline version", { pipeline_version: 1 }, GENERATION]
  ];
  for (const [label, patch, generation] of cases) {
    seed(patch);
    const before = structuredClone(jobRow());
    await assert.rejects(
      saveV2Checkpoint({ jobId: JOB, generation, checkpoint: { ...fullCheckpoint(), engine: "changed" } }),
      AnalysisUnitValidationError,
      label
    );
    assert.deepEqual(jobRow(), before, label);
  }
  seed();
  await assert.rejects(saveV2Checkpoint({ jobId: JOB, generation: GENERATION, checkpoint: { prepared: PREPARED } }), /checkpointVersion 2/);
  assert.equal(checkpointWrites().length, 0, "an unversioned v2 checkpoint never reaches the database");
});

for (const [label, patch] of [
  ["a newer claim (superseded generation)", { status: "stale" }],
  ["a completed job", { status: "completed" }],
  ["a failed job", { status: "failed" }]
] as const) {
  test(`[stale/terminal] a v2 downstream stage that loses its job to ${label} writes no checkpoint and does not mark it failed`, async () => {
    seed();
    const before = structuredClone(jobRow().checkpoint);
    const deps = fakeDeps();
    deps.runV4WorkItemExtraction = (async () => {
      Object.assign(jobRow(), patch);
      if (patch.status === "stale") db.rows("meetings")[0].execution_graph_generation = GENERATION + 1;
      return { tag: "v4-candidates" };
    }) as unknown as MeetingAnalysisStageDeps["runV4WorkItemExtraction"];
    await assert.rejects(runStage("candidates", deps), StaleAnalysisError);
    assert.deepEqual(jobRow().checkpoint, before);
    assert.equal(jobRow().status, patch.status);
  });
}

test("[stale/terminal] a B1-era v2 checkpoint that lost checkpointVersion fails before any stage work", async () => {
  // Generation 18's shape after the B1 conversation_events write.
  seed({ checkpoint: { prepared: PREPARED, engine: "v4", v4State: { tag: "v4State-before" } } });
  const before = structuredClone(jobRow().checkpoint);
  const calls: string[] = [];
  await assert.rejects(runStage("global_correction", fakeDeps((name) => calls.push(name))), /checkpointVersion 2/);
  assert.deepEqual(calls, []);
  assert.deepEqual(jobRow().checkpoint, before);
});

// ------------------------------------------------------------------ B2 topology marker
test("[topology] a freshly claimed job adopts v2Topology once; retries are idempotent", async () => {
  seed({ status: "queued", checkpoint: { checkpointVersion: 2 } });
  assert.deepEqual(await initializeV2Topology(input), { initialized: true });
  assert.deepEqual(jobRow().checkpoint, { checkpointVersion: 2, v2Topology: V2_TOPOLOGY });
  const writes = checkpointWrites().length;
  assert.deepEqual(await initializeV2Topology(input), { initialized: false });
  assert.equal(checkpointWrites().length, writes);
});

test("[topology] an old B1 v2 job (stage output, no marker) is never retrofitted", async () => {
  for (const checkpoint of [
    { checkpointVersion: 2, normalization: NORMALIZATION },
    { checkpointVersion: 2, normalization: NORMALIZATION, prepared: PREPARED, engine: "v4" },
    { checkpointVersion: 2, v2Topology: "b1" }
  ]) {
    seed({ checkpoint });
    await assert.rejects(initializeV2Topology(input), AnalysisUnitValidationError);
    assert.deepEqual(jobRow().checkpoint, checkpoint);
    assert.equal(checkpointWrites().length, 0);
  }
  for (const patch of [
    { checkpoint: { prepared: PREPARED, engine: "v4" } },
    { pipeline_version: 1, checkpoint: { checkpointVersion: 2 } },
    { status: "stale", checkpoint: { checkpointVersion: 2 } },
    { status: "failed", checkpoint: { checkpointVersion: 2 } },
    { generation: GENERATION - 1, checkpoint: { checkpointVersion: 2 } }
  ]) {
    seed(patch);
    await assert.rejects(initializeV2Topology(input), AnalysisUnitValidationError);
    assert.equal(checkpointWrites().length, 0);
  }
});

test("[old B1 job] pipeline 2 + checkpointVersion 2 without v2Topology cannot enter a B2-only plan, unit or finalizer", async () => {
  const B1_JOB = { checkpointVersion: 2, normalization: NORMALIZATION, prepared: PREPARED, engine: "v4" };
  seed({ checkpoint: B1_JOB });
  // Plan/finalizer entry check.
  await assert.rejects(assertB2AnalysisJob(input), /B2 v2 topology/);
  // Unit entry: rejected before the running RPC and before the model callback.
  let modelCalls = 0;
  const { FatalError } = await import("workflow");
  await assert.rejects(
    executeV2AnalysisUnit({ ...input, stage: "conversation_events", unitKey: "chunk:000000" }, 1, async () => {
      modelCalls += 1;
      return { ok: true };
    }, b2UnitPersistence),
    (error) => error instanceof FatalError && /B2 v2 topology/.test((error as Error).message)
  );
  assert.equal(modelCalls, 0);
  assert.deepEqual(db.rows("meeting_analysis_job_units"), []);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(jobRow().checkpoint, B1_JOB);
  // The same unit runs once the job carries the marker.
  seed();
  await executeV2AnalysisUnit({ ...input, stage: "conversation_events", unitKey: "chunk:000000" }, 1, async () => {
    modelCalls += 1;
    return { ok: true };
  }, b2UnitPersistence);
  assert.equal(modelCalls, 1);
});

test("[topology] validateB2Topology requires pipeline 2, checkpointVersion 2 and the b2 marker", () => {
  validateB2Topology({ pipeline_version: 2, checkpoint: { checkpointVersion: 2, v2Topology: "b2" } });
  for (const job of [
    { pipeline_version: 2, checkpoint: { checkpointVersion: 2 } },
    { pipeline_version: 2, checkpoint: { checkpointVersion: 2, v2Topology: "b1" } },
    { pipeline_version: 2, checkpoint: { v2Topology: "b2" } },
    { pipeline_version: 1, checkpoint: { checkpointVersion: 2, v2Topology: "b2" } },
    { pipeline_version: 2, checkpoint: undefined }
  ]) {
    assert.throws(() => validateB2Topology(job), AnalysisUnitValidationError);
  }
});

// ------------------------------------------------------------------ failure path / retries
test("[failure] the workflow failure marker fails only the current running v2 job", async () => {
  for (const patch of [{ status: "stale" }, { status: "completed" }, { status: "failed", error: "first" }, { pipeline_version: 1 }, { generation: GENERATION + 1 }]) {
    seed(patch);
    const before = structuredClone(jobRow());
    await markV2AnalysisFailed({ ...input, error: "boom" });
    assert.deepEqual(jobRow(), before);
  }
  seed();
  await markV2AnalysisFailed({ ...input, error: "boom" });
  assert.deepEqual([jobRow().status, jobRow().error, jobRow().current_stage], ["failed", "boom", "failed"]);
});

test("[failure] every v2 step runs inside one try; only validation errors become FatalError", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  const body = workflow.slice(workflow.indexOf("export async function meetingAnalysisV2Workflow"));
  const tryAt = body.indexOf("try {");
  const catchAt = body.indexOf("} catch (error) {");
  for (const step of ["initializeV2TopologyStep", "planNormalizationStep", "runNormalizationUnitStep", "finalizeNormalizationStep", "runV2AnalysisStageStep", "runTopicSegmentationStep", "runTopicAnalysisUnitStep", "finalizeTopicExtractionStep", "planConversationEventsStep", "runConversationEventUnitStep", "finalizeConversationEventsStep", "planCandidatesStep", "runCandidateUnitStep", "finalizeCandidatesStep"]) {
    const at = body.indexOf(step);
    assert.ok(at > tryAt && at < catchAt, `${step} is inside the workflow try`);
  }
  assert.ok(body.indexOf("initializeV2TopologyStep") < body.indexOf("planNormalizationStep(input)"), "marker precedes any model work");
  assert.match(body.slice(catchAt), /await failV2AnalysisStep\([\s\S]*?\);\s*throw error;/);
  assert.doesNotMatch(body, /runAnalysisStageStep|new FatalError/);
  const steps = await readFile(new URL("../lib/meeting-analysis/v2-workflow-steps.ts", import.meta.url), "utf8");
  assert.match(steps, /if \(error instanceof AnalysisUnitValidationError\) throw new FatalError\(error\.message\);\s*throw error;/);
  assert.match(steps, /runAnalysisStage\(\{ \.\.\.input, retryCount: retryCountFromAttempt\(getStepMetadata\(\)\.attempt\) \}\)/);
  // v1 is untouched: its step still has no retry count and keeps its own terminal handling.
  const v1 = await readFile(new URL("../lib/meeting-analysis/workflow-steps.ts", import.meta.url), "utf8");
  assert.match(v1, /"use step";\s*return runAnalysisStage\(input\);/);
  assert.match(v1, /const result = await runMeetingAnalysisStage\(input\);/);
  const v1Workflow = await readFile(new URL("../lib/meeting-analysis/workflow.ts", import.meta.url), "utf8");
  assert.match(v1Workflow, /await runAnalysisStageStep\(\{ \.\.\.input, stage \}\);/);
});

test("[retry] retry_count is attempt - 1 for v2 stage steps; v1 keeps writing 0", async () => {
  assert.deepEqual([1, 2, 4].map(retryCountFromAttempt), [0, 1, 3]);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => retryCountFromAttempt(bad), AnalysisUnitValidationError);
  seed();
  await runStage("candidates", fakeDeps(), 2);
  assert.equal(jobRow().retry_count, 2);
  seed({ pipeline_version: 1, retry_count: 0, checkpoint: { prepared: PREPARED, engine: "v4" } });
  await runStage("candidates");
  assert.equal(jobRow().retry_count, 0);
});

// ------------------------------------------------------------------ stage registry
test("[registry] B2 stages are registered with monotonic progress; v1 order and values are unchanged", () => {
  const v2Sequence = ["candidates", ...V2_DOWNSTREAM_STAGE_ORDER.slice(2), "verification"] as const;
  const progress = v2Sequence.map((stage) => ANALYSIS_STAGES[stage].progress);
  assert.deepEqual(progress, [35, 37, 39, 42, 45, 46, 48, 50]);
  const fullV2 = ["topic_extraction", ...V2_DOWNSTREAM_STAGE_ORDER, "verification"] as const;
  fullV2.slice(1).forEach((stage, index) =>
    assert.ok(ANALYSIS_STAGES[stage].progress > ANALYSIS_STAGES[fullV2[index]].progress, stage));
  for (const stage of V2_DOWNSTREAM_STAGE_ORDER) assert.equal(ANALYSIS_STAGES[stage].stage, stage);
  assert.deepEqual([...ANALYSIS_STAGE_ORDER], [
    "transcript_normalization", "topic_extraction", "conversation_events", "candidates", "global_correction",
    "verification", "completeness", "final_verification", "task_consolidation", "synthesis", "persistence"
  ]);
  assert.deepEqual(ANALYSIS_STAGE_ORDER.map((stage) => ANALYSIS_STAGES[stage].progress), [5, 10, 22, 35, 42, 50, 65, 80, 84, 87, 90]);
});

test("[registry] the generic status UI needs no change for the new stage names", async () => {
  const ui = await readFile(new URL("../components/meeting-analysis-status.tsx", import.meta.url), "utf8");
  assert.match(ui, /function formatStage\(stage: string\) \{\s*return stage\.replaceAll\("_", " "\);/);
});

// ------------------------------------------------------------------ ownership invariant
test("[ownership] fan-out unit modules cannot import or call any checkpoint writer", async () => {
  const writer = /saveV2Checkpoint|saveAnalysisJobCheckpoint|stageCheckpoint|\.update\(\{ checkpoint/;
  for (const file of ["job-units", "v2-unit-execution", "v2-foundation-probe", "workflow-concurrency", "workflow-v2", "v2-topic-steps", "v2-workflow-steps", "v2-conversation-event-steps", "v2-candidate-steps", "v2-atomic-action-harvest-steps", "v2-normalization-steps", "v2-validation"]) {
    const source = await readFile(new URL(`../lib/meeting-analysis/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, writer, file);
  }
  // The unit lifecycle modules do not even import the checkpoint module.
  for (const file of ["job-units", "v2-unit-execution", "v2-foundation-probe", "workflow-concurrency"]) {
    const source = await readFile(new URL(`../lib/meeting-analysis/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /meeting-analysis\/checkpoint"/, file);
  }
});

test("[ownership] only jobs.ts and checkpoint.ts write the checkpoint column; only coordinators import the v2 writer", async () => {
  const dir = new URL("../lib/meeting-analysis/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  const writesColumn: string[] = [];
  const importsV2Writer: string[] = [];
  for (const name of files) {
    const source = await readFile(new URL(name, dir), "utf8");
    if (/\.update\(\{ checkpoint/.test(source)) writesColumn.push(name);
    if (/\bsaveV2Checkpoint\b/.test(source) && name !== "checkpoint.ts") importsV2Writer.push(name);
  }
  assert.deepEqual(writesColumn.sort(), ["checkpoint.ts", "jobs.ts"]);
  assert.deepEqual(importsV2Writer.sort(), ["v2-atomic-action-harvest.ts", "v2-candidates.ts", "v2-conversation-events.ts", "v2-lifecycle.ts", "v2-normalization.ts", "v2-topic-extraction.ts", "worker.ts"]);
  // Inside the fan-out stage modules, the writer is reachable only through the finalizer's deps.
  for (const name of ["v2-topic-extraction.ts", "v2-conversation-events.ts", "v2-candidates.ts", "v2-atomic-action-harvest.ts", "v2-normalization.ts"]) {
    const source = await readFile(new URL(name, dir), "utf8");
    assert.deepEqual(source.match(/saveV2Checkpoint/g), ["saveV2Checkpoint", "saveV2Checkpoint"], name);
    assert.match(source, /const finalizeDeps = \{[\s\S]*?saveCheckpoint: saveV2Checkpoint\s*\};/, name);
  }
});
