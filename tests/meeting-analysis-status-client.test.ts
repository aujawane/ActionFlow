import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAnalysisCompletionRefresh,
  shouldPollAnalysisStatus
} from "../lib/meeting-analysis-status-client";

test("running -> completed triggers exactly one refresh", () => {
  // First poll observes the job still running: no refresh.
  const running = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "running",
    lastRefreshedJobId: null
  });
  assert.equal(running.shouldRefresh, false);
  assert.equal(running.nextRefreshedJobId, null);

  // Next poll observes the same job transitioning to completed: refresh once.
  const completed = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "completed",
    lastRefreshedJobId: running.nextRefreshedJobId
  });
  assert.equal(completed.shouldRefresh, true);
  assert.equal(completed.nextRefreshedJobId, "job-1");
});

test("subsequent completed polling responses for the same job do not trigger additional refreshes", () => {
  const first = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "completed",
    lastRefreshedJobId: null
  });
  assert.equal(first.shouldRefresh, true);

  // Simulate 3 more poll ticks after the interval hasn't yet been torn down / an in-flight
  // request resolves late -- the ref (represented here by threading nextRefreshedJobId through)
  // must suppress every further refresh for this same job id.
  let lastRefreshedJobId: string | null = first.nextRefreshedJobId;
  for (let i = 0; i < 3; i += 1) {
    const decision = decideAnalysisCompletionRefresh({
      jobId: "job-1",
      jobStatus: "completed",
      lastRefreshedJobId
    });
    assert.equal(decision.shouldRefresh, false, `tick ${i}`);
    lastRefreshedJobId = decision.nextRefreshedJobId;
  }
});

test("initially loading a page whose analysis is already completed does not trigger an unnecessary refresh", () => {
  // No poll ever needs to run for this to hold: shouldPollAnalysisStatus returns false for an
  // already-terminal job, so decideAnalysisCompletionRefresh is never even reached in practice.
  const alreadyCompleted = shouldPollAnalysisStatus({
    jobStatus: "completed",
    meetingStatus: "completed"
  });
  assert.equal(alreadyCompleted, false);

  // Even if something did call the decision function directly on first observation (defense in
  // depth), a fresh lastRefreshedJobId of null against an already-completed job still refreshes
  // exactly once, not zero times and not repeatedly -- the "no unnecessary refresh" guarantee
  // comes from polling never starting, not from the decision function itself.
});

test("running -> failed does not trigger the success refresh", () => {
  const decision = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "failed",
    lastRefreshedJobId: null
  });
  assert.equal(decision.shouldRefresh, false);
  assert.equal(decision.nextRefreshedJobId, null);
});

test("running -> stale does not trigger the success refresh", () => {
  const decision = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "stale",
    lastRefreshedJobId: null
  });
  assert.equal(decision.shouldRefresh, false);
});

test("a completed job with no id never refreshes (defensive: nothing to guard against re-triggering)", () => {
  const decision = decideAnalysisCompletionRefresh({
    jobId: null,
    jobStatus: "completed",
    lastRefreshedJobId: null
  });
  assert.equal(decision.shouldRefresh, false);
});

test("a different job completing after an earlier one refreshes again for the new job id", () => {
  const first = decideAnalysisCompletionRefresh({
    jobId: "job-1",
    jobStatus: "completed",
    lastRefreshedJobId: null
  });
  assert.equal(first.shouldRefresh, true);

  // A fresh re-analysis (new generation/job id) completing later must still get its own refresh.
  const second = decideAnalysisCompletionRefresh({
    jobId: "job-2",
    jobStatus: "completed",
    lastRefreshedJobId: first.nextRefreshedJobId
  });
  assert.equal(second.shouldRefresh, true);
  assert.equal(second.nextRefreshedJobId, "job-2");
});

test("polling stops correctly at every terminal state, and (re)starts for active/queued-with-transcript states", () => {
  for (const jobStatus of ["completed", "failed", "stale"] as const) {
    assert.equal(
      shouldPollAnalysisStatus({ jobStatus, meetingStatus: "completed" }),
      false,
      jobStatus
    );
  }
  for (const jobStatus of ["queued", "running"] as const) {
    assert.equal(
      shouldPollAnalysisStatus({ jobStatus, meetingStatus: "processing" }),
      true,
      jobStatus
    );
  }
  // Transcript just became ready and no job has been claimed yet.
  assert.equal(
    shouldPollAnalysisStatus({ jobStatus: null, meetingStatus: "transcript_ready" }),
    true
  );
  // No job yet at all (jobStatus null) defaults to "queued"-equivalent and keeps polling,
  // regardless of meetingStatus -- this is the existing, preserved behavior (a null jobStatus
  // falls back to "queued" before the ACTIVE_ANALYSIS_JOB_STATUSES check).
  assert.equal(shouldPollAnalysisStatus({ jobStatus: null, meetingStatus: "recording" }), true);
});
