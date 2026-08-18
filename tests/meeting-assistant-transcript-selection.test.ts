import assert from "node:assert/strict";
import test from "node:test";

import {
  scoreTranscriptSegments,
  shouldIncludeTranscriptEvidence
} from "../lib/meeting-assistant/transcript-selection";
import type { TranscriptSegment } from "../lib/types";

let counter = 0;
function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  counter += 1;
  return {
    id: `segment-${counter}`,
    meeting_id: "meeting-1",
    speaker: "Unknown Speaker",
    participant_name: null,
    text: `Segment text ${counter}`,
    timestamp: `2026-08-01T15:0${counter}:00Z`,
    raw_payload: {},
    created_at: `2026-08-01T15:0${counter}:00Z`,
    ...overrides
  };
}

// 12. no full transcript required for simple ownership question
test("shouldIncludeTranscriptEvidence: a plain ownership/status question does not require transcript evidence", () => {
  assert.equal(shouldIncludeTranscriptEvidence("Who owns what?"), false);
  assert.equal(shouldIncludeTranscriptEvidence("What is blocked?"), false);
  assert.equal(shouldIncludeTranscriptEvidence("What does Aditya need to do?"), false);
  assert.equal(shouldIncludeTranscriptEvidence("Draft an email to the team."), false);
});

test("shouldIncludeTranscriptEvidence: a question about what was said/discussed requires transcript evidence", () => {
  assert.equal(shouldIncludeTranscriptEvidence("What did Craig say about pricing?"), true);
  assert.equal(shouldIncludeTranscriptEvidence("What exactly did we decide about the FAQ?"), true);
  assert.equal(shouldIncludeTranscriptEvidence("Did we discuss pricing?"), true);
  assert.equal(shouldIncludeTranscriptEvidence("What did Craig say about enterprise Codex?"), true);
});

// 11. relevant transcript evidence selection
test("scoreTranscriptSegments: prioritizes segments containing message keywords", () => {
  const pricingSegment = segment({ text: "I think the pricing for the enterprise plan is too high." });
  const unrelatedSegment = segment({ text: "Let's schedule the design review for next Tuesday." });
  const selected = scoreTranscriptSegments([unrelatedSegment, pricingSegment], "What did we say about pricing?", 1);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, pricingSegment.id);
});

test("scoreTranscriptSegments: boosts a segment whose Recall speaker is named in the message", () => {
  const craigSegment = segment({ speaker: "Craig Lauer", text: "The account setup is straightforward." });
  const otherSegment = segment({
    speaker: "Aditya Ujawane",
    text: "The account setup is straightforward and quick."
  });
  const selected = scoreTranscriptSegments(
    [otherSegment, craigSegment],
    "What did Craig say about the account setup?",
    1
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].speaker, "Craig Lauer");
});

test("scoreTranscriptSegments: returns segments in chronological order, not relevance-rank order", () => {
  const first = segment({ text: "pricing discussion begins here", timestamp: "2026-08-01T15:01:00Z" });
  const second = segment({ text: "more pricing details", timestamp: "2026-08-01T15:05:00Z" });
  const selected = scoreTranscriptSegments([second, first], "pricing", 5);
  assert.deepEqual(
    selected.map((item) => item.id),
    [first.id, second.id]
  );
});

test("scoreTranscriptSegments: empty segment list returns empty result", () => {
  assert.deepEqual(scoreTranscriptSegments([], "pricing", 5), []);
});

test("scoreTranscriptSegments: no keyword overlap at all still returns a small bounded fallback rather than nothing", () => {
  const segments = Array.from({ length: 3 }, () => segment());
  const selected = scoreTranscriptSegments(segments, "xyzxyz nonmatching", 5);
  assert.equal(selected.length, 3);
});
