import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commitTranscriptAndEnqueueAnalysis,
  defaultCommitTranscriptDeps,
  type CommitTranscriptDeps,
  type CommittableTranscriptSegment
} from "../lib/transcript-commit";
import { enqueueMeetingAnalysis } from "../lib/meeting-analysis/enqueue";
import type { EnqueueAnalysisResult } from "../lib/meeting-analysis/enqueue";

const MEETING = "00000000-0000-4000-8000-000000000001";

const segments: CommittableTranscriptSegment[] = [
  { speaker: "Craig", participant_name: null, text: "I'll finish it by Friday.", timestamp: null, raw_payload: { parfait_import: { segment_index: 0 } } },
  { speaker: "Aditya", participant_name: null, text: "Sounds good.", timestamp: null, raw_payload: { parfait_import: { segment_index: 1 } } }
];

function fakeDeps(options: {
  transitionWins?: boolean;
  enqueue?: EnqueueAnalysisResult;
  replaceThrows?: Error;
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: CommitTranscriptDeps = {
    replaceTranscriptSegments: async (meetingId, rows) => {
      calls.push(["replace", meetingId, rows]);
      if (options.replaceThrows) throw options.replaceThrows;
      return { insertedCount: rows.length };
    },
    applyGuardedMeetingStatus: async (meetingId, status) => {
      calls.push(["status", meetingId, status]);
      return options.transitionWins ?? true;
    },
    enqueueMeetingAnalysis: async (meetingId, enqueueOptions) => {
      calls.push(["enqueue", meetingId, enqueueOptions]);
      return options.enqueue ?? { ok: true, jobId: "job-1", generation: 4, status: "queued" };
    }
  };
  return { deps, calls };
}

test("replace -> guarded transcript_ready -> enqueue once, in that order", async () => {
  const { deps, calls } = fakeDeps();
  const result = await commitTranscriptAndEnqueueAnalysis(
    { meetingId: MEETING, segments, requestOrigin: "https://example.test" },
    deps
  );
  assert.deepEqual(result, { status: "analysis_queued", insertedCount: 2, jobId: "job-1", generation: 4 });
  assert.deepEqual(calls.map(([name]) => name), ["replace", "status", "enqueue"]);
  assert.deepEqual(calls[1], ["status", MEETING, "transcript_ready"]);
  assert.deepEqual(calls[2], ["enqueue", MEETING, { requestOrigin: "https://example.test" }]);
});

test("rows are persisted exactly as given: a null timestamp stays null, nothing is invented", async () => {
  const { deps, calls } = fakeDeps();
  await commitTranscriptAndEnqueueAnalysis({ meetingId: MEETING, segments }, deps);
  assert.strictEqual(calls[0][2], segments);
  assert.deepEqual((calls[0][2] as CommittableTranscriptSegment[]).map((row) => row.timestamp), [null, null]);
});

test("a caller that loses the transcript_ready transition never queues analysis", async () => {
  const { deps, calls } = fakeDeps({ transitionWins: false });
  const result = await commitTranscriptAndEnqueueAnalysis({ meetingId: MEETING, segments }, deps);
  assert.deepEqual(result, { status: "transition_lost", insertedCount: 2 });
  assert.deepEqual(calls.map(([name]) => name), ["replace", "status"]);
});

test("an enqueue failure is reported, not thrown, after the transcript is committed", async () => {
  const { deps } = fakeDeps({ enqueue: { ok: false, error: "Failed to claim an analysis job.", details: "rpc down" } });
  const result = await commitTranscriptAndEnqueueAnalysis({ meetingId: MEETING, segments }, deps);
  assert.deepEqual(result, {
    status: "analysis_enqueue_failed",
    insertedCount: 2,
    error: "Failed to claim an analysis job.",
    details: "rpc down"
  });
});

test("a failed replacement throws before any transition or enqueue", async () => {
  const { deps, calls } = fakeDeps({ replaceThrows: new Error("meeting_not_found") });
  await assert.rejects(commitTranscriptAndEnqueueAnalysis({ meetingId: MEETING, segments }, deps), /meeting_not_found/);
  assert.deepEqual(calls.map(([name]) => name), ["replace"]);
});

test("an empty transcript is refused before touching anything", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(
    commitTranscriptAndEnqueueAnalysis({ meetingId: MEETING, segments: [] }, deps),
    /at least one transcript segment/
  );
  assert.equal(calls.length, 0);
});

test("the default path uses the normal enqueueMeetingAnalysis entry point -- never pipeline v2 or /analyze-v2", async () => {
  assert.equal(typeof defaultCommitTranscriptDeps.enqueueMeetingAnalysis, "function");
  const source = await readFile(new URL("../lib/transcript-commit.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ enqueueMeetingAnalysis, type EnqueueAnalysisResult \} from "@\/lib\/meeting-analysis\/enqueue";/);
  assert.match(source, /enqueueMeetingAnalysis: \(meetingId, options\) => enqueueMeetingAnalysis\(meetingId, options\)/);
  assert.doesNotMatch(source, /enqueue-v2|enqueueMeetingAnalysisV2|analyze-v2|claimMeetingAnalysisJobV2/);
  // Analysis queue selection itself is untouched: enqueueMeetingAnalysis still claims v1.
  const enqueueSource = await readFile(new URL("../lib/meeting-analysis/enqueue.ts", import.meta.url), "utf8");
  assert.match(enqueueSource, /const claimJob = options\?\.claimJob \?\? claimMeetingAnalysisJob;/);
  assert.match(enqueueSource, /await start\(meetingAnalysisWorkflow, \[\{ meetingId, jobId, generation \}\]\);/);
  assert.equal(typeof enqueueMeetingAnalysis, "function");
});
