import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANALYSIS_STAGE_ORDER,
  isStaleRunningJob,
  STALE_RUNNING_JOB_THRESHOLD_MS
} from "../lib/meeting-analysis/jobs";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("a running job is not stale before the threshold elapses", () => {
  const now = Date.now();
  const justUpdated = new Date(now - 1000).toISOString();
  assert.equal(isStaleRunningJob({ status: "running", updated_at: justUpdated }, now), false);

  const almostThreshold = new Date(now - (STALE_RUNNING_JOB_THRESHOLD_MS - 1000)).toISOString();
  assert.equal(isStaleRunningJob({ status: "running", updated_at: almostThreshold }, now), false);
});

test("a running job becomes stale once updated_at has not moved for the threshold", () => {
  const now = Date.now();
  const abandoned = new Date(now - STALE_RUNNING_JOB_THRESHOLD_MS - 1).toISOString();
  assert.equal(isStaleRunningJob({ status: "running", updated_at: abandoned }, now), true);
});

test("only status=running is ever considered for staleness -- terminal statuses are left alone", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_RUNNING_JOB_THRESHOLD_MS - 1).toISOString();
  for (const status of ["queued", "completed", "failed", "stale"] as const) {
    assert.equal(isStaleRunningJob({ status, updated_at: longAgo }, now), false, status);
  }
});

test("the old recursive-dispatch worker route no longer exists (not part of normal analysis progression)", async () => {
  await assert.rejects(
    () => access(new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url)),
    /ENOENT/
  );
});

test("no orchestration file makes an HTTP request back to our own app between stages", async () => {
  const files = [
    "lib/meeting-analysis/workflow.ts",
    "lib/meeting-analysis/workflow-steps.ts",
    "lib/meeting-analysis/enqueue.ts"
  ];
  for (const file of files) {
    const source = await readSource(file);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} should not make an HTTP fetch call`);
    assert.doesNotMatch(source, /x-parfait-internal-secret/, `${file} should not need the internal dispatch secret`);
  }
});

test("enqueue starts a durable Workflow SDK run instead of dispatching HTTP", async () => {
  const source = await readSource("lib/meeting-analysis/enqueue.ts");
  assert.match(source, /import \{ start \} from "workflow\/api";/);
  assert.match(source, /import \{ meetingAnalysisWorkflow \} from "@\/lib\/meeting-analysis\/workflow";/);
  assert.match(source, /await start\(meetingAnalysisWorkflow, \[\{ meetingId, jobId, generation \}\]\);/);
  // Kickoff is still deferred via after() so the HTTP caller gets an immediate 202-shaped response.
  assert.match(source, /after\(\(\) => kickoff\(\)\);/);
});

test("the workflow orchestrator preserves the exact existing stage sequence", async () => {
  const source = await readSource("lib/meeting-analysis/workflow.ts");
  assert.match(source, /"use workflow";/);
  assert.match(source, /for \(const stage of ANALYSIS_STAGE_ORDER\) \{/);
  assert.match(source, /await runAnalysisStageStep\(\{ \.\.\.input, stage \}\);/);

  assert.deepEqual(ANALYSIS_STAGE_ORDER, [
    "topic_extraction",
    "conversation_events",
    "candidates",
    "global_correction",
    "verification",
    "completeness",
    "final_verification",
    "task_consolidation",
    "synthesis",
    "persistence"
  ]);
});

test("a stage failure marks the job terminal failed, with the correct stage/progress/error, and never retries at the workflow layer", async () => {
  const source = await readSource("lib/meeting-analysis/workflow-steps.ts");
  assert.match(source, /"use step";/);

  const catchBlockStart = source.indexOf("} catch (error) {");
  assert.ok(catchBlockStart >= 0, "expected a catch block in the step function");
  const catchBlock = source.slice(catchBlockStart);

  assert.match(
    catchBlock,
    /await markAnalysisJobTerminal\(\{\s*jobId: input\.jobId,\s*status: "failed",\s*stage: input\.stage,\s*progress: ANALYSIS_STAGES\[input\.stage\]\.progress,\s*error: message\s*\}\)/
  );

  // A non-stale failure throws FatalError (not a plain Error) so the Workflow SDK's own
  // automatic step-retry (default 3 attempts) never kicks in on a stage we've already exhausted
  // our own attempts for and already marked terminal.
  const terminalCallIndex = catchBlock.indexOf("await markAnalysisJobTerminal({");
  const afterTerminalCall = catchBlock.slice(catchBlock.indexOf("}", terminalCallIndex));
  assert.match(afterTerminalCall, /throw new FatalError\(message\);/);
});

test("a stale error is never persisted as failed and also throws FatalError so it is never retried", async () => {
  const source = await readSource("lib/meeting-analysis/workflow-steps.ts");
  const staleBranchMatch = source.match(
    /if \(error instanceof StaleAnalysisError[\s\S]*?throw new FatalError\(\(error as Error\)\.message\);\s*}/
  );
  assert.ok(staleBranchMatch, "expected an early stale branch that throws FatalError");
  assert.doesNotMatch(staleBranchMatch![0], /markAnalysisJobTerminal/);
});

test("a secondary failure while persisting terminal state does not hide the original error", async () => {
  const source = await readSource("lib/meeting-analysis/workflow-steps.ts");
  const catchBlockStart = source.indexOf("} catch (error) {");
  const catchBlock = source.slice(catchBlockStart);

  assert.match(catchBlock, /try \{\s*await markAnalysisJobTerminal/);
  assert.match(catchBlock, /catch \(persistError\) \{/);
  assert.match(
    catchBlock,
    /console\.error\("\[meeting-analysis-workflow\] failed to persist terminal failure state"/
  );

  const persistCatchEnd = catchBlock.indexOf("}", catchBlock.indexOf("catch (persistError) {"));
  const afterPersistCatch = catchBlock.slice(persistCatchEnd);
  assert.match(afterPersistCatch, /throw new FatalError\(message\);/);
});

test("stage logs include job_id, meeting_id, generation, stage, and elapsed_ms without leaking secrets", async () => {
  const source = await readSource("lib/meeting-analysis/workflow-steps.ts");
  assert.match(source, /job_id: input\.jobId,\s*meeting_id: input\.meetingId,\s*generation: input\.generation,\s*stage: input\.stage/);
  assert.match(source, /console\.info\("\[meeting-analysis-workflow\] stage start", logContext\)/);
  assert.match(source, /console\.info\("\[meeting-analysis-workflow\] stage success"/);
  assert.match(source, /console\.error\("\[meeting-analysis-workflow\] stage failure"/);
  assert.match(source, /elapsed_ms: Date\.now\(\) - stageStartedAt/);

  const consoleCalls = source.match(/console\.(info|error|warn)\([\s\S]*?\}\);/g) ?? [];
  assert.ok(consoleCalls.length >= 4, "expected at least 4 console.* log call sites");
  for (const call of consoleCalls) {
    assert.doesNotMatch(call, /secret/i, `log call leaks a secret: ${call}`);
    assert.doesNotMatch(call, /transcript/i, `log call leaks transcript content: ${call}`);
  }
});

test("workflow/job start and job completion are logged", async () => {
  const source = await readSource("lib/meeting-analysis/workflow.ts");
  assert.match(source, /console\.info\("\[meeting-analysis-workflow\] job start"/);
  assert.match(source, /console\.info\("\[meeting-analysis-workflow\] job complete"/);
});

test("the step reuses runMeetingAnalysisStage rather than duplicating stage business logic", async () => {
  const source = await readSource("lib/meeting-analysis/workflow-steps.ts");
  assert.match(source, /import \{ runMeetingAnalysisStage \} from "@\/lib\/meeting-analysis\/worker";/);
  assert.match(source, /const result = await runMeetingAnalysisStage\(input\);/);
});

test("generation/stale-job protection is untouched -- assertAnalysisJobStillCurrent still runs inside the reused stage logic", async () => {
  const source = await readSource("lib/meeting-analysis/worker.ts");
  assert.match(source, /await assertAnalysisJobStillCurrent\(input\);/);
});

test("next.config.ts and middleware are wired for Workflow SDK", async () => {
  const configSource = await readSource("next.config.ts");
  assert.match(configSource, /import \{ withWorkflow \} from "workflow\/next";/);
  assert.match(configSource, /export default withWorkflow\(nextConfig\);/);

  const middlewareSource = await readSource("middleware.ts");
  // Trailing slash matters: it scopes the exclusion to the real .well-known/workflow/* subpaths
  // only, not any lookalike path that merely starts with "workflow" (e.g. .well-known/workflowXYZ).
  assert.match(middlewareSource, /\\\\\.well-known\/workflow\/\)/);
});
