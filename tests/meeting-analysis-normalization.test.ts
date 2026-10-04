import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyTokenReplacement,
  chunkSegmentsForNormalization,
  mergeSegmentNormalization,
  normalizeMeetingTranscriptForAnalysis,
  resolveSegmentPersistence,
  NORMALIZATION_BATCH_OVERLAP,
  NORMALIZATION_BATCH_SIZE
} from "../lib/meeting-analysis/normalization";
import type { TranscriptCorrectionRecord } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function correction(overrides: Partial<TranscriptCorrectionRecord> = {}): TranscriptCorrectionRecord {
  return {
    original_token: overrides.original_token ?? "versailles",
    replacement: overrides.replacement ?? "Vercel",
    confidence: overrides.confidence ?? 0.97,
    reason: overrides.reason ?? "matches known project vocabulary",
    source: overrides.source ?? "model",
    applied: overrides.applied ?? true
  };
}

// ---------------------------------------------------------------------------
// Chunking strategy
// ---------------------------------------------------------------------------

test("a short transcript (under the batch size) is a single batch -- no unnecessary splitting", () => {
  const segments = Array.from({ length: 10 }, (_, i) => ({ id: `seg-${i}` }));
  const batches = chunkSegmentsForNormalization(segments);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 10);
});

test("a long transcript is split into overlapping batches around NORMALIZATION_BATCH_SIZE", () => {
  const segments = Array.from({ length: 130 }, (_, i) => ({ id: `seg-${i}` }));
  const batches = chunkSegmentsForNormalization(segments);
  assert.ok(batches.length > 1);
  for (const batch of batches) assert.ok(batch.length <= NORMALIZATION_BATCH_SIZE + NORMALIZATION_BATCH_OVERLAP);
  // Every segment appears in at least one batch -- no gaps.
  const covered = new Set(batches.flat().map((s: { id: string }) => s.id));
  assert.equal(covered.size, 130);
});

test("adjacent batches overlap by NORMALIZATION_BATCH_OVERLAP so a boundary segment has neighbors on both sides", () => {
  const segments = Array.from({ length: 90 }, (_, i) => ({ id: `seg-${i}` }));
  const batches = chunkSegmentsForNormalization(segments);
  assert.ok(batches.length >= 2);
  const firstIds = new Set(batches[0].map((s: { id: string }) => s.id));
  const secondIds = batches[1].map((s: { id: string }) => s.id);
  const overlapCount = secondIds.filter((id: string) => firstIds.has(id)).length;
  assert.ok(overlapCount > 0, "expected some overlap between consecutive batches");
});

test("an empty transcript yields zero batches, not a crash", () => {
  assert.deepEqual(chunkSegmentsForNormalization([]), []);
});

// ---------------------------------------------------------------------------
// applyTokenReplacement: first-occurrence only, safe no-op if token already gone
// ---------------------------------------------------------------------------

test("applyTokenReplacement replaces only the first occurrence of the token", () => {
  const result = applyTokenReplacement("versailles versailles", "versailles", "Vercel");
  assert.equal(result, "Vercel versailles");
});

test("applyTokenReplacement is a safe no-op when the token is already gone (duplicate/overlap-safe)", () => {
  const result = applyTokenReplacement("Vercel already here", "versailles", "Vercel");
  assert.equal(result, "Vercel already here");
});

// ---------------------------------------------------------------------------
// [9][19] mergeSegmentNormalization: the exact persisted merge logic, pure and idempotent
// ---------------------------------------------------------------------------

test("[9] a high-confidence applied correction produces normalized_text different from the raw original", () => {
  const outcome = mergeSegmentNormalization({
    originalText: "i deployed it on versailles",
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: [correction({ confidence: 0.98, applied: true })]
  });
  assert.equal(outcome.normalizedText, "i deployed it on Vercel");
  assert.equal(outcome.corrections.length, 1);
});

// ---------------------------------------------------------------------------
// [10] a low-confidence correction remains unchanged in the normalized transcript, but is still
// recorded in the correction trace for review.
// ---------------------------------------------------------------------------

test("[10] a below-threshold correction (applied=false) never touches normalized_text, but is preserved in corrections", () => {
  const outcome = mergeSegmentNormalization({
    originalText: "i think it was called somewareplace",
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: [correction({ original_token: "somewareplace", replacement: "SomeProduct", confidence: 0.4, applied: false })]
  });
  assert.equal(outcome.normalizedText, null);
  assert.equal(outcome.corrections.length, 1);
  assert.equal(outcome.corrections[0].applied, false);
});

// ---------------------------------------------------------------------------
// [10][correction metadata] every correction points back to raw text via original_token/reason
// ---------------------------------------------------------------------------

test("[10] correction metadata always carries the original raw token, the replacement, confidence, and reason -- a full audit trail back to the raw wording", () => {
  const outcome = mergeSegmentNormalization({
    originalText: "i deployed it on versailles",
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: [correction()]
  });
  const record = outcome.corrections[0];
  assert.equal(record.original_token, "versailles");
  assert.equal(record.replacement, "Vercel");
  assert.ok(typeof record.confidence === "number");
  assert.ok(record.reason.length > 0);
  assert.ok(["deterministic", "model"].includes(record.source));
});

// ---------------------------------------------------------------------------
// [20] duplicate normalization run does not create duplicate corrections/data structures.
//
// NOTE on what this proves and what it does NOT: mergeSegmentNormalization and
// resolveSegmentPersistence are pure functions of their inputs -- calling either twice with the
// exact same corrections list always yields the exact same persisted patch (no duplication, no
// accumulation, no hidden state). This is STRUCTURAL idempotency of the persistence mechanism.
// It is NOT a claim that the underlying LLM is deterministic -- a real second normalization run
// may call the model again and receive different proposed corrections than the first run. This
// suite never asserts that; it only asserts that whatever corrections a run produces are merged
// and persisted the same safe way every time.
// ---------------------------------------------------------------------------

test("[20] calling mergeSegmentNormalization twice with the identical (already-decided) corrections list produces an identical result -- proves the merge step itself has no hidden state, not that the LLM is deterministic", () => {
  const input = {
    originalText: "i deployed it on versailles",
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: [correction()]
  };
  const first = mergeSegmentNormalization(input);
  const second = mergeSegmentNormalization(input);
  assert.deepEqual(first, second);
});

test("deterministic and model corrections both apply in one merge, deterministic first", () => {
  const outcome = mergeSegmentNormalization({
    originalText: "codecs made it, versailles hosts it",
    deterministicText: "codecs made it, Vercel hosts it",
    deterministicCorrections: [correction({ original_token: "versailles", replacement: "Vercel", source: "deterministic" })],
    modelCorrections: [correction({ original_token: "codecs", replacement: "Codex", confidence: 0.95, applied: true })]
  });
  assert.equal(outcome.normalizedText, "Codex made it, Vercel hosts it");
  assert.equal(outcome.corrections.length, 2);
});

// ---------------------------------------------------------------------------
// [18] normalization failure never blocks / corrupts the transcript -- disabled-flag fast path
// proves no DB call is even attempted when off, and by extension a model failure never touches
// transcript_segments.text (see the source-pattern checks below for the failure branch itself).
// ---------------------------------------------------------------------------

test("[18][7] normalization is a fast, safe no-op when TRANSCRIPT_NORMALIZATION_ENABLED is unset -- no DB call, no throw, even for a nonexistent meeting id", async () => {
  const originalValue = process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
  delete process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
  try {
    const result = await normalizeMeetingTranscriptForAnalysis("00000000-0000-0000-0000-000000000000");
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "disabled");
    assert.equal(result.segmentCount, 0);
  } finally {
    if (originalValue === undefined) delete process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
    else process.env.TRANSCRIPT_NORMALIZATION_ENABLED = originalValue;
  }
});

test("[18] a failed batch is skipped, not thrown -- segments in it keep their raw text (normalized_text stays null)", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  const fnMatch = source.match(/export async function normalizeMeetingTranscriptForAnalysis\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /if \(!result\.ok\) \{[\s\S]{0,500}continue;/);
  assert.doesNotMatch(fnMatch![0], /if \(!result\.ok\) \{[\s\S]{0,100}throw/);
});

test("transcript_segments.text is never written by the normalization persistence step -- only the new derived columns", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  const updateBlocks = source.match(/\.update\(patch\)|\.update\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(updateBlocks.length > 0);
  for (const block of updateBlocks) {
    assert.doesNotMatch(block, /\btext:/);
    assert.doesNotMatch(block, /\bspeaker:/);
    assert.doesNotMatch(block, /\btimestamp:/);
  }
});

// ---------------------------------------------------------------------------
// [Fix 1] resolveSegmentPersistence: distinguishes A (succeeded, no correction) / B (succeeded,
// corrected) / C (attempted but failed) -- the real bug this fixes was that a failed batch
// previously left a segment indistinguishable from case A (normalized_at got set either way).
// ---------------------------------------------------------------------------

const NOW = "2026-09-06T00:00:00.000Z";

test("[Fix 1][A vs C] a successful no-op (nothing to correct) is persisted differently from a failed attempt, even though both leave normalized_text null", () => {
  const caseA = resolveSegmentPersistence({
    succeeded: true,
    outcome: { normalizedText: null, corrections: [] },
    now: NOW
  });
  const caseC = resolveSegmentPersistence({
    succeeded: false,
    outcome: { normalizedText: null, corrections: [] },
    now: NOW
  });

  assert.equal(caseA.normalized_text, null);
  assert.equal(caseC.normalized_text, null);
  // Both leave normalized_text null, but they are NOT the same persisted state:
  assert.equal(caseA.normalized_at, NOW);
  assert.equal(caseA.normalization_failed_at, null);
  assert.equal(caseC.normalized_at, null);
  assert.equal(caseC.normalization_failed_at, NOW);
  assert.notDeepEqual(caseA, caseC);
});

test("[Fix 1][B] a successful attempt with an applied correction sets normalized_text and normalized_at, clears any prior failure marker", () => {
  const caseB = resolveSegmentPersistence({
    succeeded: true,
    outcome: { normalizedText: "i deployed it on Vercel", corrections: [correction()] },
    now: NOW
  });
  assert.equal(caseB.normalized_text, "i deployed it on Vercel");
  assert.equal(caseB.normalized_at, NOW);
  assert.equal(caseB.normalization_failed_at, null);
  assert.equal(caseB.normalization_corrections?.length, 1);
});

test("[Fix 1][C] a failed batch retains raw effective text -- normalized_text is null and normalized_at is left unset (not 'processed')", () => {
  const failed = resolveSegmentPersistence({
    succeeded: false,
    outcome: { normalizedText: null, corrections: [] },
    now: NOW
  });
  assert.equal(failed.normalized_text, null);
  assert.equal(failed.normalized_at, null);
  assert.equal(failed.normalization_failed_at, NOW);
});

test("[Fix 1][C] a failed LLM batch still persists any independent deterministic correction -- the model failing doesn't discard work that never depended on it", () => {
  const failed = resolveSegmentPersistence({
    succeeded: false,
    outcome: {
      normalizedText: "i deployed it on Vercel",
      corrections: [correction({ source: "deterministic", reason: "Matches an approved project vocabulary alias." })]
    },
    now: NOW
  });
  assert.equal(failed.normalized_text, "i deployed it on Vercel");
  assert.equal(failed.normalized_at, null);
  assert.equal(failed.normalization_failed_at, NOW);
});

test("[Fix 1] a failed attempt (case C) can be normalized successfully on a subsequent run -- normalized_at null after failure means retry-eligible, and a later success clears normalization_failed_at", () => {
  const firstAttempt = resolveSegmentPersistence({
    succeeded: false,
    outcome: { normalizedText: null, corrections: [] },
    now: "2026-09-06T00:00:00.000Z"
  });
  assert.equal(firstAttempt.normalized_at, null, "must remain eligible for retry after a failure");

  // A subsequent run (e.g. a re-analysis) reprocesses every segment regardless of prior state --
  // this time the LLM call succeeds.
  const secondAttempt = resolveSegmentPersistence({
    succeeded: true,
    outcome: { normalizedText: "i deployed it on Vercel", corrections: [correction()] },
    now: "2026-09-06T01:00:00.000Z"
  });
  assert.equal(secondAttempt.normalized_text, "i deployed it on Vercel");
  assert.equal(secondAttempt.normalized_at, "2026-09-06T01:00:00.000Z");
  assert.equal(secondAttempt.normalization_failed_at, null, "the earlier failure marker must be cleared once retried successfully");
});

test("[Fix 1] successfully-normalized segments remain idempotent -- persisting the same successful outcome twice produces the identical patch (structural idempotency, not a claim about LLM determinism -- see the note above [20])", () => {
  const outcome = { normalizedText: "i deployed it on Vercel", corrections: [correction()] };
  const first = resolveSegmentPersistence({ succeeded: true, outcome, now: NOW });
  const second = resolveSegmentPersistence({ succeeded: true, outcome, now: NOW });
  assert.deepEqual(first, second);
});

test("normalizeMeetingTranscriptForAnalysis tracks per-segment success (not just a global failure flag) so a segment covered by one failed and one successful overlapping batch counts as succeeded", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(source, /const segmentSucceeded = new Map<string, boolean>\(\);/);
  assert.match(source, /for \(const segmentId of segmentIdsInBatch\) segmentSucceeded\.set\(segmentId, true\);/);
});

test("the persistence loop uses resolveSegmentPersistence's succeeded flag rather than assuming success", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(source, /const succeeded = segmentSucceeded\.get\(segment\.id\) === true;/);
  assert.match(source, /resolveSegmentPersistence\(\{ succeeded, outcome, now \}\)/);
});

// ---------------------------------------------------------------------------
// [15] segmentation/speaker/timestamp preserved -- normalization only ever reads .text to build
// its correction, never reassigns id/speaker/timestamp on the in-memory segment objects either.
// ---------------------------------------------------------------------------

test("[15] normalization's own segment mapping only overrides .text, preserving id/speaker/timestamp", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(source, /ordered\.map\(\(segment\) => \(\{\s*\.\.\.segment,\s*text: deterministic\.correctedText\.get\(segment\.id\) \?\? segment\.text\s*\}\)\)/);
});

// ---------------------------------------------------------------------------
// Stage wiring: transcript_normalization runs first, before topic_extraction
// ---------------------------------------------------------------------------

test("transcript_normalization is the first stage, before topic_extraction", async () => {
  const { ANALYSIS_STAGE_ORDER } = await import("../lib/meeting-analysis/jobs");
  assert.equal(ANALYSIS_STAGE_ORDER[0], "transcript_normalization");
  assert.equal(ANALYSIS_STAGE_ORDER[1], "topic_extraction");
});

test("worker.ts dispatches transcript_normalization to normalizeMeetingTranscriptForAnalysis before the topic_extraction branch", async () => {
  const source = await readSource("lib/meeting-analysis/worker.ts");
  const normalizationIndex = source.indexOf('input.stage === "transcript_normalization"');
  const topicExtractionIndex = source.indexOf('input.stage === "topic_extraction"');
  assert.ok(normalizationIndex > -1 && topicExtractionIndex > -1);
  assert.ok(normalizationIndex < topicExtractionIndex);
  assert.match(source, /import \{ normalizeMeetingTranscriptForAnalysis \} from "@\/lib\/meeting-analysis\/normalization";/);
});

// ---------------------------------------------------------------------------
// [4][16] downstream consumers use normalized text after successful normalization
// ---------------------------------------------------------------------------

test("[4][16] prepareMeetingAnalysis (shared by every downstream stage/engine) prefers normalized_text over raw text", async () => {
  const source = await readSource("lib/meeting-analysis/topics.ts");
  assert.match(source, /text: segment\.normalized_text \?\? segment\.text/);
});

test("[1][17] raw text remains the fallback -- prepareMeetingAnalysis never requires normalized_text to exist", async () => {
  const source = await readSource("lib/meeting-analysis/topics.ts");
  assert.match(source, /segment\.normalized_text \?\? segment\.text/);
});

// ---------------------------------------------------------------------------
// V4 pipeline no longer makes a second, duplicate normalization model call
// ---------------------------------------------------------------------------

test("v4-pipeline no longer calls normalizeTranscriptSafely -- normalization now runs exactly once, upstream", async () => {
  const source = await readSource("lib/execution-intelligence/v4-pipeline.ts");
  assert.doesNotMatch(source, /import \{ normalizeTranscriptSafely/);
  assert.doesNotMatch(source, /await normalizeTranscriptSafely\(/);
});

// ---------------------------------------------------------------------------
// [21] historical meetings are not bulk-reprocessed by the migration or by deployment
// ---------------------------------------------------------------------------

test("[21] no script/migration bulk-invokes normalizeMeetingTranscriptForAnalysis across existing meetings", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.doesNotMatch(migration, /^update /im);
  assert.doesNotMatch(migration, /^insert into public\.transcript_segments/im);
});

// ---------------------------------------------------------------------------
// [22] prompt explicitly forbids paraphrasing/rewording/summarizing
// ---------------------------------------------------------------------------

test("[22] the normalization system prompt explicitly forbids paraphrasing, summarizing, and grammar/filler cleanup", async () => {
  const source = await readSource("lib/execution-intelligence/work-item-prompts.ts");
  assert.match(source, /paraphrase, summarize, or reword/);
  assert.match(source, /fix grammar, filler words/);
  assert.match(source, /never turn a literal, ordinary use of "recall"/);
});

test("the prompt instructs the model to emit vocabulary_candidates for unfamiliar-but-unconfirmed terms instead of silently correcting them", async () => {
  const source = await readSource("lib/execution-intelligence/work-item-prompts.ts");
  assert.match(source, /vocabulary_candidates entry/);
  assert.match(source, /ambiguous unknown proper noun with no supporting context should be left alone entirely/);
});
