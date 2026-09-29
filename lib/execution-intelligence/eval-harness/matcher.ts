import { semanticTokenSimilarity } from "../graph";

/**
 * Deterministic, evidence-first matching between a ground-truth outcome and a pipeline-produced
 * candidate (a harvest candidate, an addition, or a final WorkItem). No LLM is used -- the task's
 * own instruction only requires LLM-based semantic matching to be structured/separate/
 * non-authoritative *if* one is used; deterministic evidence matching (segment overlap, owner
 * overlap, token-similarity against the same semanticTokenSimilarity primitive already used
 * throughout execution-intelligence for near-duplicate judgments) is sufficient here and keeps the
 * evaluator itself fully deterministic and re-runnable without incurring a model call.
 */

export type MatchCandidate = {
  /** Stable identifier for this candidate within its own collection (a canonicalRef, a WorkItem
   * ref, or a synthetic index) -- never re-derived, only threaded through for reporting. */
  id: string;
  title: string;
  description?: string | null;
  sourceQuote?: string | null;
  sourceSegmentIds: string[];
  owner?: string | null;
  owners?: string[];
};

export type GroundTruthMatchInput = {
  owners: string[];
  semanticOutcome: string;
  sourceSegmentIds: string[];
};

export type MatchConfidence = "high" | "medium" | "low" | "none";

export type MatchResult = {
  matched: boolean;
  confidence: MatchConfidence;
  reason: string;
  /** 0..1, informational only -- confidence tiers (not this score) drive matched/unmatched. */
  textSimilarity: number;
  segmentOverlap: boolean;
  ownerOverlap: boolean;
};

function normalizeOwner(value: string) {
  return value.trim().toLowerCase();
}

/** Owner overlap is intentionally lenient in two ways: (1) ANY shared owner, not all -- a
 * multi-owner ground-truth commitment (e.g. "Craig/Laura/Jay use the prototype") typically ends up
 * with only one of them recorded as the WorkItem's primary owner, with the others in `owners` or
 * dropped entirely by a single extraction pass; requiring full-set equality would make every
 * multi-owner GT item unmatchable by construction. (2) case-insensitive SUBSTRING match in either
 * direction, not exact equality -- the same real person is recorded inconsistently across
 * pipeline stages and generations ("Craig" vs "craiglauer" vs "Craig Lauer"; a ground-truth author
 * naming someone by first name only must still match a WorkItem recording their full handle). */
export function ownersOverlap(gtOwners: string[], candidateOwners: Array<string | null | undefined>): boolean {
  const gtNormalized = gtOwners.map(normalizeOwner).filter((o) => o.length > 0);
  const candidateNormalized = candidateOwners.filter((o): o is string => Boolean(o?.trim())).map(normalizeOwner);
  return gtNormalized.some((gtOwner) => candidateNormalized.some((co) => co.includes(gtOwner) || gtOwner.includes(co)));
}

export function segmentsOverlap(gtSegmentIds: string[], candidateSegmentIds: string[]): boolean {
  if (gtSegmentIds.length === 0 || candidateSegmentIds.length === 0) return false;
  const gtSet = new Set(gtSegmentIds);
  return candidateSegmentIds.some((id) => gtSet.has(id));
}

function candidateOwnerList(candidate: MatchCandidate): Array<string | null | undefined> {
  return [candidate.owner, ...(candidate.owners ?? [])];
}

/**
 * Scores one ground-truth outcome against one candidate. Evidence-tiered, most-confident first:
 *   1. shared source segment + at least weak text similarity -> high confidence (the strongest
 *      possible signal: the candidate is grounded in the exact evidence the human cited).
 *   2. shared source segment + owner overlap, even with weak text similarity -> medium (the
 *      candidate is grounded in the right place and the right person, even if phrased very
 *      differently than the GT author's own words).
 *   3. no segment hint available (GT author didn't pin one) but strong text similarity AND owner
 *      overlap -> medium.
 *   4. very strong text similarity alone (title/quote is close to a direct paraphrase) -> low.
 * Anything weaker is not a match -- prefer a false "missed" (visible, reviewable) over a false
 * "correct" (invisible, unreviewable).
 */
export function scoreMatch(groundTruth: GroundTruthMatchInput, candidate: MatchCandidate): MatchResult {
  const segmentOverlap = segmentsOverlap(groundTruth.sourceSegmentIds, candidate.sourceSegmentIds);
  const ownerOverlap = ownersOverlap(groundTruth.owners, candidateOwnerList(candidate));
  const textSimilarity = Math.max(
    semanticTokenSimilarity(groundTruth.semanticOutcome, candidate.title),
    candidate.sourceQuote ? semanticTokenSimilarity(groundTruth.semanticOutcome, candidate.sourceQuote) : 0,
    candidate.description ? semanticTokenSimilarity(groundTruth.semanticOutcome, candidate.description) : 0
  );

  if (segmentOverlap && textSimilarity >= 0.15) {
    return { matched: true, confidence: "high", reason: "shared source segment and matching text", textSimilarity, segmentOverlap, ownerOverlap };
  }
  // Segment + owner alone, with too low a text-similarity floor, would match every candidate on a
  // shared segment to every sub-outcome of a compound GT item that cites that same segment --
  // exactly the GT3-B structural pattern (multiple genuinely distinct outcomes, one segment, one
  // speaker). A single shared CONTEXTUAL word (e.g. two unrelated sub-actions from the same
  // "entrepreneurship cohort" turn both mentioning "entrepreneurship") is not evidence of the same
  // outcome -- 0.2 is calibrated above that single-incidental-word floor (~0.08-0.12 for
  // medium-length titles) while staying below genuine-paraphrase similarity (~0.25-0.5 in this same
  // test suite's own high-confidence cases).
  if (segmentOverlap && ownerOverlap && textSimilarity >= 0.2) {
    return { matched: true, confidence: "medium", reason: "shared source segment and owner, with meaningful text overlap", textSimilarity, segmentOverlap, ownerOverlap };
  }
  if (groundTruth.sourceSegmentIds.length === 0 && textSimilarity >= 0.45 && ownerOverlap) {
    return {
      matched: true,
      confidence: "medium",
      reason: "no evidence segment on record; strong text similarity plus owner match",
      textSimilarity,
      segmentOverlap,
      ownerOverlap
    };
  }
  if (textSimilarity >= 0.6) {
    return { matched: true, confidence: "low", reason: "text similarity alone crossed the strict threshold", textSimilarity, segmentOverlap, ownerOverlap };
  }
  return { matched: false, confidence: "none", reason: "insufficient evidence overlap", textSimilarity, segmentOverlap, ownerOverlap };
}

/** Scores a ground-truth outcome against every candidate in a collection and returns matches,
 * best (highest-confidence, then highest textSimilarity) first. */
export function findMatches<T extends MatchCandidate>(
  groundTruth: GroundTruthMatchInput,
  candidates: readonly T[]
): Array<{ candidate: T; result: MatchResult }> {
  const confidenceRank: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };
  return candidates
    .map((candidate) => ({ candidate, result: scoreMatch(groundTruth, candidate) }))
    .filter((entry) => entry.result.matched)
    .sort(
      (a, b) =>
        confidenceRank[b.result.confidence] - confidenceRank[a.result.confidence] ||
        b.result.textSimilarity - a.result.textSimilarity
    );
}
