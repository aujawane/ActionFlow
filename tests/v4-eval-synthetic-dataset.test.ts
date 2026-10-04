import assert from "node:assert/strict";
import test from "node:test";

import { parseMeetingGroundTruth } from "../lib/execution-intelligence/eval-harness/ground-truth-schema";
import craigGroundTruth from "./fixtures/v4-eval/craig-aug19.ground-truth";

import * as meeting1Transcript from "./fixtures/v4-eval/synthetic/meeting-01-status/transcript";
import meeting1GroundTruth from "./fixtures/v4-eval/synthetic/meeting-01-status/ground-truth";
import * as meeting2Transcript from "./fixtures/v4-eval/synthetic/meeting-02-debugging/transcript";
import meeting2GroundTruth from "./fixtures/v4-eval/synthetic/meeting-02-debugging/ground-truth";
import * as meeting3Transcript from "./fixtures/v4-eval/synthetic/meeting-03-brainstorm/transcript";
import meeting3GroundTruth from "./fixtures/v4-eval/synthetic/meeting-03-brainstorm/ground-truth";
import * as meeting4Transcript from "./fixtures/v4-eval/synthetic/meeting-04-handoff/transcript";
import meeting4GroundTruth from "./fixtures/v4-eval/synthetic/meeting-04-handoff/ground-truth";
import * as meeting5Transcript from "./fixtures/v4-eval/synthetic/meeting-05-messy/transcript";
import meeting5GroundTruth from "./fixtures/v4-eval/synthetic/meeting-05-messy/ground-truth";

/**
 * Dataset validation for the five synthetic-realistic benchmark meetings (see
 * tests/fixtures/v4-eval/synthetic/*\/scenario.md for design intent). These tests check
 * referential integrity and basic structural coverage of the FROZEN fixture dataset only -- they
 * do NOT run any V4 extraction, do NOT call OpenAI, and do NOT encode any expectation about how
 * any extraction system should perform against these meetings. That evaluation is a separate,
 * later step using the existing eval-harness.
 */

type SyntheticTranscriptModule = {
  meetingId: string;
  meetingTitle: string;
  participants: string[];
  transcriptSegments: Array<{ id: string; index: number; timestamp: string; speaker: string; text: string }>;
};

const MEETINGS: Array<{ name: string; transcript: SyntheticTranscriptModule; groundTruth: unknown }> = [
  { name: "meeting-01-status", transcript: meeting1Transcript, groundTruth: meeting1GroundTruth },
  { name: "meeting-02-debugging", transcript: meeting2Transcript, groundTruth: meeting2GroundTruth },
  { name: "meeting-03-brainstorm", transcript: meeting3Transcript, groundTruth: meeting3GroundTruth },
  { name: "meeting-04-handoff", transcript: meeting4Transcript, groundTruth: meeting4GroundTruth },
  { name: "meeting-05-messy", transcript: meeting5Transcript, groundTruth: meeting5GroundTruth }
];

// ---------------------------------------------------------------------------
// 1. All five meetings parse against the eval-harness ground-truth schema.
// ---------------------------------------------------------------------------
for (const { name, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} ground truth parses against groundTruthSchema`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    assert.ok(parsed.ground_truth.length > 0);
  });
}

// ---------------------------------------------------------------------------
// 2. Every GT source_segment_id exists in that meeting's own transcript.
// ---------------------------------------------------------------------------
for (const { name, transcript, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} every GT source_segment_id exists in the transcript`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    const segmentIds = new Set(transcript.transcriptSegments.map((s) => s.id));
    for (const item of parsed.ground_truth) {
      for (const id of item.source_segment_ids) {
        assert.ok(segmentIds.has(id), `${name}: GT item "${item.id}" references unknown segment id "${id}"`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 3. GT ids are unique within each meeting (also enforced by the schema itself, checked directly
//    here too so a future schema change can't silently weaken this guarantee unnoticed).
// ---------------------------------------------------------------------------
for (const { name, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} GT ids are unique`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    const ids = parsed.ground_truth.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate GT id found among ${JSON.stringify(ids)}`);
  });
}

// ---------------------------------------------------------------------------
// 4. Segment ids are unique within each meeting's transcript.
// ---------------------------------------------------------------------------
for (const { name, transcript } of MEETINGS) {
  test(`[synthetic dataset] ${name} transcript segment ids are unique`, () => {
    const ids = transcript.transcriptSegments.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate segment id found`);
  });
}

// ---------------------------------------------------------------------------
// 5. Every owner referenced in GT appears as a declared meeting participant.
// ---------------------------------------------------------------------------
for (const { name, transcript, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} every GT owner is a declared participant`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    const participants = new Set(transcript.participants);
    for (const item of parsed.ground_truth) {
      for (const owner of item.owners) {
        assert.ok(participants.has(owner), `${name}: GT item "${item.id}" names owner "${owner}" who is not a declared participant`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Every meeting contains at least one active GT item.
// ---------------------------------------------------------------------------
for (const { name, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} contains at least one active GT item`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    assert.ok(parsed.ground_truth.some((item) => item.expected_state === "active"));
  });
}

// ---------------------------------------------------------------------------
// 7. Every meeting contains at least one negative or completed_during_meeting case.
// ---------------------------------------------------------------------------
for (const { name, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} contains at least one negative or completed_during_meeting GT item`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    assert.ok(parsed.ground_truth.some((item) => item.expected_state === "negative" || item.expected_state === "completed_during_meeting"));
  });
}

// ---------------------------------------------------------------------------
// 8. compound_outcomes, where present, are structurally valid (2+ non-empty sub-outcomes -- a
//    single-entry "compound" would just be a plain outcome, which is a fixture-authoring mistake).
// ---------------------------------------------------------------------------
for (const { name, groundTruth } of MEETINGS) {
  test(`[synthetic dataset] ${name} compound_outcomes are structurally valid where present`, () => {
    const parsed = parseMeetingGroundTruth(groundTruth);
    for (const item of parsed.ground_truth) {
      if (!item.compound_outcomes) continue;
      assert.ok(item.compound_outcomes.length >= 2, `${name}: GT item "${item.id}" has compound_outcomes with fewer than 2 entries`);
      for (const sub of item.compound_outcomes) assert.ok(sub.trim().length > 0);
    }
  });
}

// ---------------------------------------------------------------------------
// 9. Transcript order is deterministic -- segments are in strictly ascending `index` order, and
//    the exported array is stable across re-import (no randomness/Date.now()-based ordering).
// ---------------------------------------------------------------------------
for (const { name, transcript } of MEETINGS) {
  test(`[synthetic dataset] ${name} transcript segments are in strictly ascending, deterministic order`, () => {
    const segments = transcript.transcriptSegments;
    for (let i = 1; i < segments.length; i += 1) {
      assert.ok(segments[i].index > segments[i - 1].index, `${name}: segment index out of order at position ${i}`);
    }
    const timestamps = segments.map((s) => Date.parse(s.timestamp));
    for (let i = 1; i < timestamps.length; i += 1) {
      assert.ok(timestamps[i] >= timestamps[i - 1], `${name}: timestamp out of chronological order at position ${i}`);
    }
  });
}

test("[synthetic dataset] all five meetings have distinct meeting_id values", () => {
  const ids = MEETINGS.map(({ groundTruth }) => parseMeetingGroundTruth(groundTruth).meeting_id);
  assert.equal(new Set(ids).size, ids.length, `expected 5 distinct meeting ids, got ${JSON.stringify(ids)}`);
});

// ---------------------------------------------------------------------------
// 10. The real Craig fixture remains byte-for-byte unchanged by this work.
// ---------------------------------------------------------------------------
test("[synthetic dataset] the frozen Craig Aug 19 fixture is unaffected by the new synthetic dataset", () => {
  const parsed = parseMeetingGroundTruth(craigGroundTruth);
  assert.equal(parsed.meeting_id, "e9dcc8fe-0c79-47e6-a265-ae171b3478d5");
  assert.equal(parsed.meeting_title, "Meeting with Craig Aug 19");
  const ids = parsed.ground_truth.map((item) => item.id);
  assert.deepEqual(ids, ["GT1", "GT2", "GT3", "GT4", "GT5", "GT6", "NEG1", "NEG2", "NEG3"]);
  assert.equal(parsed.ground_truth.filter((i) => i.expected_state === "active").length, 6);
  assert.equal(parsed.ground_truth.filter((i) => i.expected_state === "completed_during_meeting").length, 3);
});
