import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isStaleRunningJob, STALE_RUNNING_JOB_THRESHOLD_MS } from "../lib/meeting-analysis/jobs";

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

test("a genuinely active job is never marked stale just because it's been running a while ago in absolute terms -- only staleness relative to now matters", () => {
  // Regression for "do not mark a legitimately active job failed too aggressively": a job whose
  // updated_at was bumped one second ago (e.g. a fresh markAnalysisJobRunning/checkpoint write)
  // is never stale, no matter how long the overall analysis has been running.
  const now = Date.now();
  const recentlyBumped = new Date(now - 1000).toISOString();
  assert.equal(isStaleRunningJob({ status: "running", updated_at: recentlyBumped }, now), false);
});

test("only status=running is ever considered for staleness -- terminal statuses are left alone", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_RUNNING_JOB_THRESHOLD_MS - 1).toISOString();
  for (const status of ["queued", "completed", "failed", "stale"] as const) {
    assert.equal(isStaleRunningJob({ status, updated_at: longAgo }, now), false, status);
  }
});

test("worker route: successful stage chaining is unchanged", async () => {
  const route = await readFile(
    new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /after\(\(\) =>\s*\n?\s*dispatchNextStage/);
  assert.match(
    route,
    /NextResponse\.json\(\{\s*ok: true,\s*stage,\s*nextStage: result\.nextStage,\s*done: result\.done\s*\}\)/
  );
});

test("worker route: a non-stale failure marks the job failed, with the correct stage/progress/error, before returning 500", async () => {
  const route = await readFile(
    new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url),
    "utf8"
  );

  const catchBlockStart = route.indexOf("} catch (error) {");
  assert.ok(catchBlockStart >= 0, "expected a catch block in the worker route");
  const catchBlock = route.slice(catchBlockStart);

  // The stale branch must return before the generic failure-persistence logic runs.
  const staleReturnIndex = catchBlock.indexOf('status: 409 }\n      );');
  const markTerminalIndex = catchBlock.indexOf("await markAnalysisJobTerminal({");
  assert.ok(staleReturnIndex >= 0 && markTerminalIndex >= 0);
  assert.ok(
    staleReturnIndex < markTerminalIndex,
    "stale branch must return before markAnalysisJobTerminal is reached"
  );

  assert.match(catchBlock, /await markAnalysisJobTerminal\(\{\s*jobId,\s*status: "failed",\s*stage,\s*progress: ANALYSIS_STAGES\[stage\]\.progress,\s*error: message\s*\}\)/);
  assert.match(catchBlock, /NextResponse\.json\(\{ ok: false, error: message \}, \{ status: 500 \}\)/);

  // markAnalysisJobTerminal must be called (and awaited) strictly before the 500 response is built.
  const terminalCallIndex = catchBlock.indexOf("await markAnalysisJobTerminal({");
  const responseIndex = catchBlock.indexOf('NextResponse.json({ ok: false, error: message }, { status: 500 });');
  assert.ok(terminalCallIndex < responseIndex);
});

test("worker route: a stale error is never persisted as failed", async () => {
  const route = await readFile(
    new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url),
    "utf8"
  );
  const staleBranchMatch = route.match(
    /if \(error instanceof StaleAnalysisError[\s\S]*?status: 409 }\s*\);\s*}/
  );
  assert.ok(staleBranchMatch, "expected an early-return stale branch");
  assert.doesNotMatch(staleBranchMatch![0], /markAnalysisJobTerminal/);
});

test("worker route: a secondary failure while persisting terminal state does not hide the original error", async () => {
  const route = await readFile(
    new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url),
    "utf8"
  );
  const catchBlockStart = route.indexOf("} catch (error) {");
  const catchBlock = route.slice(catchBlockStart);

  // markAnalysisJobTerminal is wrapped in its own try/catch...
  assert.match(catchBlock, /try \{\s*await markAnalysisJobTerminal/);
  assert.match(catchBlock, /catch \(persistError\) \{/);
  assert.match(catchBlock, /console\.error\("\[meeting-analysis-worker\] failed to persist terminal failure state"/);

  // ...and the final response is built from `message` (the original stage error), not from
  // anything derived inside the persistence catch, and unconditionally after that nested block.
  const persistCatchEnd = catchBlock.indexOf("}", catchBlock.indexOf("catch (persistError) {"));
  const afterPersistCatch = catchBlock.slice(persistCatchEnd);
  assert.match(afterPersistCatch, /return NextResponse\.json\(\{ ok: false, error: message \}, \{ status: 500 \}\);/);
});

test("worker route: logs job/meeting/generation/stage and elapsed_ms without leaking secrets", async () => {
  const route = await readFile(
    new URL("../app/api/internal/meeting-analysis/worker/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /console\.info\("\[meeting-analysis-worker\] stage start", logContext\)/);
  assert.match(route, /console\.info\("\[meeting-analysis-worker\] stage success"/);
  assert.match(route, /console\.error\("\[meeting-analysis-worker\] stage failure"/);
  assert.match(route, /elapsed_ms: Date\.now\(\) - stageStartedAt/);

  const consoleCalls = route.match(/console\.(info|error|warn)\([\s\S]*?\}\);/g) ?? [];
  assert.ok(consoleCalls.length >= 4, "expected at least 4 console.* log call sites");
  for (const call of consoleCalls) {
    assert.doesNotMatch(call, /secret/i, `log call leaks a secret: ${call}`);
    assert.doesNotMatch(call, /transcript/i, `log call leaks transcript content: ${call}`);
  }
});

test("getLatestMeetingAnalysisJob reconciles stale running jobs on read (self-heals without a cron)", async () => {
  const jobsSource = await readFile(
    new URL("../lib/meeting-analysis/jobs.ts", import.meta.url),
    "utf8"
  );
  assert.match(jobsSource, /return job \? reconcileStaleRunningJob\(job\) : null;/);
  assert.match(jobsSource, /if \(!isStaleRunningJob\(job\)\) return job;/);
  assert.match(jobsSource, /status: "failed",\s*stage: job\.current_stage,\s*progress: job\.progress/);
});
