import assert from "node:assert/strict";
import test from "node:test";

import {
  processCompletedRecallMeeting,
  type RecallMeetingProcessingDeps
} from "../lib/recall/processing";
import { parseRecallTranscriptToSegments, type ParsedTranscriptSegment } from "../lib/recall/transcript";
import type { CommitTranscriptResult } from "../lib/transcript-commit";
import { normalizeTranscriptSpeaker } from "../lib/transcript-speaker";

// Behavioral regression tests for processCompletedRecallMeeting after its source-independent tail
// moved into commitTranscriptAndEnqueueAnalysis: every externally observable result (status,
// counts, analysisStatus, message, jobId, generation) and every side-effect ordering is pinned.

const MEETING = "00000000-0000-4000-8000-0000000000aa";
const BOT = "bot-123";

const recallPayload = [
  {
    participant: { id: 100, name: "Craig" },
    words: [{ text: "I'll", start_timestamp: { relative: 1.5, absolute: "2026-08-19T16:02:13.250Z" } }],
    text: "I'll finish the landing page by Friday."
  },
  {
    participant: { id: 101, name: "Aditya" },
    words: [{ text: "Sounds", start_timestamp: { relative: 6.2, absolute: "2026-08-19T16:02:18.000Z" } }],
    text: "Sounds good."
  }
];
const parsedRows: ParsedTranscriptSegment[] = parseRecallTranscriptToSegments(recallPayload).map(normalizeTranscriptSpeaker);

function harness(options: {
  claim?: Awaited<ReturnType<RecallMeetingProcessingDeps["claimTranscriptImport"]>>;
  rows?: ParsedTranscriptSegment[];
  fetchThrows?: Error;
  commit?: CommitTranscriptResult;
  releaseThrows?: Error;
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: RecallMeetingProcessingDeps = {
    claimTranscriptImport: async (meetingId) => {
      calls.push(["claim", meetingId]);
      return options.claim ?? { claimed: true };
    },
    releaseTranscriptImportClaim: async (meetingId) => {
      calls.push(["release", meetingId]);
      if (options.releaseThrows) throw options.releaseThrows;
    },
    applyGuardedMeetingStatus: async (meetingId, status) => {
      calls.push(["status", meetingId, status]);
      return true;
    },
    fetchRecallTranscriptRows: async (botId) => {
      calls.push(["fetch", botId]);
      if (options.fetchThrows) throw options.fetchThrows;
      return options.rows ?? parsedRows;
    },
    commitTranscriptAndEnqueueAnalysis: async (input) => {
      calls.push(["commit", input]);
      return options.commit ?? { status: "analysis_queued", insertedCount: input.segments.length, jobId: "job-9", generation: 3 };
    }
  };
  return { deps, calls };
}

test("Recall parsing is unchanged: participant names, real Recall timestamps, raw payload kept", () => {
  assert.deepEqual(
    parsedRows.map((row) => [row.speaker, row.participant_name, row.text, row.timestamp]),
    [
      ["Craig", "Craig", "I'll finish the landing page by Friday.", "2026-08-19T16:02:13.250Z"],
      ["Aditya", "Aditya", "Sounds good.", "2026-08-19T16:02:18.000Z"]
    ]
  );
  assert.deepEqual(parsedRows[0].raw_payload, recallPayload[0]);
});

test("winning claim: claim -> processing -> fetch -> shared commit (with the parsed rows), then the same queued result as before", async () => {
  const { deps, calls } = harness();
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT, requestOrigin: "https://o.test" }, deps);
  assert.deepEqual(calls.map(([name]) => name), ["claim", "status", "fetch", "commit"]);
  assert.deepEqual(calls[1], ["status", MEETING, "processing"]);
  assert.deepEqual(calls[3][1], { meetingId: MEETING, segments: parsedRows, requestOrigin: "https://o.test" });
  assert.deepEqual(result, {
    status: "transcript_ready",
    insertedCount: 2,
    parsedCount: 2,
    analysisStatus: "queued",
    jobId: "job-9",
    generation: 3,
    message: "Transcript imported. Analysis queued in the background."
  });
});

test("losing the claim (already done) does nothing else", async () => {
  const { deps, calls } = harness({ claim: { claimed: false, reason: "already_done" } });
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps);
  assert.deepEqual(calls.map(([name]) => name), ["claim"]);
  assert.deepEqual(result, {
    status: "already_processed",
    insertedCount: 0,
    parsedCount: 0,
    analysisStatus: "not_started",
    message: "Transcript already imported for this meeting; skipping duplicate completion event."
  });
});

test("losing the claim (in progress) does nothing else", async () => {
  const { deps, calls } = harness({ claim: { claimed: false, reason: "already_in_progress" } });
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps);
  assert.deepEqual(calls.map(([name]) => name), ["claim"]);
  assert.equal(result.status, "already_processing");
  assert.equal(
    result.message,
    "Transcript import for this meeting is already in progress; skipping duplicate completion event."
  );
});

test("no downloadable transcript yet: stays processing, releases the claim, commits nothing", async () => {
  const { deps, calls } = harness({ rows: [] });
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps);
  assert.deepEqual(calls.map(([name]) => name), ["claim", "status", "fetch", "status", "release"]);
  assert.deepEqual(calls[3], ["status", MEETING, "processing"]);
  assert.deepEqual(result, {
    status: "processing",
    insertedCount: 0,
    parsedCount: 0,
    analysisStatus: "not_started",
    message: "Meeting ended; the transcript artifact is not downloadable yet."
  });
});

test("transcript committed but transcript_ready transition lost: same not_started result as before", async () => {
  const { deps } = harness({ commit: { status: "transition_lost", insertedCount: 2 } });
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps);
  assert.deepEqual(result, {
    status: "transcript_ready",
    insertedCount: 2,
    parsedCount: 2,
    analysisStatus: "not_started",
    message: "Transcript imported, but this meeting had already moved past processing."
  });
});

test("enqueue failure: same enqueue_failed result as before", async () => {
  const { deps } = harness({ commit: { status: "analysis_enqueue_failed", insertedCount: 2, error: "x", details: "y" } });
  const result = await processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps);
  assert.deepEqual(result, {
    status: "transcript_ready",
    insertedCount: 2,
    parsedCount: 2,
    analysisStatus: "enqueue_failed",
    message: "Transcript imported successfully. Analysis could not be queued; retry Analyze Meeting."
  });
});

test("a thrown fetch error releases the claim, rethrows, and commits nothing", async () => {
  const { deps, calls } = harness({ fetchThrows: new Error("recall 503") });
  await assert.rejects(processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps), /recall 503/);
  assert.deepEqual(calls.map(([name]) => name), ["claim", "status", "fetch", "release"]);
});

test("a release failure inside the catch never masks the original error", async () => {
  const { deps } = harness({ fetchThrows: new Error("recall 503"), releaseThrows: new Error("supabase down") });
  await assert.rejects(processCompletedRecallMeeting({ meetingId: MEETING, recallBotId: BOT }, deps), /recall 503/);
});
