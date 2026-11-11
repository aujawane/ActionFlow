import assert from "node:assert/strict";
import test from "node:test";

import { buildCleanTranscript, buildTranscriptWithSegmentIds } from "../lib/analysis";
import { formatSegmentClockTime } from "../lib/meeting-assistant/agent";
import { scoreTranscriptSegments } from "../lib/meeting-assistant/transcript-selection";
import { buildCanonicalTranscriptWithSegmentIds } from "../lib/transcript-order";
import { getTranscriptSpeakerLabel } from "../lib/transcript-speaker";
import type { TranscriptSegment } from "../lib/types";

// Frozen copies of the builders exactly as they were before nullable timestamps, used to prove the
// current builders are byte-for-byte identical for every row that has a timestamp.
function legacyBuildCleanTranscript(
  segments: Array<{ participant_name?: string | null; speaker: string | null; text: string; timestamp: string }>
) {
  return segments
    .map((segment) => {
      const speaker = getTranscriptSpeakerLabel({ participant_name: segment.participant_name ?? null, speaker: segment.speaker });
      const time = new Date(segment.timestamp).toISOString();
      const text = segment.text.trim().replace(/\s+/g, " ");
      return `[${time}] ${speaker}: ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
function legacyBuildTranscriptWithSegmentIds(
  segments: Array<{ id: string; participant_name?: string | null; speaker: string | null; text: string; timestamp: string }>
) {
  return segments
    .map((segment) => {
      const speaker = getTranscriptSpeakerLabel({ participant_name: segment.participant_name ?? null, speaker: segment.speaker });
      const time = new Date(segment.timestamp).toISOString();
      const text = segment.text.trim().replace(/\s+/g, " ");
      return `[${segment.id}] [${time}] ${speaker}: ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

const recallRows = [
  { id: "11111111-1111-4111-8111-111111111111", participant_name: "Craig Lee", speaker: "Craig", text: "  I'll finish the   landing page by Friday. ", timestamp: "2026-08-19T16:02:13.250+00:00" },
  { id: "22222222-2222-4222-8222-222222222222", participant_name: null, speaker: "Aditya", text: "Sounds good.\nI'll send the copy tomorrow.", timestamp: "2026-08-19T16:02:18Z" },
  { id: "33333333-3333-4333-8333-333333333333", participant_name: null, speaker: null, text: "Let's review Monday.", timestamp: "2026-08-19T12:02:25.000-04:00" }
];

test("1. Recall-style rows render byte-for-byte as before", () => {
  assert.equal(buildCleanTranscript(recallRows), legacyBuildCleanTranscript(recallRows));
  assert.equal(buildTranscriptWithSegmentIds(recallRows), legacyBuildTranscriptWithSegmentIds(recallRows));
  // And the exact expected text, so a matching change to both copies cannot hide a regression.
  assert.equal(
    buildTranscriptWithSegmentIds(recallRows),
    [
      "[11111111-1111-4111-8111-111111111111] [2026-08-19T16:02:13.250Z] Craig Lee: I'll finish the landing page by Friday.",
      "[22222222-2222-4222-8222-222222222222] [2026-08-19T16:02:18.000Z] Aditya: Sounds good. I'll send the copy tomorrow.",
      "[33333333-3333-4333-8333-333333333333] [2026-08-19T16:02:25.000Z] Unknown Speaker: Let's review Monday."
    ].join("\n")
  );
});

const importedRows = [
  { id: "aaaaaaaa-0000-4000-8000-000000000002", participant_name: null, speaker: "Aditya", text: "Sounds good.", timestamp: null, raw_payload: { parfait_import: { segment_index: 1 } } },
  { id: "bbbbbbbb-0000-4000-8000-000000000001", participant_name: null, speaker: "Craig", text: "I'll finish the landing page by Friday.", timestamp: null, raw_payload: { parfait_import: { segment_index: 0 } } },
  { id: "cccccccc-0000-4000-8000-000000000003", participant_name: null, speaker: null, text: "Let's review everything Monday.", timestamp: null, raw_payload: { parfait_import: { segment_index: 2 } } }
];

test("2 + 3. null timestamps never render as 1970 (or any invented time) and never throw", () => {
  const clean = buildCleanTranscript(importedRows);
  const withIds = buildTranscriptWithSegmentIds(importedRows);
  for (const text of [clean, withIds]) {
    assert.doesNotMatch(text, /1970|Invalid Date|NaN|undefined|null/);
    assert.doesNotMatch(text, /\[\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal(clean.split("\n")[0], "Aditya: Sounds good.");
  assert.equal(withIds.split("\n")[0], "[aaaaaaaa-0000-4000-8000-000000000002] Aditya: Sounds good.");
});

test("4. imported ordering is stable through the canonical model transcript", () => {
  const expected = [
    "[bbbbbbbb-0000-4000-8000-000000000001] Craig: I'll finish the landing page by Friday.",
    "[aaaaaaaa-0000-4000-8000-000000000002] Aditya: Sounds good.",
    "[cccccccc-0000-4000-8000-000000000003] Unknown Speaker: Let's review everything Monday."
  ].join("\n");
  assert.equal(buildCanonicalTranscriptWithSegmentIds(importedRows), expected);
  assert.equal(buildCanonicalTranscriptWithSegmentIds([...importedRows].reverse()), expected);
});

test("a transcript mixing timed and untimed rows renders each row truthfully", () => {
  const text = buildTranscriptWithSegmentIds([recallRows[0], importedRows[0]]);
  assert.equal(
    text,
    "[11111111-1111-4111-8111-111111111111] [2026-08-19T16:02:13.250Z] Craig Lee: I'll finish the landing page by Friday.\n" +
      "[aaaaaaaa-0000-4000-8000-000000000002] Aditya: Sounds good."
  );
});

test("assistant clock time: unchanged for a real time, null (not 1970) without one", () => {
  const ts = "2026-08-19T16:02:13.250Z";
  assert.equal(
    formatSegmentClockTime(ts),
    new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(ts))
  );
  assert.equal(formatSegmentClockTime(null), null);
});

function toSegment(row: (typeof importedRows)[number] | (typeof recallRows)[number]): TranscriptSegment {
  return {
    meeting_id: "m",
    created_at: "2026-11-11T00:00:00Z",
    raw_payload: "raw_payload" in row ? row.raw_payload : {},
    ...row
  } as TranscriptSegment;
}

test("assistant evidence selection does not throw on null timestamps and keeps imported source order", () => {
  const segments = [...importedRows].reverse().map(toSegment);
  const selected = scoreTranscriptSegments(segments, "what about friday monday sounds good", 15);
  assert.deepEqual(
    selected.map((segment) => segment.id),
    ["bbbbbbbb-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "cccccccc-0000-4000-8000-000000000003"]
  );
});

test("assistant evidence selection for Recall rows still sorts by timestamp exactly as before", () => {
  const segments = [recallRows[2], recallRows[0], recallRows[1]].map(toSegment);
  const selected = scoreTranscriptSegments(segments, "friday copy monday", 15);
  const legacy = [...selected].sort((a, b) => new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime());
  assert.deepEqual(selected.map((s) => s.id), legacy.map((s) => s.id));
  assert.deepEqual(selected.map((s) => s.id), recallRows.map((row) => row.id));
});
