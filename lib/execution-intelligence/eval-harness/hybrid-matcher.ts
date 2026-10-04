import {
  ownersOverlap,
  scoreMatch,
  segmentsOverlap,
  type GroundTruthMatchInput,
  type MatchCandidate,
  type MatchResult
} from "./matcher";
import {
  runBatchSemanticAdjudication,
  type RetrievalFeatureSummary,
  type SemanticAdjudicationResult,
  type SemanticBatchAdjudicationRequest,
  type SemanticBatchCandidate,
  type SemanticBatchDecision,
  type SemanticBatchJudge
} from "./semantic-judge";

/**
 * Hybrid matching architecture -- retrieval-hardening pass. The first version's `retrieveCandidates`
 * used broad OR-logic (segment OR owner OR textSimilarity>0.05), which in a small multi-person
 * meeting retrieved 46-79 of a ~82-item ledger for a SINGLE GT sub-outcome (owner overlap alone
 * matched almost everything, and the 0.05 text-similarity floor was cleared by incidental shared
 * words like "the"). Retrieval is no longer a yes/no filter -- it is now three explicit stages:
 *
 *   1. DISCOVERY + DETERMINISTIC MATCH (unchanged, precise): every candidate in the full ledger is
 *      scored by matcher.ts's existing, unchanged confidence tiers. A deterministic match is decided
 *      immediately and never touches the judge -- an obvious match costs nothing extra.
 *   2. RANKING (new): every remaining (non-deterministically-matched) candidate gets an explicit,
 *      documented retrieval-feature score (see `rankScore` below) -- segment overlap and pipeline
 *      trace linkage rank far above owner overlap alone, and owner overlap alone can never clear the
 *      shortlist floor by itself.
 *   3. SHORTLISTING (new): only the top-K ranked candidates whose score clears a minimum floor are
 *      sent to the judge -- bounded, so cost/latency no longer scale with ledger size.
 *   4. BATCHED SEMANTIC ADJUDICATION (new): ONE model call per GT (sub-)outcome classifies the whole
 *      shortlist at once (see semantic-judge.ts), instead of one call per candidate.
 */

export type RetrievalFeatures = RetrievalFeatureSummary;

/** Segment overlap and pipeline-trace linkage are the two signals that directly tie a candidate to
 * the GT author's own declared evidence -- they dominate the score. Text similarity is a real but
 * weaker continuous signal (scaled 0..50). Owner overlap is DELIBERATELY the smallest, fixed
 * contribution: in a meeting with only a handful of distinct participants, "same owner" is true of a
 * large fraction of the entire ledger and must never, by itself, be enough to reach the judge (the
 * root cause of the original 46-79-candidate blowups -- see docs cited in the hardening report). */
const SEGMENT_OVERLAP_SCORE = 100;
const PASS_LINKAGE_SCORE = 60;
const TEXT_SIMILARITY_SCALE = 50;
const OWNER_OVERLAP_SCORE = 5;

/** Candidates scoring below this floor never reach the judge. Calibrated so that owner-overlap-alone
 * (score 5) and weak-text-alone (textSimilarity <= ~0.19, score <= 9-10) are both excluded as
 * "obvious non-matches", while owner overlap COMBINED with even modest text similarity (>= ~0.15,
 * 5 + 8 = 13), or text similarity alone once it becomes genuinely meaningful (>= 0.2, score 10), can
 * still surface -- see hybrid-matcher.test cases and the hardening report's audit numbers. */
export const MIN_SHORTLIST_SCORE = 10;

/** Bounded so cost/latency never scale with ledger size. Chosen from live-audit evidence: across the
 * Craig Gen13 ledger (~82 items), the maximum number of genuinely evidence-linked (segment or
 * pass-trace) candidates for any single GT sub-outcome was 4 (GT6); 6 leaves headroom for a couple of
 * additional high-text-similarity candidates without segment/trace linkage (the theoretical
 * "GT2-class" case) while still cutting real call volume by roughly an order of magnitude. */
export const SHORTLIST_BOUND = 6;

export type RankedCandidate<T extends MatchCandidate> = {
  candidate: T;
  features: RetrievalFeatures;
  score: number;
};

export function computeRetrievalFeatures<T extends MatchCandidate>(
  groundTruth: GroundTruthMatchInput,
  candidate: T,
  passLinkedRefs: ReadonlySet<string>
): RetrievalFeatures {
  const segmentOverlap = segmentsOverlap(groundTruth.sourceSegmentIds, candidate.sourceSegmentIds);
  const ownerOverlap = ownersOverlap(groundTruth.owners, [candidate.owner, ...(candidate.owners ?? [])]);
  const textSimilarity = scoreMatch(groundTruth, candidate).textSimilarity;
  const passLinkage = passLinkedRefs.has(candidate.id);
  return { segmentOverlap, passLinkage, textSimilarity, ownerOverlap };
}

export function rankScore(features: RetrievalFeatures): number {
  return (
    (features.segmentOverlap ? SEGMENT_OVERLAP_SCORE : 0) +
    (features.passLinkage ? PASS_LINKAGE_SCORE : 0) +
    Math.round(features.textSimilarity * TEXT_SIMILARITY_SCALE) +
    (features.ownerOverlap ? OWNER_OVERLAP_SCORE : 0)
  );
}

/** Ranks EVERY candidate (no pre-filtering) by its retrieval-feature score, highest first. Ranking
 * alone is never a match decision -- callers apply the shortlist bound/floor separately. */
export function rankCandidates<T extends MatchCandidate>(
  groundTruth: GroundTruthMatchInput,
  candidates: readonly T[],
  passLinkedRefs: ReadonlySet<string> = new Set()
): Array<RankedCandidate<T>> {
  return candidates
    .map((candidate) => {
      const features = computeRetrievalFeatures(groundTruth, candidate, passLinkedRefs);
      return { candidate, features, score: rankScore(features) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Applies the shortlist bound/floor to an already-ranked list. */
export function shortlistCandidates<T extends MatchCandidate>(
  ranked: ReadonlyArray<RankedCandidate<T>>,
  options: { bound?: number; minScore?: number } = {}
): Array<RankedCandidate<T>> {
  const bound = options.bound ?? SHORTLIST_BOUND;
  const minScore = options.minScore ?? MIN_SHORTLIST_SCORE;
  return ranked.filter((r) => r.score >= minScore).slice(0, bound);
}

export type CandidateResolution<T extends MatchCandidate> = {
  candidate: T;
  deterministic: MatchResult;
  features: RetrievalFeatures | null;
  semantic: SemanticAdjudicationResult | null;
  semanticRequested: boolean;
  resolvedVia: "deterministic" | "semantic" | "unresolved";
  status: "matched" | "partial" | "needs_review" | "unmatched";
};

export type HybridMatchOutcome<T extends MatchCandidate> = {
  /** Every candidate considered at all (the full ledger passed in). */
  discoveredCount: number;
  /** How many cleared the shortlist floor and were sent to the judge (0 if none needed judging). */
  shortlistCount: number;
  /** 1 if the batched judge was actually called for this sub-outcome, 0 otherwise. */
  judgeCallCount: number;
  /** True if the judge's internal missing-ref retry fired for this sub-outcome. */
  judgeRetried: boolean;
  /** Count of shortlisted candidates whose final decision came from the judge's fail-safe path. */
  judgeFailureCount: number;
  /** Every candidate this outcome actually resolved a verdict for -- deterministic matches plus the
   * shortlist (NOT the full discovered set, so trace/report output stays bounded). */
  resolutions: Array<CandidateResolution<T>>;
};

function mapSemanticToStatus(result: SemanticAdjudicationResult): "matched" | "partial" | "needs_review" | "unmatched" {
  switch (result.match) {
    case "same":
      return "matched";
    case "partial":
      return "partial";
    case "ambiguous":
      return "needs_review";
    case "different":
      return "unmatched";
  }
}

function toBatchCandidate(ranked: RankedCandidate<MatchCandidate>): SemanticBatchCandidate {
  return {
    candidateRef: ranked.candidate.id,
    title: ranked.candidate.title,
    owner: ranked.candidate.owner ?? null,
    sourceQuote: ranked.candidate.sourceQuote ?? null,
    sourceSegmentIds: ranked.candidate.sourceSegmentIds,
    retrievalFeatures: ranked.features
  };
}

/**
 * Resolves a ground-truth (sub-)outcome against a full candidate ledger through all layers:
 * deterministic match -> ranking -> shortlist -> (optional) ONE batched judge call. `judge` is
 * optional and DI-injectable -- when omitted, a would-be-shortlisted candidate is still reported
 * (so its existence is never hidden) but left `resolvedVia: "unresolved"` / `status: "unmatched"`
 * rather than forcing a model call; the CLI wires a real judge, tests wire a fake one, and omitting
 * it entirely degrades gracefully to deterministic-only behavior.
 */
export async function resolveCoverage<T extends MatchCandidate>(input: {
  groundTruth: GroundTruthMatchInput;
  candidates: readonly T[];
  isSubOutcome: boolean;
  evidenceText: string | null;
  passLinkedRefs?: ReadonlySet<string>;
  judge?: SemanticBatchJudge;
  shortlistBound?: number;
  minShortlistScore?: number;
}): Promise<HybridMatchOutcome<T>> {
  const passLinkedRefs = input.passLinkedRefs ?? new Set<string>();

  const deterministicMatches: Array<CandidateResolution<T>> = [];
  const remaining: T[] = [];
  for (const candidate of input.candidates) {
    const deterministic = scoreMatch(input.groundTruth, candidate);
    if (deterministic.matched) {
      deterministicMatches.push({
        candidate,
        deterministic,
        features: null,
        semantic: null,
        semanticRequested: false,
        resolvedVia: "deterministic",
        status: "matched"
      });
    } else {
      remaining.push(candidate);
    }
  }

  const ranked = rankCandidates(input.groundTruth, remaining, passLinkedRefs);
  const shortlist = shortlistCandidates(ranked, { bound: input.shortlistBound, minScore: input.minShortlistScore });

  const belowShortlistByRef = new Map(ranked.map((r) => [r.candidate.id, r]));
  for (const s of shortlist) belowShortlistByRef.delete(s.candidate.id);

  let judgeCallCount = 0;
  let judgeRetried = false;
  let judgeFailureCount = 0;
  const shortlistResolutions: Array<CandidateResolution<T>> = [];

  if (shortlist.length > 0 && input.judge) {
    const request: SemanticBatchAdjudicationRequest = {
      groundTruth: {
        outcomeText: input.groundTruth.semanticOutcome,
        isSubOutcome: input.isSubOutcome,
        owners: input.groundTruth.owners,
        evidenceText: input.evidenceText,
        evidenceSegmentIds: input.groundTruth.sourceSegmentIds
      },
      candidates: shortlist.map((r) => toBatchCandidate(r as RankedCandidate<MatchCandidate>))
    };
    judgeCallCount = 1;
    const outcome = await input.judge(request);
    judgeRetried = outcome.retried;
    judgeFailureCount = outcome.failureCount;
    const decisionByRef = new Map<string, SemanticBatchDecision>(outcome.decisions.map((d) => [d.candidateRef, d]));
    for (const r of shortlist) {
      const decision = decisionByRef.get(r.candidate.id);
      const deterministic = scoreMatch(input.groundTruth, r.candidate);
      if (!decision) {
        // The batch judge is contracted to return exactly one decision per requested ref -- this
        // branch should be unreachable, but fail safe rather than silently dropping the candidate.
        shortlistResolutions.push({
          candidate: r.candidate,
          deterministic,
          features: r.features,
          semantic: null,
          semanticRequested: true,
          resolvedVia: "unresolved",
          status: "needs_review"
        });
        continue;
      }
      const semanticResult: SemanticAdjudicationResult = {
        match: decision.match,
        owner_match: decision.owner_match,
        evidence_alignment: decision.evidence_alignment,
        concise_reason: decision.concise_reason
      };
      shortlistResolutions.push({
        candidate: r.candidate,
        deterministic,
        features: r.features,
        semantic: semanticResult,
        semanticRequested: true,
        resolvedVia: "semantic",
        status: mapSemanticToStatus(semanticResult)
      });
    }
  } else {
    for (const r of shortlist) {
      shortlistResolutions.push({
        candidate: r.candidate,
        deterministic: scoreMatch(input.groundTruth, r.candidate),
        features: r.features,
        semantic: null,
        semanticRequested: false,
        resolvedVia: "unresolved",
        status: "unmatched"
      });
    }
  }

  return {
    discoveredCount: input.candidates.length,
    shortlistCount: shortlist.length,
    judgeCallCount,
    judgeRetried,
    judgeFailureCount,
    resolutions: [...deterministicMatches, ...shortlistResolutions]
  };
}

export { runBatchSemanticAdjudication };
export type {
  RetrievalFeatureSummary,
  SemanticAdjudicationResult,
  SemanticBatchAdjudicationRequest,
  SemanticBatchCandidate,
  SemanticBatchJudge
};
