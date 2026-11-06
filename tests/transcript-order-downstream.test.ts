import assert from "node:assert/strict";
import test from "node:test";

import { planConversationEventChunks } from "../lib/execution-intelligence/conversation-events";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { buildTopicTranscript } from "../lib/meeting-analysis/topics";
import { buildCanonicalTranscriptWithSegmentIds, type TranscriptTextSegment } from "../lib/transcript-order";
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

/** 300 synthetic segments; 49/50 and 149/150/151 start at the same instant (exact ties that sit on
 * conversation-event chunk and topic boundaries). No real content. */
const segmentId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const TIED = new Map([[50, 49], [150, 149], [151, 149]]);
function rows(): TranscriptTextSegment[] {
  return Array.from({ length: 300 }, (_, index) => {
    const timing = TIED.get(index) ?? index;
    return {
      id: segmentId(index),
      speaker: `Speaker ${index % 4}`,
      text: `synthetic line ${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 19, 18, 0, 0, timing * 1_000)).toISOString(),
      raw_payload: { words: [{ text: "x", start_timestamp: { relative: 1_000 + timing } }] }
    };
  });
}
/** The tied rows arriving the other way round, as a timestamp-only database order may return them. */
function reversedTies(input: TranscriptTextSegment[]) {
  const copy = [...input];
  [copy[49], copy[50]] = [copy[50], copy[49]];
  [copy[149], copy[151]] = [copy[151], copy[149]];
  return copy;
}
function sourceFrom(transcriptRows: TranscriptTextSegment[]): ExecutionSourceContext {
  const ordered = buildCanonicalTranscriptWithSegmentIds(transcriptRows);
  return {
    meetingId: "meeting-order", meetingDate: "2026-08-19", transcript: ordered, transcriptSegmentCount: 300,
    topics: Array.from({ length: 5 }, (_, topic) => ({
      id: `topic-${topic}`, title: `Topic ${topic}`, summary: null,
      segment_ids: Array.from({ length: 60 }, (_, k) => segmentId(topic * 60 + k))
    })),
    insights: []
  } as unknown as ExecutionSourceContext;
}

test("[T14] topic inputs: the segmentation transcript and every per-topic transcript are identical for either tie order", () => {
  const natural = rows();
  const reversed = reversedTies(natural);
  assert.notDeepEqual(reversed.map((row) => row.id), natural.map((row) => row.id));
  assert.equal(buildCanonicalTranscriptWithSegmentIds(reversed), buildCanonicalTranscriptWithSegmentIds(natural));
  const mapOf = (list: TranscriptTextSegment[]) => new Map(list.map((row) => [row.id, row as unknown as TranscriptSegment]));
  // A topic's segment ids can come back from the model in any order; ties straddle topics 0/1 and 2.
  for (const ids of [
    Array.from({ length: 60 }, (_, k) => segmentId(k)),
    [segmentId(50), segmentId(49), segmentId(48), segmentId(51)],
    [segmentId(151), segmentId(150), segmentId(149), segmentId(152)]
  ]) {
    const expected = buildTopicTranscript(ids, mapOf(natural));
    assert.equal(buildTopicTranscript([...ids].reverse(), mapOf(reversed)), expected);
    assert.ok(expected);
  }
});

test("[T15] conversation-event chunks (boundaries, members, transcripts) are identical for either tie order", () => {
  const natural = planConversationEventChunks(sourceFrom(rows()));
  const reversed = planConversationEventChunks(sourceFrom(reversedTies(rows())));
  assert.ok(natural.length > 3);
  assert.deepEqual(
    reversed.map((chunk) => [chunk.index, chunk.startSegment, chunk.endSegment, chunk.source.transcript]),
    natural.map((chunk) => [chunk.index, chunk.startSegment, chunk.endSegment, chunk.source.transcript])
  );
  // The tied pair keeps a defined, id-ordered position (49 before 50) wherever it lands.
  const transcript = sourceFrom(reversedTies(rows())).transcript;
  assert.ok(transcript.indexOf(segmentId(49)) < transcript.indexOf(segmentId(50)));
  assert.ok(transcript.indexOf(segmentId(149)) < transcript.indexOf(segmentId(150)));
  assert.ok(transcript.indexOf(segmentId(150)) < transcript.indexOf(segmentId(151)));
});
