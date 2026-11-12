import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { loadMeetingAnalysisInput } from "../lib/meeting-analysis/topics";
import { loadOrderedTranscriptSegments } from "../lib/meeting-analysis/normalization";
import { buildCanonicalTranscriptWithSegmentIds, canonicalTranscriptOrder } from "../lib/transcript-order";
import { normalizeTranscriptSpeaker } from "../lib/transcript-speaker";
import { buildCleanTranscript } from "../lib/analysis";
import {
  MAX_TRANSCRIPT_PAGES,
  TRANSCRIPT_PAGE_SIZE,
  loadAllMeetingTranscriptSegments,
  type TranscriptPageClient
} from "../lib/transcript-loader";
import type { TranscriptSegment } from "../lib/types";

// Clients are lazy and read these on first use; nothing here reaches a network.
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_ENV: "staging",
  NEXT_PUBLIC_STAGING_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY: "anon",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test",
  RECALL_API_KEY: "test",
  RECALL_WEBHOOK_SECRET: "test"
});

const MEETING = "meeting-1";
const OTHER_MEETING = "meeting-2";
/** PostgREST's default max-rows: the cap that truncated the staging meeting. */
const POSTGREST_DEFAULT_MAX_ROWS = 1000;

type Row = Record<string, unknown>;

const segmentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pad = (n: number) => String(n).padStart(5, "0");

/** A recall-shaped segment: real timestamp and per-word relative offset, in true order `i`. */
function recallRow(i: number, id: string, extra: Row = {}): Row {
  return {
    id,
    meeting_id: MEETING,
    speaker: i % 2 === 0 ? "Alex" : "Sam",
    participant_name: i % 2 === 0 ? "Alex" : "Sam",
    text: `line ${pad(i)}`,
    normalized_text: null,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + i * 1000).toISOString(),
    raw_payload: { words: [{ start_timestamp: { relative: i * 1.5 } }] },
    ...extra
  };
}

/** `count` rows in true order, with ids assigned by a coprime permutation so that id order,
 * insertion order and true order all disagree. */
function permutedRows(count: number, build: (i: number, id: string) => Row): { rows: Row[]; trueOrderIds: string[] } {
  const trueOrderIds: string[] = [];
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = segmentId((i * 7919) % count);
    trueOrderIds.push(id);
    rows.push(build(i, id));
  }
  assert.equal(new Set(trueOrderIds).size, count, "fixture ids are unique");
  // Store in a different order again (reverse), as a physical heap might.
  return { rows: rows.reverse(), trueOrderIds };
}

function dbWith(rows: Row[], maxRows: number | null = POSTGREST_DEFAULT_MAX_ROWS) {
  const db = new FakeDb({
    transcript_segments: [
      ...rows,
      // A decoy meeting: its rows must never leak into MEETING's transcript.
      recallRow(0, "decoy-1", { meeting_id: OTHER_MEETING }),
      recallRow(1, "decoy-2", { meeting_id: OTHER_MEETING })
    ]
  });
  db.maxRows = maxRows;
  return db;
}
const asClient = (db: FakeDb) => db as unknown as TranscriptPageClient;

// ------------------------------------------------------------------ root cause
test("a plain select against a capped PostgREST returns only the first 1,000 rows (the bug)", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows);
  const { data, error } = await db.from("transcript_segments").select("*").eq("meeting_id", MEETING).order("timestamp");
  assert.equal(error, null);
  assert.equal((data as Row[]).length, POSTGREST_DEFAULT_MAX_ROWS);
});

// ------------------------------------------------------------------ pagination
for (const [count, pages] of [
  [0, 1],
  [1, 1],
  [999, 1],
  [1000, 1],
  [1001, 2],
  [1250, 2],
  [2000, 2],
  [2654, 3],
  [3000, 3],
  [3001, 4]
] as const) {
  test(`loads every one of ${count} segments in ${pages} request(s) with no gap or repeat`, async () => {
    const { rows } = permutedRows(count, recallRow);
    const db = dbWith(rows);
    const result = await loadAllMeetingTranscriptSegments<Row>({ client: asClient(db), meetingId: MEETING });
    assert.equal(result.error, null);
    const ids = result.data!.map((row) => row.id as string);
    assert.equal(ids.length, count);
    assert.equal(new Set(ids).size, count, "no duplicates");
    assert.deepEqual(new Set(ids), new Set(rows.map((row) => row.id as string)), "no missing rows");
    assert.ok(ids.every((id) => !id.startsWith("decoy")), "other meetings are excluded");
    assert.equal(db.selectRequests.length, pages);
    // Pages are contiguous 1,000-row windows.
    db.selectRequests.forEach((request, index) => {
      assert.deepEqual(request.range, [index * 1000, index * 1000 + 999]);
    });
  });
}

test("the page size is the PostgREST default and the loop guard is far above any real transcript", () => {
  assert.equal(TRANSCRIPT_PAGE_SIZE, 1000);
  assert.ok(MAX_TRANSCRIPT_PAGES * TRANSCRIPT_PAGE_SIZE >= 1_000_000);
});

test("a smaller page size produces more pages but the same rows", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows);
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: asClient(db), meetingId: MEETING, pageSize: 300 });
  assert.equal(result.error, null);
  assert.equal(result.data!.length, 1250);
  assert.equal(db.selectRequests.length, 5);
});

test("a project whose max-rows is below the page size still loads every row", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows, 400); // every 1,000-row request comes back with only 400 rows
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: asClient(db), meetingId: MEETING });
  assert.equal(result.error, null);
  assert.equal(result.data!.length, 1250);
  assert.equal(new Set(result.data!.map((row) => row.id)).size, 1250);
  // Each request is asked for 1,000 rows but gets 400; the next one must start at the next
  // unread row (400, 800, 1200), not at 1,000, which would skip 600 rows.
  assert.deepEqual(
    db.selectRequests.map((request) => request.range),
    [[0, 999], [400, 1399], [800, 1799], [1200, 2199]]
  );
  const asLoaded = result.data!.map((row) => row.id as string);
  const asStored = [...(rows as Row[])].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id))).map((row) => row.id as string);
  assert.deepEqual(asLoaded, asStored, "rows arrive contiguously in database order: none skipped");
});

// ------------------------------------------------------------------ failure handling
test("a failed page is reported with its position, never returned as a partial transcript", async () => {
  const { rows } = permutedRows(2500, recallRow);
  const db = dbWith(rows);
  const real = asClient(db);
  let calls = 0;
  const flaky: TranscriptPageClient = {
    from: (table) => {
      const builder = real.from(table);
      return {
        select: (columns, options) => {
          const query = builder.select(columns, options);
          const range = query.range.bind(query);
          query.range = (from, to) => {
            calls += 1;
            return calls === 2
              ? Promise.resolve({ data: null, error: { message: "connection reset" } })
              : range(from, to);
          };
          return query;
        }
      };
    }
  };
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: flaky, meetingId: MEETING });
  assert.equal(result.data, null);
  assert.match(result.error!.message, /page 2.*rows 1000-1999.*connection reset/);
});

test("an API that ignores range cannot loop forever or return duplicated rows", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows);
  const real = asClient(db);
  const ignoresRange: TranscriptPageClient = {
    from: (table) => ({
      select: (columns, options) => {
        const query = real.from(table).select(columns, options);
        query.range = (_from, _to) => real.from(table).select(columns, options).eq("meeting_id", MEETING).range(0, 999);
        return query;
      }
    })
  };
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: ignoresRange, meetingId: MEETING });
  assert.equal(result.data, null);
  assert.ok(result.error);
});

test("a transcript that shrinks mid-load is an error, not a silently short result", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows);
  const real = asClient(db);
  let calls = 0;
  const shrinking: TranscriptPageClient = {
    from: (table) => ({
      select: (columns, options) => {
        const query = real.from(table).select(columns, options);
        const range = query.range.bind(query);
        query.range = (from, to) => {
          calls += 1;
          if (calls === 2) db.tables.transcript_segments = [];
          return range(from, to);
        };
        return query;
      }
    })
  };
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: shrinking, meetingId: MEETING });
  assert.equal(result.data, null);
  assert.match(result.error!.message, /changed while loading/);
});

test("without a row count it falls back to stopping on a short page", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = dbWith(rows);
  const real = asClient(db);
  const noCount: TranscriptPageClient = {
    from: (table) => ({
      select: (columns, options) => {
        const query = real.from(table).select(columns, options);
        const range = query.range.bind(query);
        query.range = async (from, to) => {
          const { count: _ignored, ...rest } = await range(from, to);
          return rest;
        };
        return query;
      }
    })
  };
  const result = await loadAllMeetingTranscriptSegments<Row>({ client: noCount, meetingId: MEETING });
  assert.equal(result.error, null);
  assert.equal(result.data!.length, 1250);
});

// ------------------------------------------------------------------ ordering
test("repeated timestamps: pages cut through a tie, yet the canonical order is the true order", async () => {
  // 1,400 rows share just 3 timestamps; true order is carried by Recall's per-word offsets.
  const { rows, trueOrderIds } = permutedRows(1400, (i, id) =>
    recallRow(i, id, { timestamp: `2026-10-01T10:00:0${i % 3}.000Z` })
  );
  const db = dbWith(rows);
  const reference = canonicalTranscriptOrder(rows as unknown as TranscriptSegment[]).map((row) => row.id);
  assert.deepEqual(reference.slice().sort(), trueOrderIds.slice().sort());
  const { data, error } = await loadAllMeetingTranscriptSegments<TranscriptSegment>({ client: asClient(db), meetingId: MEETING });
  assert.equal(error, null);
  // The database order used for paging is NOT the transcript order...
  assert.notDeepEqual(data!.map((row) => row.id), trueOrderIds);
  // ...and the final canonical order does not depend on where the page boundary fell.
  assert.deepEqual(canonicalTranscriptOrder(data!).map((row) => row.id), trueOrderIds);
  for (const pageSize of [1000, 777, 333, 64, 7]) {
    const paged = await loadAllMeetingTranscriptSegments<TranscriptSegment>({
      client: asClient(dbWith(rows)),
      meetingId: MEETING,
      pageSize
    });
    assert.deepEqual(canonicalTranscriptOrder(paged.data!).map((row) => row.id), trueOrderIds, `pageSize ${pageSize}`);
  }
});

test("identical timestamps and no other ordering signal: order is a stable function of the data", async () => {
  const { rows } = permutedRows(1300, (i, id) => recallRow(i, id, { timestamp: "2026-10-01T10:00:00.000Z", raw_payload: {} }));
  const a = await loadAllMeetingTranscriptSegments<TranscriptSegment>({ client: asClient(dbWith(rows)), meetingId: MEETING });
  const b = await loadAllMeetingTranscriptSegments<TranscriptSegment>({ client: asClient(dbWith([...rows].reverse())), meetingId: MEETING, pageSize: 250 });
  assert.deepEqual(canonicalTranscriptOrder(a.data!).map((r) => r.id), canonicalTranscriptOrder(b.data!).map((r) => r.id));
  assert.deepEqual(a.data!.map((r) => r.id), b.data!.map((r) => r.id), "database paging order is deterministic");
});

test("null timestamps with parfait_import.segment_index: nothing is dropped, nulls stay null, source order wins", async () => {
  const { rows, trueOrderIds } = permutedRows(1300, (i, id) => ({
    id,
    meeting_id: MEETING,
    speaker: "Alex",
    participant_name: "Alex",
    text: `imported ${pad(i)}`,
    normalized_text: null,
    timestamp: null,
    raw_payload: { parfait_import: { segment_index: i } }
  }));
  const db = dbWith(rows);
  const { data, error } = await loadAllMeetingTranscriptSegments<TranscriptSegment>({ client: asClient(db), meetingId: MEETING });
  assert.equal(error, null);
  assert.equal(data!.length, 1300, "null-timestamp rows are not filtered out");
  assert.ok(data!.every((row) => row.timestamp === null), "null is never converted to a date");
  assert.ok(!JSON.stringify(data).includes("1970"));
  assert.deepEqual(canonicalTranscriptOrder(data!).map((row) => row.id), trueOrderIds);
});

test("a mix of null-timestamp and timestamped rows loads completely, nulls last, in the database order", async () => {
  const { rows } = permutedRows(1100, (i, id) => recallRow(i, id, i % 2 === 0 ? { timestamp: null, raw_payload: { parfait_import: { segment_index: i } } } : {}));
  const result = await loadAllMeetingTranscriptSegments<TranscriptSegment>({ client: asClient(dbWith(rows)), meetingId: MEETING });
  assert.equal(result.error, null);
  const data = result.data!;
  assert.equal(data.length, 1100);
  const firstNull = data.findIndex((row) => row.timestamp === null);
  assert.ok(data.slice(0, firstNull).every((row) => row.timestamp !== null));
  assert.ok(data.slice(firstNull).every((row) => row.timestamp === null));
});

// ------------------------------------------------------------------ analysis input
function meetingRow() {
  return { id: MEETING, user_id: "user-1", project_id: null, created_at: "2026-10-01T10:00:00.000Z", deleted_at: null };
}

let installed: FakeDb | null = null;
installFakeSupabase(getSupabaseAdmin(), () => installed ?? new FakeDb({}));
function installSeed(rows: Row[], maxRows: number | null = POSTGREST_DEFAULT_MAX_ROWS) {
  installed = new FakeDb({ meetings: [meetingRow()], transcript_segments: rows });
  installed.maxRows = maxRows;
  return installed;
}

test("loadMeetingAnalysisInput consumes more than 1,000 segments and the transcript ends with the last one", async () => {
  const count = 1250;
  const { rows, trueOrderIds } = permutedRows(count, (i, id) =>
    recallRow(i, id, { text: i === count - 1 ? "FINAL-SEGMENT-MARKER" : `line ${pad(i)}` })
  );
  const db = installSeed(rows);
  const input = await loadMeetingAnalysisInput(MEETING);

  assert.equal(input.safeSegments.length, count);
  assert.equal(input.sourceBase.transcriptSegmentCount, count);
  assert.deepEqual(input.safeSegments.map((segment) => segment.id), trueOrderIds);
  assert.ok(input.transcript.endsWith("FINAL-SEGMENT-MARKER"), "clean transcript ends with the final row");
  assert.ok(input.segmentationTranscript.includes("FINAL-SEGMENT-MARKER"));
  assert.ok(input.segmentationTranscript.includes(`[${trueOrderIds[count - 1]}]`));
  assert.equal(input.transcript.split("\n").length, count);
  assert.equal(db.selectRequests.filter((request) => request.table === "transcript_segments").length, 2);
});

test("the exact staging shape: a 2,654-segment meeting is analysed from all 2,654 segments", async () => {
  const { rows, trueOrderIds } = permutedRows(2654, recallRow);
  installSeed(rows);
  const input = await loadMeetingAnalysisInput(MEETING);
  assert.equal(input.safeSegments.length, 2654);
  assert.deepEqual(input.safeSegments.map((segment) => segment.id), trueOrderIds);
});

test("normalization's loader (shared by pipeline v1 and v2) also sees every segment", async () => {
  const { rows, trueOrderIds } = permutedRows(1250, recallRow);
  installSeed(rows);
  const ordered = await loadOrderedTranscriptSegments(MEETING);
  assert.deepEqual(ordered.map((segment) => segment.id), trueOrderIds);
});

test("null-timestamp imported meeting above 1,000 segments reaches analysis in source order", async () => {
  const { rows, trueOrderIds } = permutedRows(1300, (i, id) => ({
    id,
    meeting_id: MEETING,
    speaker: "Alex",
    participant_name: "Alex",
    text: i === 1299 ? "LAST-IMPORTED-LINE" : `imported ${pad(i)}`,
    normalized_text: null,
    timestamp: null,
    raw_payload: { parfait_import: { segment_index: i } }
  }));
  installSeed(rows);
  const input = await loadMeetingAnalysisInput(MEETING);
  assert.deepEqual(input.safeSegments.map((segment) => segment.id), trueOrderIds);
  assert.ok(input.transcript.endsWith("Alex: LAST-IMPORTED-LINE"));
  assert.ok(!input.transcript.includes("1970"));
  assert.ok(!/^\[/.test(input.transcript), "a null timestamp is never rendered as a time");
});

test("a failed page surfaces from loadMeetingAnalysisInput as a transcript error, not a short transcript", async () => {
  const { rows } = permutedRows(1250, recallRow);
  const db = installSeed(rows);
  const originalFrom = db.from.bind(db);
  db.from = ((table: string) => {
    const query = originalFrom(table);
    if (table === "transcript_segments") {
      query.range = (() => Promise.resolve({ data: null, error: { message: "boom" } })) as unknown as typeof query.range;
    }
    return query;
  }) as typeof db.from;
  await assert.rejects(loadMeetingAnalysisInput(MEETING), /Failed to fetch transcript: .*boom/);
});

// ------------------------------------------------------------------ recall regression
test("below the cap, the new loader produces exactly the rows, order and prompt text the old loader did", async () => {
  for (const count of [1, 2, 40, 999, 1000]) {
    const { rows } = permutedRows(count, recallRow);
    const db = installSeed(rows);

    // The loader exactly as it was before this change: one select ordered by timestamp.
    const legacy = await db.from("transcript_segments").select("*").eq("meeting_id", MEETING).order("timestamp", { ascending: true });
    const legacyOrdered = canonicalTranscriptOrder(legacy.data as TranscriptSegment[])
      .map((segment) => ({ ...segment, text: segment.normalized_text ?? segment.text }))
      .map(normalizeTranscriptSpeaker);

    const input = await loadMeetingAnalysisInput(MEETING);
    assert.equal(input.safeSegments.length, legacyOrdered.length, `row count (${count})`);
    assert.deepEqual(input.safeSegments.map((s) => s.id), legacyOrdered.map((s) => s.id), `row ids and order (${count})`);
    assert.equal(input.transcript, buildCleanTranscript(legacyOrdered), `clean prompt text (${count})`);
    assert.equal(input.segmentationTranscript, buildCanonicalTranscriptWithSegmentIds(legacyOrdered), `segmented prompt text (${count})`);
    // Single request when everything fits in one page.
    // The new loader's requests are the ranged ones (the legacy select above is unranged).
    assert.equal(db.selectRequests.filter((request) => request.table === "transcript_segments" && request.range).length, 1);
  }
});

// ------------------------------------------------------------------ source pins
test("every complete-transcript consumer goes through the shared loader, not a bare select", async () => {
  const mustUseLoader = [
    "../lib/meeting-analysis/topics.ts",
    "../lib/meeting-analysis/normalization.ts",
    "../lib/meeting-assistant/transcript-selection.ts",
    "../lib/meeting-participants.ts",
    "../lib/execution-intelligence/eval-harness/checkpoint-reader.ts",
    "../app/meetings/[id]/page.tsx",
    "../app/api/meetings/[id]/transcript/route.ts",
    "../app/api/meetings/[id]/assistant/messages/route.ts",
    "../app/api/dev/meeting-extraction-debug/route.ts",
    "../scripts/diagnose-execution-candidates.ts",
    "../scripts/copy-meeting-to-staging.ts"
  ];
  for (const path of mustUseLoader) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /loadAllMeetingTranscriptSegments/, path);
    // No remaining bare row-returning transcript_segments select (head/count queries are fine).
    for (const match of source.matchAll(/from\("transcript_segments"\)\s*\.select\(([^)]*)\)/g)) {
      assert.match(match[1], /head:\s*true/, `${path} still has an unpaged transcript_segments select`);
    }
  }
});
