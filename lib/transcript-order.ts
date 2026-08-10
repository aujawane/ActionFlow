/**
 * The single source of truth for "what order did these transcript segments actually happen in."
 *
 * `transcript_segments.timestamp` is not reliable for every meeting: for at least one real
 * meeting every row's `timestamp` collapsed to within a couple of milliseconds of each other
 * (a parse-time bug in `lib/recall/transcript.ts` that has since been fixed for new ingests --
 * see `asTimestamp`). Real chronological order is recoverable from Recall's own per-word
 * timestamps embedded in `raw_payload`, which this module prefers whenever present. Every stage
 * that assembles, displays, or evaluates a transcript must sort through here rather than trusting
 * a raw `.order("timestamp")` database query or UUID ordering.
 *
 * Priority (highest wins; a segment's key stops at the first tier where it has a trustworthy
 * value, so segments never mix tiers relative to one another -- ties within a tier fall through
 * to the next tier, and the final tier is the segment's original input-array position):
 *   1. An explicit persisted ordering field on the row itself (`segment_index`, `sequence`, or
 *      `order`), when present and numeric.
 *   2. Recall's per-word relative start offset: `raw_payload.words[0].start_timestamp.relative`.
 *   3. Another Recall-relative start field carried directly on the payload (some payload shapes
 *      put `start_timestamp` on the utterance itself rather than nested under `words`).
 *   4. A verified absolute Recall speech timestamp (`words[0].start_timestamp.absolute`, or an
 *      utterance-level `start_timestamp.absolute` / plain ISO string).
 *   5. `transcript_segments.timestamp`, as a last-resort fallback only.
 *   6. Original stable input order (array index), with the segment id as a final tie-breaker so
 *      the result is deterministic even for two segments with no ordering signal at all.
 */
import { buildTranscriptWithSegmentIds } from "@/lib/analysis";

export type OrderableTranscriptSegment = {
  id: string;
  timestamp?: string | null;
  raw_payload?: unknown;
  /** Not present in the current schema, but supported if a future ingest path adds one. */
  segment_index?: number | null;
  sequence?: number | null;
};

type SortKey = {
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  value: number;
  fallbackIndex: number;
  id: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Tier 1: an explicit, trustworthy persisted ordering field on the row itself. */
function extractPersistedIndex(segment: OrderableTranscriptSegment): number | null {
  return toFiniteNumber(segment.segment_index) ?? toFiniteNumber(segment.sequence) ?? null;
}

function firstWord(rawPayload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!rawPayload) return null;
  const words = rawPayload.words;
  if (!Array.isArray(words) || words.length === 0) return null;
  return asRecord(words[0]);
}

/** Tier 2: Recall's per-word relative offset -- the reliable signal when present. */
function extractWordRelativeStart(rawPayload: Record<string, unknown> | null): number | null {
  const word = firstWord(rawPayload);
  const start = asRecord(word?.start_timestamp);
  return toFiniteNumber(start?.relative);
}

/** Tier 3: a Recall-relative start carried directly on the utterance/payload, for payload
 * shapes that don't nest timing under a `words` array at all. */
function extractUtteranceRelativeStart(rawPayload: Record<string, unknown> | null): number | null {
  if (!rawPayload) return null;
  const direct = asRecord(rawPayload.start_timestamp);
  const fromDirect = toFiniteNumber(direct?.relative);
  if (fromDirect !== null) return fromDirect;
  return toFiniteNumber(rawPayload.relative_timestamp);
}

/** Tier 4: a verified absolute Recall speech timestamp, preferring the first word's absolute
 * start, then an utterance-level absolute/plain start_timestamp. */
function extractAbsoluteStart(rawPayload: Record<string, unknown> | null): number | null {
  const word = firstWord(rawPayload);
  const wordStart = asRecord(word?.start_timestamp);
  const wordAbsolute = toEpochMs(wordStart?.absolute);
  if (wordAbsolute !== null) return wordAbsolute;

  if (!rawPayload) return null;
  const utteranceStart = rawPayload.start_timestamp;
  const utteranceStartObject = asRecord(utteranceStart);
  const utteranceAbsolute = toEpochMs(utteranceStartObject?.absolute);
  if (utteranceAbsolute !== null) return utteranceAbsolute;
  // Some payload shapes carry start_timestamp as a plain ISO string / epoch number directly.
  return toEpochMs(utteranceStart);
}

function canonicalSortKey(segment: OrderableTranscriptSegment, fallbackIndex: number): SortKey {
  const rawPayload = asRecord(segment.raw_payload);

  const persistedIndex = extractPersistedIndex(segment);
  if (persistedIndex !== null) return { tier: 1, value: persistedIndex, fallbackIndex, id: segment.id };

  const wordRelative = extractWordRelativeStart(rawPayload);
  if (wordRelative !== null) return { tier: 2, value: wordRelative, fallbackIndex, id: segment.id };

  const utteranceRelative = extractUtteranceRelativeStart(rawPayload);
  if (utteranceRelative !== null) return { tier: 3, value: utteranceRelative, fallbackIndex, id: segment.id };

  const absolute = extractAbsoluteStart(rawPayload);
  if (absolute !== null) return { tier: 4, value: absolute, fallbackIndex, id: segment.id };

  const dbTimestamp = toEpochMs(segment.timestamp);
  if (dbTimestamp !== null) return { tier: 5, value: dbTimestamp, fallbackIndex, id: segment.id };

  return { tier: 6, value: fallbackIndex, fallbackIndex, id: segment.id };
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.value !== b.value) return a.value - b.value;
  if (a.fallbackIndex !== b.fallbackIndex) return a.fallbackIndex - b.fallbackIndex;
  // Only reached when two segments share a tier, a value, AND an (impossible in practice,
  // since fallbackIndex is unique per input array) input position -- id is the final,
  // fully-deterministic tie-breaker, never the primary signal.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sorts transcript segments into canonical chronological order. Stable, deterministic, and safe
 * to call on segments that mix ordering signals (e.g. some with real Recall timing, some
 * fixture/test segments with none) -- every stage in the product should call this exactly once,
 * as late as possible after fetching/loading segments, rather than trusting the order they
 * arrived in.
 */
export function canonicalTranscriptOrder<T extends OrderableTranscriptSegment>(segments: readonly T[]): T[] {
  const keyed = segments.map((segment, index) => ({ segment, key: canonicalSortKey(segment, index) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map((entry) => entry.segment);
}

export type TranscriptTextSegment = {
  id: string;
  speaker: string | null;
  text: string;
  timestamp: string;
  raw_payload?: unknown;
  /** For fixtures built from an export with no real Recall payload/UUIDs and a uniform displayed
   * timestamp: an explicit source-order index (tier 1) takes priority over the inert timestamp. */
  segment_index?: number | null;
};

/**
 * The one function that turns a set of transcript rows into the `[uuid] [iso-time] Speaker: text`
 * string every V4 pipeline stage (and topic segmentation) consumes as `ExecutionSourceContext.
 * transcript`. `lib/meeting-analysis/topics.ts` (production) and `scripts/eval-v4.ts` (replay)
 * both call this exact function on canonically-ordered segments, so a replay's transcript
 * ordering can never silently diverge from what production would have built for the same rows.
 */
export function buildCanonicalTranscriptWithSegmentIds(segments: readonly TranscriptTextSegment[]): string {
  return buildTranscriptWithSegmentIds(canonicalTranscriptOrder(segments));
}
