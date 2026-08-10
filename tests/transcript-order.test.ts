import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalTranscriptWithSegmentIds,
  canonicalTranscriptOrder,
  type OrderableTranscriptSegment,
  type TranscriptTextSegment
} from "../lib/transcript-order";

function segment(
  overrides: Partial<OrderableTranscriptSegment> & { id: string; text?: string }
): OrderableTranscriptSegment & { text?: string } {
  return { timestamp: null, raw_payload: null, ...overrides };
}

function wordPayload(relative: number, absolute?: string) {
  return { words: [{ text: "x", start_timestamp: { relative, absolute: absolute ?? null } }] };
}

test("1. many segments with identical DB timestamps sort by Recall-relative offset instead", () => {
  const same = "2026-08-05T18:57:28.509+00:00";
  const segments = [
    segment({ id: "c", timestamp: same, raw_payload: wordPayload(30) }),
    segment({ id: "a", timestamp: same, raw_payload: wordPayload(10) }),
    segment({ id: "b", timestamp: same, raw_payload: wordPayload(20) })
  ];
  const ordered = canonicalTranscriptOrder(segments);
  assert.deepEqual(ordered.map((s) => s.id), ["a", "b", "c"]);
});

test("2. relative timestamp represented as a number", () => {
  const segments = [
    segment({ id: "second", raw_payload: { words: [{ start_timestamp: { relative: 5 } }] } }),
    segment({ id: "first", raw_payload: { words: [{ start_timestamp: { relative: 1 } }] } })
  ];
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["first", "second"]);
});

test("3. relative timestamp represented as a numeric string", () => {
  const segments = [
    segment({ id: "second", raw_payload: { words: [{ start_timestamp: { relative: "5.5" } }] } }),
    segment({ id: "first", raw_payload: { words: [{ start_timestamp: { relative: "1.2" } }] } })
  ];
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["first", "second"]);
});

test("4. missing words array falls through to timestamp, not a crash", () => {
  const segments = [
    segment({ id: "later", timestamp: "2026-08-05T18:00:02.000Z", raw_payload: { words: [] } }),
    segment({ id: "earlier", timestamp: "2026-08-05T18:00:01.000Z", raw_payload: { participant: {} } })
  ];
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["earlier", "later"]);
});

test("5. missing raw_payload entirely falls through to timestamp", () => {
  const segments = [
    segment({ id: "later", timestamp: "2026-08-05T18:00:02.000Z" }),
    segment({ id: "earlier", timestamp: "2026-08-05T18:00:01.000Z" })
  ];
  const withoutPayload = segments.map(({ raw_payload, ...rest }) => rest);
  assert.deepEqual(canonicalTranscriptOrder(withoutPayload).map((s) => s.id), ["earlier", "later"]);
});

test("6. equal relative offsets fall back to stable input-order tie-breaking", () => {
  const segments = [
    segment({ id: "z", raw_payload: wordPayload(10) }),
    segment({ id: "a", raw_payload: wordPayload(10) }),
    segment({ id: "m", raw_payload: wordPayload(10) })
  ];
  // Same tier, same value -> original array position wins, not id lexical order.
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["z", "a", "m"]);
});

test("7. mixed segments -- some have relative timing, others only a DB timestamp", () => {
  const segments = [
    segment({ id: "no-timing-late", timestamp: "2026-08-05T18:00:09.000Z" }),
    segment({ id: "has-relative-early", raw_payload: wordPayload(1) }),
    segment({ id: "has-relative-mid", raw_payload: wordPayload(5) })
  ];
  // Tiered ordering: anything with a relative offset (tier 2) sorts entirely before anything
  // that only has a raw timestamp (tier 5) -- tiers are never interleaved by value.
  assert.deepEqual(
    canonicalTranscriptOrder(segments).map((s) => s.id),
    ["has-relative-early", "has-relative-mid", "no-timing-late"]
  );
});

test("8. fixture source order preserved when no trustworthy timing metadata exists at all", () => {
  const segments = [segment({ id: "b" }), segment({ id: "a" }), segment({ id: "c" })];
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["b", "a", "c"]);
});

test("9. a request sorts before its acceptance once canonical order is applied", () => {
  const acceptance = segment({
    id: "accept",
    text: "Aditya: I'll do it.",
    timestamp: "2026-08-05T18:00:00.000Z",
    raw_payload: wordPayload(50)
  });
  const request = segment({
    id: "request",
    text: "Craig: Can you handle that?",
    timestamp: "2026-08-05T18:00:00.000Z",
    raw_payload: wordPayload(10)
  });
  const ordered = canonicalTranscriptOrder([acceptance, request]);
  assert.deepEqual(ordered.map((s) => s.id), ["request", "accept"]);
});

test("10. a later 'informational first, e-commerce later' sequencing statement stays after the earlier broad discussion", () => {
  const earlyEcommerceDiscussion = segment({
    id: "early-ecommerce",
    text: "Aditya: we could eventually add full checkout and accounts",
    raw_payload: wordPayload(20)
  });
  const laterSequencing = segment({
    id: "later-sequencing",
    text: "Jamileh: let's do the informational site first, e-commerce can come later since it needs more time",
    raw_payload: wordPayload(800)
  });
  const ordered = canonicalTranscriptOrder([laterSequencing, earlyEcommerceDiscussion]);
  assert.deepEqual(ordered.map((s) => s.id), ["early-ecommerce", "later-sequencing"]);
});

test("does not use UUID lexical order as a primary signal -- a lexically later id can still sort first", () => {
  const segments = [
    segment({ id: "zzzzzzzz-0000-4000-8000-000000000000", raw_payload: wordPayload(1) }),
    segment({ id: "00000000-0000-4000-8000-000000000000", raw_payload: wordPayload(99) })
  ];
  assert.deepEqual(
    canonicalTranscriptOrder(segments).map((s) => s.id),
    ["zzzzzzzz-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"]
  );
});

test("tier 1: an explicit persisted segment_index overrides everything else, including relative timing", () => {
  const segments = [
    segment({ id: "should-be-second", segment_index: 2, raw_payload: wordPayload(1) }),
    segment({ id: "should-be-first", segment_index: 1, raw_payload: wordPayload(99) })
  ];
  assert.deepEqual(
    canonicalTranscriptOrder(segments).map((s) => s.id),
    ["should-be-first", "should-be-second"]
  );
});

test("integration: topic preparation and V4 work-item preparation build the identical transcript string from out-of-order rows", () => {
  // Simulates the exact real-world bug: identical DB timestamps (bulk import), real chronological
  // order only recoverable from Recall's per-word relative offsets, rows arriving scrambled.
  const sameTimestamp = "2026-08-05T18:57:28.509+00:00";
  const scrambledRows: TranscriptTextSegment[] = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      speaker: "Aditya",
      text: "so like I'll deploy one because the extraction layer is still working",
      timestamp: sameTimestamp,
      raw_payload: wordPayload(300)
    },
    {
      id: "11111111-1111-4111-8111-111111111111",
      speaker: "Craig",
      text: "are you going to get a version this week of parfait running on vercel",
      timestamp: sameTimestamp,
      raw_payload: wordPayload(100)
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      speaker: "Aditya",
      text: "definitely, we should have a version before next Tuesday",
      timestamp: sameTimestamp,
      raw_payload: wordPayload(200)
    }
  ];

  // "Topic preparation" here stands in for lib/meeting-analysis/topics.ts's
  // buildCanonicalTranscriptWithSegmentIds(safeSegments) call -- the literal same function.
  const topicPreparationTranscript = buildCanonicalTranscriptWithSegmentIds(scrambledRows);

  // "V4 work-item preparation" here stands in for a replay fixture loader building the same
  // ExecutionSourceContext.transcript from the same rows, in a different (scrambled) input order.
  const shuffledForFixture = [scrambledRows[2], scrambledRows[0], scrambledRows[1]];
  const v4FixtureTranscript = buildCanonicalTranscriptWithSegmentIds(shuffledForFixture);

  assert.equal(topicPreparationTranscript, v4FixtureTranscript);
  // And it's genuinely chronological, not just consistent with itself: the request precedes the
  // acceptance precedes the follow-through, regardless of input array order or identical timestamps.
  const requestIndex = topicPreparationTranscript.indexOf("are you going to get a version");
  const acceptIndex = topicPreparationTranscript.indexOf("definitely, we should have a version");
  const deployIndex = topicPreparationTranscript.indexOf("so like I'll deploy one");
  assert.ok(requestIndex < acceptIndex);
  assert.ok(acceptIndex < deployIndex);
});

test("malformed relative/absolute values (NaN, objects, empty strings) never throw and fall through cleanly", () => {
  const segments = [
    segment({ id: "malformed", raw_payload: { words: [{ start_timestamp: { relative: "not-a-number" } }] }, timestamp: "2026-08-05T18:00:02.000Z" }),
    segment({ id: "clean", timestamp: "2026-08-05T18:00:01.000Z" })
  ];
  assert.doesNotThrow(() => canonicalTranscriptOrder(segments));
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["clean", "malformed"]);
});
