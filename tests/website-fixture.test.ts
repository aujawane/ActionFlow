import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import { canonicalTranscriptOrder, buildCanonicalTranscriptWithSegmentIds } from "../lib/transcript-order";

type FixtureSegment = {
  id: string;
  segment_index: number;
  speaker: string | null;
  text: string;
  timestamp: string;
  raw_payload?: unknown;
};

type Fixture = {
  version: string;
  meetingId: string;
  meetingDate: string;
  participants: string[];
  gate: string;
  expected: { commitment_titles: string[]; excluded_phrases: string[] };
  segments: FixtureSegment[];
};

function loadFixture(): Fixture {
  return JSON.parse(
    readFileSync(new URL("./fixtures/website-meeting-real.json", import.meta.url), "utf8")
  ) as Fixture;
}

// Deterministic, fixture-only, and UUID-shaped: every WorkItem.source_segment_ids field and every
// V4 stage's segment-boundary regex is Zod-validated as z.string().uuid() (see
// lib/execution-intelligence/work-item-schemas.ts, stages.ts's SEGMENT_LINE). A literal
// "website_segment_0001" fails that validation and gets silently dropped, producing zero
// extracted work items -- confirmed by an initial failed replay before this fix. The all-zero
// prefix plus monotonic hex suffix makes it unmistakably synthetic, never a real database UUID,
// while staying fully traceable back to source order via segment_index.
const SYNTHETIC_ID_PATTERN = /^00000000-0000-4000-8000-([0-9a-f]{12})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("website fixture: loads, targets the real Jamileh meeting, and is gated", () => {
  const fixture = loadFixture();
  assert.equal(fixture.meetingId, "5a9ce44b-f65a-49f2-b313-31402a56feb1");
  assert.equal(fixture.gate, "website");
  assert.ok(fixture.participants.includes("Aditya Ujawane"));
  assert.ok(fixture.participants.includes("Jamileh Hamideh"));
});

test("website fixture: every segment has a deterministic UUID-shaped id and a matching sequential segment_index", () => {
  const fixture = loadFixture();
  assert.ok(fixture.segments.length > 300, `expected a substantial real transcript, got ${fixture.segments.length} segments`);
  fixture.segments.forEach((segment, arrayIndex) => {
    assert.ok(UUID_PATTERN.test(segment.id), `segment id "${segment.id}" must be UUID-shaped to survive Zod's z.string().uuid() validation`);
    const match = segment.id.match(SYNTHETIC_ID_PATTERN);
    assert.ok(match, `segment id "${segment.id}" does not match the deterministic fixture-only pattern`);
    const expectedIndex = arrayIndex + 1;
    assert.equal(parseInt(match![1], 16), expectedIndex, `segment id ${segment.id} should encode index ${expectedIndex}`);
    assert.equal(segment.segment_index, expectedIndex, `segment_index should be ${expectedIndex} for ${segment.id}`);
  });
});

test("website fixture: every segment id passes the exact z.string().uuid() check every V4 WorkItem schema uses", () => {
  const fixture = loadFixture();
  const schema = z.string().uuid();
  for (const segment of fixture.segments) {
    assert.equal(schema.safeParse(segment.id).success, true, `segment id "${segment.id}" must pass z.string().uuid()`);
  }
});

test("website fixture: every turn shares the same displayed timestamp -- ordering must not depend on it", () => {
  const fixture = loadFixture();
  const distinctTimestamps = new Set(fixture.segments.map((s) => s.timestamp));
  assert.equal(distinctTimestamps.size, 1, "expected every segment to share one uninformative timestamp, per the source export");
});

test("website fixture: speaker turns and text are preserved verbatim, not paraphrased or reconstructed", () => {
  const fixture = loadFixture();
  const bySpeaker = new Set(fixture.segments.map((s) => s.speaker));
  assert.deepEqual(bySpeaker, new Set(["Aditya Ujawane", "Jamileh Hamideh"]));

  // Spot-check several exact, distinctive utterances against the known real transcript text --
  // these must match byte-for-byte, proving the text was not summarized or rewritten.
  const bodyText = fixture.segments.map((s) => s.text).join(" \n ");
  assert.ok(bodyText.includes("i'll deploy one because like the extraction layer is like still working") === false); // sanity: this is the Chatter meeting's line, must NOT leak in here
  assert.ok(bodyText.includes("like pastel green and violet"));
  assert.ok(bodyText.includes("i tried to do it like before august 1st"));
  assert.ok(bodyText.includes("we can just like link that to that and just push on versa"));
  assert.ok(bodyText.includes("do you like want to do like a subscription based model"));
  assert.ok(bodyText.includes("yeah instagram integrations do you want to do like a chatbot"));
  assert.ok(bodyText.includes("i can generate a few questions and i can send them to you and you can answer them"));
});

test("website fixture: canonical ordering is stable, deterministic, and idempotent", () => {
  const fixture = loadFixture();
  const transcript = buildCanonicalTranscriptWithSegmentIds(fixture.segments);
  assert.ok(transcript.length > 0);
  // Idempotent: re-ordering an already-canonical transcript's segments must not change anything.
  const reordered = buildCanonicalTranscriptWithSegmentIds(canonicalTranscriptOrder(fixture.segments));
  assert.equal(transcript, reordered);
});

test("website fixture: segment_index (tier 1) preserves exact source turn order even though every timestamp is identical", () => {
  const fixture = loadFixture();
  // Shuffle the segments before ordering -- canonicalTranscriptOrder must recover the original
  // source order purely from segment_index, since the (deliberately identical) timestamp field
  // carries no information for this fixture.
  const shuffled = [...fixture.segments].reverse();
  const ordered = canonicalTranscriptOrder(shuffled);
  assert.deepEqual(
    ordered.map((s) => s.id),
    fixture.segments.map((s) => s.id)
  );
});

test("website fixture: the later 'normal website first, e-commerce later' sequencing statement follows the earlier e-commerce/subscription discussion in canonical order", () => {
  const fixture = loadFixture();
  const transcript = buildCanonicalTranscriptWithSegmentIds(fixture.segments);
  const earlyEcommerceIndex = transcript.indexOf("yeah e-commerce as well");
  const laterSequencingIndex = transcript.indexOf("so we can do like a normal website first and");
  assert.ok(earlyEcommerceIndex >= 0, "expected to find the early e-commerce discussion in the transcript");
  assert.ok(laterSequencingIndex >= 0, "expected to find the later sequencing statement in the transcript");
  assert.ok(earlyEcommerceIndex < laterSequencingIndex);
});

test("website fixture: expected block names the one primary commitment and the components that must not become peer commitments", () => {
  const fixture = loadFixture();
  assert.equal(fixture.expected.commitment_titles.length, 1);
  assert.match(fixture.expected.commitment_titles[0], /informational website draft/i);
  for (const phrase of ["domain connection", "founder story preparation", "FAQ preparation", "Use an ecommerce website"]) {
    assert.ok(fixture.expected.excluded_phrases.includes(phrase), `expected excluded_phrases to include "${phrase}"`);
  }
});
