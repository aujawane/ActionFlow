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

test("6. equal relative offsets break by stable segment id, not by input (database return) order", () => {
  const segments = [
    segment({ id: "z", raw_payload: wordPayload(10) }),
    segment({ id: "a", raw_payload: wordPayload(10) }),
    segment({ id: "m", raw_payload: wordPayload(10) })
  ];
  // Same tier, same value -> id order, whatever order the rows arrived in.
  assert.deepEqual(canonicalTranscriptOrder(segments).map((s) => s.id), ["a", "m", "z"]);
  assert.deepEqual(canonicalTranscriptOrder([...segments].reverse()).map((s) => s.id), ["a", "m", "z"]);
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

// ================================================================= exact-tie determinism
/** Deterministic PRNG (mulberry32) so every shuffle is reproducible. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (segments: readonly OrderableTranscriptSegment[]) => segments.map((s) => s.id);

/** The comparator as of e10d56d (input position before id), for non-tied parity. */
function previousCanonicalOrder<T extends OrderableTranscriptSegment>(segments: readonly T[]): T[] {
  const keyOf = (s: OrderableTranscriptSegment, index: number) => {
    const words = (s.raw_payload as { words?: Array<{ start_timestamp?: { relative?: unknown } }> } | null)?.words;
    const relative = Number(words?.[0]?.start_timestamp?.relative);
    if (words?.[0]?.start_timestamp?.relative !== undefined && Number.isFinite(relative)) return { tier: 2, value: relative, index, id: s.id };
    const ts = s.timestamp ? Date.parse(s.timestamp) : NaN;
    if (Number.isFinite(ts)) return { tier: 5, value: ts, index, id: s.id };
    return { tier: 6, value: index, index, id: s.id };
  };
  return segments.map((s, i) => ({ s, k: keyOf(s, i) }))
    .sort((a, b) => a.k.tier - b.k.tier || a.k.value - b.k.value || a.k.index - b.k.index || (a.k.id < b.k.id ? -1 : a.k.id > b.k.id ? 1 : 0))
    .map((entry) => entry.s);
}

test("[T1] an exact DB-timestamp tie (no Recall timing) sorts identically from either arrival order", () => {
  const at = "2026-08-19T18:37:51.709+00:00";
  const first = segment({ id: uuid(2), timestamp: at, text: "Speaker B" });
  const second = segment({ id: uuid(1), timestamp: at, text: "Speaker A" });
  const before = segment({ id: uuid(9), timestamp: "2026-08-19T18:37:50.000+00:00" });
  assert.deepEqual(ids(canonicalTranscriptOrder([before, first, second])), [uuid(9), uuid(1), uuid(2)]);
  assert.deepEqual(ids(canonicalTranscriptOrder([second, first, before])), [uuid(9), uuid(1), uuid(2)]);
});

test("[T2] the generation-21 shape: identical Recall start offset AND timestamp, different ids, either arrival order", () => {
  const at = "2026-08-19T18:37:51.709+00:00";
  const laura = segment({ id: "51d3f21f-81ee-48cc-89d4-9475f4f8a959", timestamp: at, raw_payload: wordPayload(1786.0037, "2026-08-19T18:37:51.709Z") });
  const craig = segment({ id: "ec1c3917-44f3-4c79-9657-9208e82a5688", timestamp: at, raw_payload: wordPayload(1786.0037, "2026-08-19T18:37:51.709Z") });
  const neighbours = [segment({ id: uuid(1), raw_payload: wordPayload(1785) }), segment({ id: uuid(2), raw_payload: wordPayload(1787) })];
  const a = canonicalTranscriptOrder([neighbours[0], laura, craig, neighbours[1]]);
  const b = canonicalTranscriptOrder([neighbours[0], craig, laura, neighbours[1]]);
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(ids(a), [uuid(1), laura.id, craig.id, uuid(2)], "ties resolve by id; neighbours keep their timing order");
});

test("[T3][T4] id resolves a tie before input position; input position remains the fallback where ids cannot", () => {
  // Same tier and value, lexically ordered ids -> id wins over arrival order.
  const tied = [segment({ id: "b", raw_payload: wordPayload(5) }), segment({ id: "a", raw_payload: wordPayload(5) })];
  assert.deepEqual(ids(canonicalTranscriptOrder(tied)), ["a", "b"]);
  // Identical ids (not a real transcript, but supported): input position is the last resort.
  const sameId = [
    { ...segment({ id: "dup", raw_payload: wordPayload(5) }), text: "first" },
    { ...segment({ id: "dup", raw_payload: wordPayload(5) }), text: "second" }
  ];
  assert.deepEqual(canonicalTranscriptOrder(sameId).map((s) => s.text), ["first", "second"]);
  assert.deepEqual(canonicalTranscriptOrder([...sameId].reverse()).map((s) => s.text), ["second", "first"]);
  // No ordering signal at all (tier 6): input order is still the order, never id order.
  assert.deepEqual(ids(canonicalTranscriptOrder([segment({ id: "c" }), segment({ id: "a" }), segment({ id: "b" })])), ["c", "a", "b"]);
});

test("[T7] 300 seeded shuffles of a transcript with several kinds of exact ties all produce one ordering", () => {
  const base: OrderableTranscriptSegment[] = [];
  for (let n = 0; n < 120; n += 1) {
    // Every 7th pair shares a Recall start offset; every 11th pair shares only a DB timestamp.
    const relative = n % 7 === 1 ? n - 1 : n;
    if (n % 11 === 0 || n % 11 === 1) {
      base.push(segment({ id: uuid(1_000 - n), timestamp: `2026-08-19T19:00:${String(Math.floor(n / 11)).padStart(2, "0")}.000+00:00` }));
    } else {
      base.push(segment({ id: uuid(1_000 - n), timestamp: "2026-08-19T18:00:00.000+00:00", raw_payload: wordPayload(relative) }));
    }
  }
  // A three-way tie straddling the 40-segment normalization batch boundary (positions 39/40/41).
  for (const n of [39, 40, 41]) base[n] = segment({ id: uuid(5_000 + (n * 7) % 3), timestamp: "2026-08-19T18:00:00.000+00:00", raw_payload: wordPayload(39) });
  const expected = ids(canonicalTranscriptOrder(base));
  for (let seed = 1; seed <= 300; seed += 1) {
    assert.deepEqual(ids(canonicalTranscriptOrder(shuffled(base, seed))), expected, `seed ${seed}`);
  }
  const transcript = buildCanonicalTranscriptWithSegmentIds(base.map((s) => ({ ...s, speaker: "S", text: s.id, timestamp: s.timestamp ?? "" })) as TranscriptTextSegment[]);
  for (let seed = 301; seed <= 320; seed += 1) {
    const rows = shuffled(base, seed).map((s) => ({ ...s, speaker: "S", text: s.id, timestamp: s.timestamp ?? "" })) as TranscriptTextSegment[];
    assert.equal(buildCanonicalTranscriptWithSegmentIds(rows), transcript, `transcript string, seed ${seed}`);
  }
});

test("[T8][T16] without exact ties the ordering is identical to the previous comparator, for any arrival order", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const random = seededRandom(seed);
    const relatives = new Set<number>();
    const rows: OrderableTranscriptSegment[] = [];
    for (let n = 0; n < 60; n += 1) {
      let relative = Math.round(random() * 1e6) / 1e4;
      while (relatives.has(relative)) relative += 0.0001;
      relatives.add(relative);
      // Ids are random relative to timing, so an id-first sort would visibly differ.
      const id = uuid(Math.floor(random() * 1e9));
      rows.push(n % 5 === 0
        ? segment({ id, timestamp: new Date(Date.UTC(2026, 7, 19, 18, 0, 0, n * 37)).toISOString() })
        : segment({ id, raw_payload: wordPayload(relative) }));
    }
    const input = shuffled(rows, seed + 1_000);
    assert.deepEqual(ids(canonicalTranscriptOrder(input)), ids(previousCanonicalOrder(input)), `seed ${seed}`);
  }
});
