/**
 * Every limit the manual transcript import applies, in one place.
 *
 * Text size: 1 MiB of UTF-8 is roughly 170,000 words, i.e. far longer than any real meeting
 * transcript (a dense hour is ~10,000 words). It also stays well under Vercel's 4.5 MB request
 * body limit for Functions even with multipart overhead, so the server, not the platform, is the
 * one that rejects an oversized input, with a clear error.
 */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

/** Upper bound on the whole HTTP body (transcript plus form fields and multipart framing). */
export const MAX_IMPORT_REQUEST_BYTES = MAX_TRANSCRIPT_BYTES + 64 * 1024;

/**
 * Segment length. The analysis pipeline chunks by segment COUNT, not by characters
 * (lib/execution-intelligence/chunking.ts: 40-50 segments per chunk, 5 overlap), so a single
 * unbounded pasted paragraph would make one chunk arbitrarily large. Recall utterances are a
 * sentence or a few; 700 characters keeps a 50-segment chunk under ~35,000 characters while
 * leaving normal turns intact. A text already within the limit is never split.
 */
export const MAX_SEGMENT_CHARS = 700;

/**
 * Consecutive subtitle cues from the same speaker are joined back into one turn up to this many
 * characters. Subtitle files cut speech into 1-2 line cues; joining them gives turns of a similar
 * size to Recall's, without ever exceeding MAX_SEGMENT_CHARS.
 */
export const CUE_MERGE_TARGET_CHARS = 500;

/**
 * Explicit rejection (never truncation) for a pathological input, e.g. 1 MiB of one-word lines.
 * A real hour-long meeting produces well under 2,000 segments; this bounds the size of the single
 * transactional replace call.
 */
export const MAX_IMPORT_SEGMENTS = 20_000;

/** Durable per-user creation limits, counted from meetings rows (not in memory). */
export const IMPORTS_PER_HOUR = 10;
export const IMPORTS_PER_DAY = 30;

/**
 * How long an import's claim on its meeting counts as live. The import route's maxDuration is 60
 * seconds; after this window a crashed attempt's claim is treated as abandoned and a retry with
 * the same import id may recover the meeting.
 */
export const IMPORT_CLAIM_STALE_AFTER_MS = 3 * 60 * 1000;

/** Bumped when parsing behaviour changes, and recorded on every imported segment. */
export const TRANSCRIPT_IMPORT_PARSER_VERSION = 1;
