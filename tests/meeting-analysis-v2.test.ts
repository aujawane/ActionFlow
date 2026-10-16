import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runOrderedAnalysisUnits } from "../lib/meeting-analysis/workflow-concurrency";
import { executeV2AnalysisUnit, type V2UnitPersistence } from "../lib/meeting-analysis/v2-unit-execution";
import { AnalysisUnitValidationError, type AnalysisJobUnit } from "../lib/meeting-analysis/job-units";
import { validateV2AnalysisJob } from "../lib/meeting-analysis/v2-validation";
import type { MeetingAnalysisJob } from "../lib/types";

const input = { jobId: "job", meetingId: "meeting", generation: 2, stage: "probe", unitKey: "unit:000000" };
const row: AnalysisJobUnit = {
  job_id: "job", stage: "probe", unit_key: input.unitKey, status: "running", result: null,
  error: null, attempt: 1, started_at: "now", completed_at: null, created_at: "now", updated_at: "now"
};
function store(overrides: Partial<V2UnitPersistence> = {}): V2UnitPersistence {
  return {
    validate: async () => ({} as MeetingAnalysisJob),
    running: async () => ({ ...row }),
    complete: async (value) => ({ ...row, status: "completed", result: value.result }),
    fail: async () => ({ ...row, status: "failed" }),
    ...overrides
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const units = Array.from({ length: 5 }, (_, i) => ({ unitKey: `unit:00000${i}` }));

test("v2 concurrency never exceeds two, preserves windows and result ordering", async () => {
  const gates = units.map(deferred);
  const started: string[] = [];
  let active = 0;
  let maximum = 0;
  const run = runOrderedAnalysisUnits(units, async (unit) => {
    const i = units.indexOf(unit);
    started.push(unit.unitKey);
    maximum = Math.max(maximum, ++active);
    await gates[i].promise;
    active -= 1;
    return i;
  });
  assert.deepEqual(started, units.slice(0, 2).map((u) => u.unitKey));
  gates[1].resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(started.length, 2);
  gates[0].resolve();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(started, units.slice(0, 4).map((u) => u.unitKey));
  gates[2].resolve(); gates[3].resolve();
  await new Promise((done) => setImmediate(done));
  gates[4].resolve();
  assert.deepEqual(await run, [0, 1, 2, 3, 4]);
  assert.equal(maximum, 2);
});

test("failed window stops later windows while an already running sibling survives", async () => {
  const sibling = deferred();
  const started: string[] = [];
  let siblingFinished = false;
  const failure = new Error("retryable failure");
  const run = runOrderedAnalysisUnits(units, async (unit) => {
    started.push(unit.unitKey);
    if (unit === units[0]) throw failure;
    await sibling.promise;
    siblingFinished = true;
  });
  await assert.rejects(run, (error) => error === failure);
  assert.equal(started.length, 2);
  assert.equal(siblingFinished, false);
  sibling.resolve();
  await new Promise((done) => setImmediate(done));
  assert.equal(siblingFinished, true);
  assert.equal(started.length, 2);
});

test("v2 ordering rejects unsorted or duplicate keys before executing any unit", async () => {
  for (const bad of [[units[1], units[0]], [units[0], units[0]]]) {
    let calls = 0;
    await assert.rejects(runOrderedAnalysisUnits(bad, async () => { calls++; }), /explicitly ordered/);
    assert.equal(calls, 0);
  }
  assert.deepEqual(await runOrderedAnalysisUnits([], async () => 1), []);
});

test("v2 completed unit is reused without executing a model, including JSON null", async () => {
  for (const result of [null, { accepted: "X" }]) {
    let calls = 0;
    assert.deepEqual(await executeV2AnalysisUnit(input, 2, async () => { calls++; return "Y"; }, store({
      running: async () => ({ ...row, status: "completed", result })
    })), result);
    assert.equal(calls, 0);
  }
});

test("v2 SDK attempt reaches running, completion and failure persistence unchanged", async () => {
  const attempts: number[] = [];
  const persistence = store({
    running: async (value) => { attempts.push(value.attempt); return row; },
    complete: async (value) => { attempts.push(value.attempt); return { ...row, result: value.result }; },
    fail: async (value) => { attempts.push(value.attempt); return row; }
  });
  await executeV2AnalysisUnit(input, 3, async () => "ok", persistence);
  await assert.rejects(executeV2AnalysisUnit(input, 4, async () => { throw new Error("model timeout"); }, persistence));
  assert.deepEqual(attempts, [3, 3, 4, 4]);
  const source = await readFile(new URL("../lib/meeting-analysis/v2-foundation-probe.ts", import.meta.url), "utf8");
  assert.match(source, /"use step"/);
  assert.match(source, /getStepMetadata\(\).attempt/);
});

test("retryable infrastructure/model and ambiguous completion errors retain SDK retry eligibility", async () => {
  const { FatalError } = await import("workflow");
  const failure = new Error("connection lost");
  for (const persistence of [store(), store({ fail: async () => { throw new Error("telemetry unavailable"); } })]) {
    await assert.rejects(executeV2AnalysisUnit(input, 1,
      async () => { throw failure; }, persistence),
    (error) => error === failure && !(error instanceof FatalError));
  }
  await assert.rejects(executeV2AnalysisUnit(input, 1, async () => "ok", store({
    complete: async () => { throw failure; }
  })), (error) => error === failure);
});

test("an ambiguous completion retry reuses the accepted result", async () => {
  let accepted: AnalysisJobUnit | null = null;
  let executions = 0;
  const persistence = store({
    running: async () => accepted ?? row,
    complete: async (value) => {
      accepted = { ...row, status: "completed", result: value.result };
      throw new Error("response lost after commit");
    }
  });
  const execute = async () => { executions++; return "X"; };
  await assert.rejects(executeV2AnalysisUnit(input, 1, execute, persistence));
  assert.equal(await executeV2AnalysisUnit(input, 2, execute, persistence), "X");
  assert.equal(executions, 1);
});

test("v2 deterministic validation failure becomes FatalError before external effects", async () => {
  const { FatalError } = await import("workflow");
  let calls = 0;
  await assert.rejects(executeV2AnalysisUnit(input, 1, async () => { calls++; return null; }, store({
    validate: async () => { throw new AnalysisUnitValidationError("wrong version"); }
  })), FatalError);
  assert.equal(calls, 0);
  await assert.rejects(executeV2AnalysisUnit(input, 1,
    async () => { throw new AnalysisUnitValidationError("business failure"); }, store()), FatalError);
});

test("v2 validation checks job-owned version, checkpoint, identity, currency, and terminal status", () => {
  const job = { id: input.jobId, meeting_id: input.meetingId, generation: 2,
    pipeline_version: 2, checkpoint: { checkpointVersion: 2 }, status: "running",
    current_stage: "probe", progress: 0, error: null, retry_count: 0,
    started_at: null, completed_at: null, created_at: "now", updated_at: "now" } satisfies MeetingAnalysisJob;
  validateV2AnalysisJob(job, input, 2);
  for (const patch of [
    { pipeline_version: 1 }, { checkpoint: {} }, { checkpoint: { checkpointVersion: "2" } },
    { generation: 1 }, { status: "stale" }, { status: "failed" }, { status: "completed" },
    { meeting_id: "other" }, { id: "other" }
  ]) {
    assert.throws(() => validateV2AnalysisJob({ ...job, ...patch } as MeetingAnalysisJob, input, 2), AnalysisUnitValidationError);
  }
  assert.throws(() => validateV2AnalysisJob(job, input, 3), /Stale/);
  assert.throws(() => validateV2AnalysisJob(job, input, null), /Stale/);
});

test("v2 fan-out persistence cannot write canonical checkpoint; v1 remains the default", async () => {
  for (const file of ["job-units", "v2-unit-execution", "v2-foundation-probe", "workflow-v2", "workflow-concurrency"]) {
    const source = await readFile(new URL(`../lib/meeting-analysis/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /saveAnalysisJobCheckpoint|markAnalysisJobRunning|\.from\("meeting_analysis_jobs"\)/);
  }
  const enqueue = await readFile(new URL("../lib/meeting-analysis/enqueue.ts", import.meta.url), "utf8");
  assert.doesNotMatch(enqueue, /claimMeetingAnalysisJobV2|claim_meeting_analysis_job_v2/);
  assert.match(enqueue, /options\?\.claimJob \?\? claimMeetingAnalysisJob/);
  assert.match(enqueue, /await start\(meetingAnalysisWorkflow,/);
  const v1 = await readFile(new URL("../lib/meeting-analysis/workflow-steps.ts", import.meta.url), "utf8");
  assert.match(v1, /throw new FatalError\(message\)/);
});
