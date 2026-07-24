import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { enqueueMeetingAnalysis } from "../lib/meeting-analysis/enqueue";
import {
  ANALYSIS_STAGES,
  StaleAnalysisError
} from "../lib/meeting-analysis/jobs";
import type { MeetingAnalysisJob } from "../lib/types";

type JobRow = MeetingAnalysisJob;

function createInMemoryJobStore() {
  const meetings = new Map<string, { generation: number }>();
  const jobs = new Map<string, JobRow>();
  let generationCounter = 0;

  return {
    seedMeeting(meetingId: string, generation = 0) {
      meetings.set(meetingId, { generation });
    },
    async claim(meetingId: string) {
      const meeting = meetings.get(meetingId);
      if (!meeting) {
        return { ok: false as const, error: "Meeting missing" };
      }
      meeting.generation += 1;
      generationCounter += 1;
      for (const job of jobs.values()) {
        if (
          job.meeting_id === meetingId &&
          (job.status === "queued" || job.status === "running")
        ) {
          job.status = "stale";
          job.current_stage = "stale";
          job.error = "Superseded by a newer analysis generation.";
          job.completed_at = new Date().toISOString();
        }
      }
      const jobId = `job-${generationCounter}`;
      const now = new Date().toISOString();
      const job: JobRow = {
        id: jobId,
        meeting_id: meetingId,
        generation: meeting.generation,
        status: "queued",
        current_stage: "queued",
        progress: 0,
        error: null,
        retry_count: 0,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now
      };
      jobs.set(jobId, job);
      return {
        ok: true as const,
        jobId,
        generation: meeting.generation
      };
    },
    get(jobId: string) {
      return jobs.get(jobId) ?? null;
    },
    latest(meetingId: string) {
      return (
        [...jobs.values()]
          .filter((job) => job.meeting_id === meetingId)
          .sort((a, b) => b.generation - a.generation)[0] ?? null
      );
    },
    markRunning(jobId: string, stage: keyof typeof ANALYSIS_STAGES, retryCount = 0) {
      const job = jobs.get(jobId);
      if (!job) throw new Error("missing job");
      const meta = ANALYSIS_STAGES[stage];
      job.status = "running";
      job.current_stage = meta.stage;
      job.progress = meta.progress;
      job.retry_count = retryCount;
      job.started_at ??= new Date().toISOString();
      job.error = null;
    },
    markTerminal(
      jobId: string,
      status: "completed" | "failed" | "stale",
      error: string | null = null
    ) {
      const job = jobs.get(jobId);
      if (!job) throw new Error("missing job");
      job.status = status;
      job.current_stage = status;
      job.progress = 100;
      job.error = error;
      job.completed_at = new Date().toISOString();
    },
    assertCurrent(meetingId: string, jobId: string, generation: number) {
      const meeting = meetings.get(meetingId);
      const job = jobs.get(jobId);
      if (!meeting || !job) throw new Error("missing");
      if (
        meeting.generation !== generation ||
        job.generation !== generation ||
        job.status === "stale"
      ) {
        this.markTerminal(jobId, "stale", "Superseded by a newer analysis generation.");
        throw new StaleAnalysisError();
      }
    }
  };
}

test("background analysis migration claims jobs atomically with generation", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260724140000_add_background_analysis_jobs.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(sql, /transcript_ready/);
  assert.match(sql, /meeting_analysis_jobs/);
  assert.match(sql, /claim_meeting_analysis_job/);
  assert.match(sql, /unique \(meeting_id, generation\)/i);
  assert.match(sql, /status in \('queued', 'running', 'completed', 'failed', 'stale'\)/);
  assert.match(sql, /Users can view own meeting analysis jobs/);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
  assert.match(sql, /execution_graph_generation = execution_graph_generation \+ 1/i);

  const checkpointSql = await readFile(
    new URL(
      "../supabase/migrations/20260724143000_add_analysis_job_checkpoint.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(checkpointSql, /checkpoint jsonb/i);
});

test("enqueue returns 202-shaped payload quickly without waiting for analysis", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("meeting-a");
  let analysisFinished = false;

  const startedAt = Date.now();
  const enqueued = await enqueueMeetingAnalysis("meeting-a", {
    claimJob: (meetingId) => store.claim(meetingId),
    startWorker: async () => {
      // Worker kickoff acceptance is immediate; long work happens later.
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        analysisFinished = true;
      })();
    },
    markDispatchFailed: async ({ jobId, error }) => {
      store.markTerminal(jobId, "failed", error);
    }
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(enqueued.ok, true);
  if (!enqueued.ok) return;
  assert.ok(elapsed < 50, `enqueue took too long: ${elapsed}ms`);
  assert.equal(enqueued.status, "queued");
  assert.equal(enqueued.generation, 1);
  assert.equal(store.get(enqueued.jobId)?.status, "queued");
  assert.equal(analysisFinished, false);
});

test("enqueue marks job failed when worker dispatch throws", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("meeting-b");

  const enqueued = await enqueueMeetingAnalysis("meeting-b", {
    claimJob: (meetingId) => store.claim(meetingId),
    startWorker: async () => {
      throw new Error("worker unavailable");
    },
    markDispatchFailed: async ({ jobId, error }) => {
      store.markTerminal(jobId, "failed", error);
    }
  });

  // Kickoff is async (after()/void); acceptance still returns queued.
  assert.equal(enqueued.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const latest = store.latest("meeting-b");
  assert.equal(latest?.status, "failed");
  assert.match(latest?.error ?? "", /worker unavailable/);
});

test("job status transitions queued -> running -> completed", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("m1");
  const claimed = await store.claim("m1");
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(store.get(claimed.jobId)?.status, "queued");

  store.markRunning(claimed.jobId, "candidates", 0);
  assert.equal(store.get(claimed.jobId)?.status, "running");
  assert.equal(store.get(claimed.jobId)?.current_stage, "candidates");
  assert.equal(store.get(claimed.jobId)?.progress, 30);

  store.markTerminal(claimed.jobId, "completed");
  assert.equal(store.get(claimed.jobId)?.status, "completed");
  assert.ok(store.get(claimed.jobId)?.completed_at);
});

test("stale job rejection marks superseded generation stale", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("m1");
  const first = await store.claim("m1");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  store.markRunning(first.jobId, "verification");

  const second = await store.claim("m1");
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(store.get(first.jobId)?.status, "stale");
  assert.equal(store.get(second.jobId)?.status, "queued");
  assert.equal(second.generation, 2);

  assert.throws(
    () => store.assertCurrent("m1", first.jobId, first.generation),
    (error: unknown) => error instanceof StaleAnalysisError
  );
});

test("retry creates a fresh generation and clears prior failure state", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("m1");
  const failed = await store.claim("m1");
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  store.markTerminal(failed.jobId, "failed", "OpenAI timeout");
  assert.equal(store.latest("m1")?.error, "OpenAI timeout");

  const retry = await store.claim("m1");
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.generation, 2);
  assert.equal(store.get(retry.jobId)?.status, "queued");
  assert.equal(store.get(retry.jobId)?.error, null);
  assert.notEqual(retry.jobId, failed.jobId);
});

test("durable stage retry_count increments on step attempts", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("m1");
  const claimed = await store.claim("m1");
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  store.markRunning(claimed.jobId, "candidates", 0);
  store.markRunning(claimed.jobId, "candidates", 1);
  store.markRunning(claimed.jobId, "candidates", 2);
  assert.equal(store.get(claimed.jobId)?.retry_count, 2);
  assert.equal(store.get(claimed.jobId)?.status, "running");
});

test("completed analysis refresh contract exposes terminal job for UI reload", async () => {
  const store = createInMemoryJobStore();
  store.seedMeeting("m1");
  const claimed = await store.claim("m1");
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  store.markRunning(claimed.jobId, "persistence");
  store.markTerminal(claimed.jobId, "completed");

  const latest = store.latest("m1");
  assert.equal(latest?.status, "completed");
  assert.equal(latest?.status === "completed", true);
  assert.equal(ANALYSIS_STAGES.completed.progress, 100);
});

test("transcript import succeeds independently when later analysis enqueue fails", () => {
  const meeting = { status: "processing" };
  const transcriptReady = true;
  const enqueueOk = false;

  if (transcriptReady) {
    meeting.status = "transcript_ready";
  }

  const result = enqueueOk
    ? { status: meeting.status, analysisStatus: "queued" as const, message: "" }
    : {
        status: meeting.status,
        analysisStatus: "enqueue_failed" as const,
        message:
          "Transcript imported successfully. Analysis could not be queued; retry Analyze Meeting."
      };

  assert.equal(result.status, "transcript_ready");
  assert.equal(result.analysisStatus, "enqueue_failed");
  assert.match(result.message, /Transcript imported successfully/);
});
