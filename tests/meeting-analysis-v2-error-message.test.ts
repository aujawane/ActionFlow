import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { V2_FALLBACK_ERROR_MESSAGE, workflowErrorMessage } from "../lib/meeting-analysis/error-message";
import { meetingAnalysisV2Workflow } from "../lib/meeting-analysis/workflow-v2";

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
const FALLBACK = "Meeting analysis failed.";
const MEETING = "meeting-err";
const JOB = "job-err";
const GENERATION = 3;
const input = { meetingId: MEETING, jobId: JOB, generation: GENERATION };

/** The ESM export has the runtime classes; the CJS export is the compiler plugin (see v2-unit-execution.ts). */
const loadFatalError = async () => (await import("workflow")).FatalError;

/** An Error built in a different JavaScript realm, like the rejections the Workflow SDK hands to a
 * workflow function (which itself runs inside a vm context). */
const crossRealmError = (message: string) => vm.runInNewContext(`new Error(${JSON.stringify(message)})`) as Error;

// ================================================================= pure helper
test("[root cause] a cross-realm Error is not instanceof Error, so the old expression lost its message", () => {
  const foreign = crossRealmError("Step \"runV2AnalysisStageStep\" failed after 3 retries: socket hang up");
  assert.equal(foreign instanceof Error, false, "the precondition that caused generation 19's fallback text");
  assert.equal(foreign.constructor === Error, false);
  const oldCatchExpression = (error: unknown) => (error instanceof Error ? error.message : FALLBACK);
  assert.equal(oldCatchExpression(foreign), FALLBACK, "the old implementation returns the generic fallback");
  assert.equal(workflowErrorMessage(foreign), "Step \"runV2AnalysisStageStep\" failed after 3 retries: socket hang up");
});

test("[root cause] the production direction: a host-realm error seen by code running inside a vm context", async () => {
  // The workflow function runs in a vm context; the SDK rejects it with host-realm errors.
  const FatalError = await loadFatalError();
  const hostError = new FatalError("Step \"x\" failed after 3 retries: real message");
  const insideVm = vm.runInNewContext("(e) => (e instanceof Error ? e.message : 'Meeting analysis failed.')") as (e: unknown) => string;
  assert.equal(insideVm(hostError), FALLBACK, "old check, evaluated in the vm realm, loses the message");
  assert.equal(workflowErrorMessage(hostError), "Step \"x\" failed after 3 retries: real message");
});

test("ordinary Error, FatalError and subclasses keep their message", async () => {
  const FatalError = await loadFatalError();
  assert.equal(workflowErrorMessage(new Error("plain failure")), "plain failure");
  assert.equal(workflowErrorMessage(new TypeError("bad type")), "bad type");
  assert.equal(workflowErrorMessage(new FatalError("fatal one")), "fatal one");
});

test("a plain object (or function) with a string message is read; the message is trimmed", () => {
  assert.equal(workflowErrorMessage({ message: "from a plain object" }), "from a plain object");
  assert.equal(workflowErrorMessage({ message: "  padded  \n" }), "padded");
  assert.equal(workflowErrorMessage(Object.assign(() => undefined, { message: "from a function" })), "from a function");
  assert.equal(workflowErrorMessage(Object.create({ message: "inherited" })), "inherited");
});

test("a thrown string is used as the message", () => {
  assert.equal(workflowErrorMessage("thrown as a string"), "thrown as a string");
  assert.equal(workflowErrorMessage("  trimmed string \n"), "trimmed string");
});

test("a message wins over the value being a string; precedence is message, then string, then fallback", () => {
  assert.equal(workflowErrorMessage({ message: "first", toString: () => "never" }), "first");
  assert.equal(workflowErrorMessage({ message: "", toString: () => "never" }), FALLBACK);
});

test("empty, missing and non-string messages fall back", () => {
  for (const value of [new Error(""), new Error("   "), { message: "" }, { message: " \t\n" }, { message: 42 }, { message: null }, { message: { nested: "x" } }, {}, [], ""]) {
    assert.equal(workflowErrorMessage(value), FALLBACK, JSON.stringify(value));
  }
  assert.equal(V2_FALLBACK_ERROR_MESSAGE, FALLBACK);
});

test("null, undefined and primitives fall back", () => {
  for (const value of [null, undefined, 0, 42, NaN, true, false, Symbol("s"), BigInt(10)]) {
    assert.equal(workflowErrorMessage(value), FALLBACK, String(typeof value));
  }
});

test("an arbitrary object is never stringified or serialized into the message", () => {
  const secret = { apiKey: "sk-should-never-appear", body: { prompt: "never stored" }, toString: () => "stringified-object" };
  const result = workflowErrorMessage(secret);
  assert.equal(result, FALLBACK);
  assert.doesNotMatch(result, /sk-should-never-appear|never stored|stringified-object|\[object/);
  assert.equal(workflowErrorMessage({ toJSON: () => ({ leaked: true }) }), FALLBACK);
});

test("a stack trace is never included", () => {
  const error = new Error("only the message");
  error.stack = "Error: only the message\n    at secretFunction (/srv/app/secret.ts:1:1)";
  const result = workflowErrorMessage(error);
  assert.equal(result, "only the message");
  assert.doesNotMatch(result, /secretFunction|\sat\s|\/srv\/app/);
  assert.equal(workflowErrorMessage({ stack: "at x (y.ts:1:1)" }), FALLBACK, "stack alone is not a message");
});

test("the failure path cannot be broken by a throwing getter or proxy", () => {
  const hostile = { get message(): string { throw new Error("getter exploded"); } };
  assert.equal(workflowErrorMessage(hostile), FALLBACK);
  const proxy = new Proxy({}, { get() { throw new Error("proxy exploded"); } });
  assert.equal(workflowErrorMessage(proxy), FALLBACK);
  assert.equal(workflowErrorMessage(crossRealmError("still fine")), "still fine");
});

test("a custom fallback is honored", () => {
  assert.equal(workflowErrorMessage(undefined, "custom"), "custom");
  assert.equal(workflowErrorMessage(new Error("x"), "custom"), "x");
});

// ================================================================= the real workflow catch
let db = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => db);

function seed(job: Row = {}) {
  db = new FakeDb({
    meetings: [{ id: MEETING, execution_graph_generation: GENERATION, deleted_at: null }],
    meeting_analysis_jobs: [{
      id: JOB, meeting_id: MEETING, generation: GENERATION, pipeline_version: 2, status: "running",
      started_at: "x", retry_count: 0, current_stage: "global_correction", progress: 42, error: null,
      checkpoint: { checkpointVersion: 2 }, ...job
    }]
  });
  return db;
}
const jobRow = () => db.rows("meeting_analysis_jobs")[0];

/** Makes the workflow's first step throw `thrown` (a one-shot DB failure), so the value arrives at
 * the real `catch` in meetingAnalysisV2Workflow exactly as a rejected step would. */
function failFirstJobRead(thrown: unknown) {
  const realFrom = db.from.bind(db);
  let armed = true;
  db.from = ((table: string) => {
    if (armed && table === "meeting_analysis_jobs") {
      armed = false;
      throw thrown;
    }
    return realFrom(table);
  }) as typeof db.from;
}

test("[workflow path] a cross-realm Error reaching the workflow catch stores its real message, not the fallback", async () => {
  seed();
  const foreign = crossRealmError("Step \"runV2AnalysisStageStep\" failed after 3 retries: function timed out");
  assert.equal(foreign instanceof Error, false);
  failFirstJobRead(foreign);
  await assert.rejects(meetingAnalysisV2Workflow(input), (error) => error === foreign, "the original error is still rethrown, same identity");
  assert.deepEqual(
    [jobRow().status, jobRow().current_stage, jobRow().progress, jobRow().error],
    ["failed", "failed", 100, "Step \"runV2AnalysisStageStep\" failed after 3 retries: function timed out"]
  );
});

test("[workflow path] plain-object, string and ordinary errors all reach the job row", async () => {
  const FatalError = await loadFatalError();
  for (const [thrown, expected] of [
    [{ message: "plain object message" }, "plain object message"],
    ["thrown string message", "thrown string message"],
    [new Error("ordinary host error"), "ordinary host error"],
    [new FatalError("fatal from the SDK"), "fatal from the SDK"],
    [{ unrelated: true }, FALLBACK],
    [undefined, FALLBACK]
  ] as const) {
    seed();
    failFirstJobRead(thrown);
    await assert.rejects(meetingAnalysisV2Workflow(input), (error) => error === thrown);
    assert.deepEqual([jobRow().status, jobRow().error], ["failed", expected], String(expected));
  }
});

test("[workflow path] terminal semantics are unchanged: stale, completed, failed and v1 jobs are never overwritten", async () => {
  for (const patch of [
    { status: "stale", error: "Superseded by a newer analysis generation." },
    { status: "completed", error: null },
    { status: "failed", error: "first failure wins" },
    { pipeline_version: 1 },
    { generation: GENERATION + 1 }
  ] as Row[]) {
    seed(patch);
    // The workflow's own validation would reject some of these first; inject the error directly.
    failFirstJobRead(crossRealmError("late error"));
    const before = structuredClone(jobRow());
    await assert.rejects(meetingAnalysisV2Workflow(input), /late error/);
    assert.deepEqual(jobRow(), before, JSON.stringify(patch));
  }
});

// ================================================================= nothing else changed
test("only the message extraction changed: the catch still marks once, then rethrows; no retry wiring was touched", async () => {
  const workflow = await readFile(new URL("../lib/meeting-analysis/workflow-v2.ts", import.meta.url), "utf8");
  const body = workflow.slice(workflow.indexOf("export async function meetingAnalysisV2Workflow"));
  const catchBody = body.slice(body.indexOf("} catch (error) {"));
  assert.match(catchBody, /await failV2AnalysisStep\(\{ \.\.\.input, error: workflowErrorMessage\(error\) \}\);\s*throw error;/);
  assert.doesNotMatch(workflow, /error instanceof Error/);
  assert.equal(catchBody.match(/failV2AnalysisStep\(/g)?.length, 1);
  // Retry configuration is still the SDK default: no maxRetries or retry-related overrides in v2 steps.
  for (const file of ["v2-workflow-steps", "v2-normalization-steps", "v2-topic-steps", "v2-conversation-event-steps", "v2-candidate-steps"]) {
    const source = await readFile(new URL(`../lib/meeting-analysis/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /maxRetries|RetryableError/, file);
  }
  // The helper is pure and workflow-safe: no imports, no I/O, no stack access.
  const helper = await readFile(new URL("../lib/meeting-analysis/error-message.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /^import /m);
  assert.doesNotMatch(helper, /\.stack|JSON\.stringify|String\(|\$\{/);
});
