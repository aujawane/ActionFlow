import assert from "node:assert/strict";
import test from "node:test";

import {
  PARFAIT_IMPORT_PAYLOAD_KEY,
  canonicalTranscriptOrder,
  extractImportedSegmentIndex,
  type OrderableTranscriptSegment
} from "../lib/transcript-order";

// Phase 1 ordering foundation for manual transcript imports: an imported segment's source position
// is persisted as raw_payload.parfait_import.segment_index (no new column).

function imported(id: string, segmentIndex: unknown): OrderableTranscriptSegment {
  return {
    id,
    timestamp: null,
    raw_payload: { [PARFAIT_IMPORT_PAYLOAD_KEY]: { segment_index: segmentIndex } }
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test("imported segments with no timestamp sort by their recorded source position, whatever order they arrive in", () => {
  // Ids deliberately sort in the opposite direction to the source order.
  const rows = ["z", "y", "x", "w", "v"].map((id, index) => imported(id, index));
  for (const seed of [1, 2, 3, 42, 99]) {
    const ordered = canonicalTranscriptOrder(shuffled(rows, seed));
    assert.deepEqual(ordered.map((row) => row.id), ["z", "y", "x", "w", "v"], `seed ${seed}`);
  }
});

test("source position outranks database order and the random-UUID tie-break", () => {
  // A database read ordered by a null timestamp returns rows in no guaranteed order; ids are
  // random UUIDs. Neither may decide the transcript order of an import.
  const rows = [
    imported("00000000-0000-4000-8000-000000000001", 2),
    imported("ffffffff-0000-4000-8000-000000000003", 0),
    imported("88888888-0000-4000-8000-000000000002", 1)
  ];
  assert.deepEqual(
    canonicalTranscriptOrder(rows).map((row) => (row.raw_payload as Record<string, Record<string, number>>).parfait_import.segment_index),
    [0, 1, 2]
  );
});

test("exact ties on segment_index stay deterministic (id, then input position)", () => {
  const a = imported("a", 7);
  const b = imported("b", 7);
  assert.deepEqual(canonicalTranscriptOrder([b, a]).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(canonicalTranscriptOrder([a, b]).map((row) => row.id), ["a", "b"]);
});

test("only a non-negative safe integer at the exact namespaced path counts; everything else is ignored", () => {
  assert.equal(extractImportedSegmentIndex({ parfait_import: { segment_index: 0 } }), 0);
  assert.equal(extractImportedSegmentIndex({ parfait_import: { segment_index: 12 } }), 12);
  for (const bad of ["3", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}, [1], 2 ** 53]) {
    assert.equal(extractImportedSegmentIndex({ parfait_import: { segment_index: bad } }), null, String(bad));
  }
  for (const payload of [null, undefined, "x", 4, [], {}, { parfait_import: null }, { parfait_import: [0] }, { parfait_import: "0" }, { segment_index: 0 }]) {
    assert.equal(extractImportedSegmentIndex(payload), null, JSON.stringify(payload));
  }
});

test("a malformed index never throws and only drops that row below the well-formed ones, deterministically", () => {
  const rows = [imported("bad-string", "1"), imported("two", 2), imported("bad-negative", -5), imported("zero", 0)];
  const first = canonicalTranscriptOrder(rows).map((row) => row.id);
  assert.deepEqual(first.slice(0, 2), ["zero", "two"]);
  // The two malformed rows fall to the input-position tier, after every indexed row.
  assert.deepEqual(first.slice(2).sort(), ["bad-negative", "bad-string"]);
  assert.deepEqual(canonicalTranscriptOrder(rows).map((row) => row.id), first, "same input, same order");
});

test("Recall ordering is unchanged: Recall payloads never carry parfait_import, and a root-level segment_index key is not read", () => {
  const recallRow = (id: string, relative: number, extra: Record<string, unknown> = {}) => ({
    id,
    timestamp: "2026-08-05T18:57:28.509+00:00",
    raw_payload: { words: [{ text: "x", start_timestamp: { relative } }], ...extra }
  });
  const plain = [recallRow("c", 30), recallRow("a", 10), recallRow("b", 20)];
  assert.deepEqual(canonicalTranscriptOrder(plain).map((row) => row.id), ["a", "b", "c"]);

  // A stray, un-namespaced segment_index inside a Recall payload must not override Recall timing.
  const withStrayKey = [
    recallRow("c", 30, { segment_index: 0 }),
    recallRow("a", 10, { segment_index: 2 }),
    recallRow("b", 20, { segment_index: 1 })
  ];
  assert.deepEqual(canonicalTranscriptOrder(withStrayKey).map((row) => row.id), ["a", "b", "c"]);
});

test("a row-level segment_index (fixtures) still takes precedence over an imported payload index", () => {
  const rows: OrderableTranscriptSegment[] = [
    { id: "p", segment_index: 1, raw_payload: { parfait_import: { segment_index: 0 } } },
    { id: "q", segment_index: 0, raw_payload: { parfait_import: { segment_index: 1 } } }
  ];
  assert.deepEqual(canonicalTranscriptOrder(rows).map((row) => row.id), ["q", "p"]);
});
