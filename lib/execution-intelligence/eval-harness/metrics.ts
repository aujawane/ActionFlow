import type { MeetingGroundTruth } from "./ground-truth-schema";
import type { EarliestFailureStage, FinalResult, GroundTruthItemTrace } from "./stage-tracer";
import type { MeetingSnapshot } from "./snapshot";

export type PerMeetingMetrics = {
  meetingId: string;
  meetingTitle: string;
  generation: number;
  jobId: string;

  /** Every active GT item, including any that ended up needs_review. */
  activeGroundTruthTotal: number;
  /** activeGroundTruthTotal minus needsReview -- the denominator headline recall is computed
   * against, per the explicit instruction not to count needs_review as correct or missed. */
  resolvedActiveGroundTruthTotal: number;
  correct: number;
  partial: number;
  missed: number;
  wrongOwner: number;
  wrongState: number;
  /** Active GT items the evaluator could not confidently resolve even after semantic adjudication
   * (or that had no ambiguity resolvable without one) -- excluded from correct/partial/missed and
   * from recall denominators; surfaced separately for mandatory human review. */
  needsReview: number;
  /** Count of GT items (any expected_state) whose qualityFlags.duplicate is set -- a quality flag,
   * never a substitute for the coverage result (see stage-tracer.ts's two-dimension design). */
  duplicateFlagged: number;

  /** correct / resolvedActiveGroundTruthTotal. */
  strictActiveWorkRecall: number;
  /** (correct + 0.5*partial) / resolvedActiveGroundTruthTotal. */
  recallIncludingPartial: number;
  /** Fraction of correct+partial+wrong_state items (i.e. anything genuinely matched) whose owner
   * was also right -- wrong_owner items are excluded from the numerator by definition and included
   * in the denominator. */
  ownerAccuracy: number;

  falsePositiveFinalActiveItems: number;
  duplicateActiveItems: number;
  falseCompletionClosures: number;

  adjudicationCoverage: { expected: number; received: number; missingAfterRetry: number } | null;
  lifecycleCoverage: { candidates: number; reviewed: number; unreviewed: number } | null;

  pipelineCounts: {
    passACandidates: number;
    passBAdd: number;
    passBAlreadyRepresented: number;
    passBSpeculativeOrInactive: number;
    passBNonExecution: number;
    deterministicDedupRemovals: number;
    semanticDedupRemovals: number;
    eligibleWorkItems: number;
    finalCommitments: number;
    finalTasks: number;
  };

  earliestFailureStageCounts: Record<EarliestFailureStage, number>;

  /** Number of GT sub-outcomes for which the batched semantic judge was actually called at least
   * once (i.e. had a non-empty shortlist AND a judge was wired in). */
  semanticJudgeCalls: number;
  /** Total candidates submitted across all those judge calls -- the real cost/latency signal this
   * hardening pass exists to bound (compare against the pre-hardening per-candidate call count). */
  semanticCandidatesSubmitted: number;
  /** Total candidates whose final decision came from the judge's fail-safe path (empty/invalid/
   * schema-invalid/thrown response, or missing after retry) rather than a genuine verdict. */
  semanticJudgeFailures: number;
  /** Number of sub-outcomes whose judge call needed the internal missing-ref retry. */
  semanticJudgeRetries: number;
  averageShortlistSize: number;
  maxShortlistSize: number;
};

const EARLIEST_FAILURE_STAGES: EarliestFailureStage[] = [
  "initial_extraction",
  "pass_a_harvest",
  "pass_b_adjudication",
  "work_item_classification",
  "lifecycle",
  "eligibility",
  "grouping",
  "tree",
  "consolidation",
  "reconciliation",
  "persistence",
  "none"
];

function emptyStageCounts(): Record<EarliestFailureStage, number> {
  return Object.fromEntries(EARLIEST_FAILURE_STAGES.map((stage) => [stage, 0])) as Record<EarliestFailureStage, number>;
}

/** Any GT item's "genuinely matched" outcome, used for false-completion auditing -- a
 * `completed_during_meeting` item that resolves to `wrong_state` means the pipeline left it open
 * when it should have closed it (a missed completion, not a false one); a FALSE completion closure
 * is the opposite risk this harness also has to watch for: an `active` GT item that was wrongly
 * marked completed. Detected by scanning every resolved WorkItem behind an `active` GT trace for a
 * completion decision, independent of whether the item ultimately scored correct/partial/missed. */
function countFalseCompletionClosures(traces: GroundTruthItemTrace[]): number {
  let count = 0;
  for (const trace of traces) {
    if (trace.expectedState !== "active") continue;
    for (const sub of trace.subOutcomes) {
      for (const decision of sub.lifecycle.completionDecisions) {
        if (decision.completed) count += 1;
      }
    }
  }
  return count;
}

function countDuplicateActiveItems(traces: GroundTruthItemTrace[]): number {
  let count = 0;
  for (const trace of traces) {
    for (const sub of trace.subOutcomes) {
      if (sub.finalActiveRefs.length > 1) count += sub.finalActiveRefs.length - 1;
    }
  }
  return count;
}

/** Final active WorkItems that never matched ANY ground-truth item at all -- the only true
 * "unexplained noise" signal a fixture can give (an active item this harness cannot explain isn't
 * necessarily wrong -- the meeting may simply have more real work than the frozen GT enumerates --
 * so this is reported as a count for human review, never as an automatic failure). */
function countUnexplainedFinalActiveItems(traces: GroundTruthItemTrace[], snapshot: MeetingSnapshot): number {
  const explainedRefs = new Set(traces.flatMap((t) => t.subOutcomes.flatMap((s) => s.finalActiveRefs)));
  let unexplained = 0;
  for (const item of snapshot.eligibleWorkItems) {
    if (explainedRefs.has(item.ref)) continue;
    // Only count it if it's also reachable from final persisted output -- an eligible item that
    // never reaches persistence isn't "noise", it's just not part of this evaluation.
    const inFinalOutput =
      snapshot.finalTasks.some((t) => t.extraction_metadata?.client_ref === item.ref) ||
      snapshot.finalCommitments.some((c) => c.metadata?.client_ref === item.ref);
    if (inFinalOutput) unexplained += 1;
  }
  return unexplained;
}

export function computePerMeetingMetrics(input: {
  groundTruth: MeetingGroundTruth;
  snapshot: MeetingSnapshot;
  traces: GroundTruthItemTrace[];
}): PerMeetingMetrics {
  const { groundTruth, snapshot, traces } = input;
  const activeTraces = traces.filter((t) => t.expectedState === "active");

  const countByResult = (result: FinalResult, pool: GroundTruthItemTrace[] = activeTraces) =>
    pool.filter((t) => t.finalResult === result).length;

  const needsReview = countByResult("needs_review");
  // Headline correct/partial/missed/wrong_owner/wrong_state are computed only over the RESOLVED
  // subset -- a needs_review item must never silently inflate or deflate either count.
  const resolvedActiveTraces = activeTraces.filter((t) => t.finalResult !== "needs_review");
  const correct = countByResult("correct", resolvedActiveTraces);
  const partial = countByResult("partial", resolvedActiveTraces);
  const missed = countByResult("missed", resolvedActiveTraces);
  const wrongOwner = countByResult("wrong_owner", resolvedActiveTraces);
  const wrongState = countByResult("wrong_state", resolvedActiveTraces);
  const duplicateFlagged = traces.filter((t) => t.qualityFlags.duplicate).length;
  const activeTotal = activeTraces.length;
  const resolvedActiveTotal = resolvedActiveTraces.length;

  const ownerComparable = resolvedActiveTraces.filter((t) => t.finalResult !== "missed");
  const ownerAccuracy = ownerComparable.length === 0 ? 1 : 1 - wrongOwner / ownerComparable.length;

  const stageCounts = emptyStageCounts();
  for (const trace of traces) stageCounts[trace.earliestFailureStage] += 1;

  const allSubOutcomes = traces.flatMap((t) => t.subOutcomes);
  const judgedSubOutcomes = allSubOutcomes.filter((s) => s.coverage.judgeCallCount > 0);
  const semanticJudgeCalls = judgedSubOutcomes.length;
  const semanticCandidatesSubmitted = judgedSubOutcomes.reduce((sum, s) => sum + s.coverage.shortlistCount, 0);
  const semanticJudgeFailures = allSubOutcomes.reduce((sum, s) => sum + s.coverage.judgeFailureCount, 0);
  const semanticJudgeRetries = allSubOutcomes.filter((s) => s.coverage.judgeRetried).length;
  const shortlistSizes = allSubOutcomes.map((s) => s.coverage.shortlistCount);
  const averageShortlistSize = shortlistSizes.length === 0 ? 0 : shortlistSizes.reduce((a, b) => a + b, 0) / shortlistSizes.length;
  const maxShortlistSize = shortlistSizes.length === 0 ? 0 : Math.max(...shortlistSizes);

  const metrics = snapshot.metrics as Record<string, number> | null;

  return {
    meetingId: groundTruth.meeting_id,
    meetingTitle: groundTruth.meeting_title,
    generation: snapshot.generation,
    jobId: snapshot.jobId,
    activeGroundTruthTotal: activeTotal,
    resolvedActiveGroundTruthTotal: resolvedActiveTotal,
    correct,
    partial,
    missed,
    wrongOwner,
    wrongState,
    needsReview,
    duplicateFlagged,
    strictActiveWorkRecall: resolvedActiveTotal === 0 ? 1 : correct / resolvedActiveTotal,
    recallIncludingPartial: resolvedActiveTotal === 0 ? 1 : (correct + 0.5 * partial) / resolvedActiveTotal,
    ownerAccuracy,
    falsePositiveFinalActiveItems: countUnexplainedFinalActiveItems(traces, snapshot),
    duplicateActiveItems: countDuplicateActiveItems(traces),
    falseCompletionClosures: countFalseCompletionClosures(traces),
    adjudicationCoverage: metrics
      ? {
          expected: metrics.completenessCandidatesExpectedForAdjudication ?? 0,
          received: metrics.completenessDecisionsReceived ?? 0,
          missingAfterRetry: metrics.completenessMissingCandidatesAfterRetry ?? 0
        }
      : null,
    lifecycleCoverage: metrics
      ? {
          candidates: metrics.lifecycleCandidatesConsidered ?? 0,
          reviewed: snapshot.globalCorrections.length,
          unreviewed: Math.max(0, (metrics.lifecycleCandidatesConsidered ?? 0) - snapshot.globalCorrections.length)
        }
      : null,
    pipelineCounts: {
      passACandidates: metrics?.completenessCandidatesHarvested ?? snapshot.harvestTrace.length,
      passBAdd: metrics?.completenessDecisionAdd ?? 0,
      passBAlreadyRepresented: metrics?.completenessDecisionAlreadyRepresented ?? 0,
      passBSpeculativeOrInactive: metrics?.completenessDecisionSpeculativeOrInactive ?? 0,
      passBNonExecution: metrics?.completenessDecisionNonExecution ?? 0,
      deterministicDedupRemovals: metrics?.completenessDuplicatesRemovedDeterministic ?? 0,
      semanticDedupRemovals: metrics?.completenessDuplicatesRemovedSemantic ?? 0,
      eligibleWorkItems: snapshot.eligibleWorkItems.length,
      finalCommitments: snapshot.finalCommitments.length,
      finalTasks: snapshot.finalTasks.length
    },
    earliestFailureStageCounts: stageCounts,
    semanticJudgeCalls,
    semanticCandidatesSubmitted,
    semanticJudgeFailures,
    semanticJudgeRetries,
    averageShortlistSize,
    maxShortlistSize
  };
}

/** Recurring semantic failure categories, derived read-only from each GT item's own
 * `semantic_outcome`/`notes` text (never by changing the frozen ground truth itself) -- a light
 * keyword classifier, not a new authoritative judgment, purely for cross-meeting aggregation
 * visibility per the task's explicit category list. */
export const SEMANTIC_FAILURE_CATEGORIES = [
  "voluntary_promise",
  "verification_action",
  "experiment_or_evaluation",
  "compound_turn_secondary_action",
  "multi_owner_work",
  "conditional_activation",
  "completion_detection"
] as const;
export type SemanticFailureCategory = (typeof SEMANTIC_FAILURE_CATEGORIES)[number];

const CATEGORY_KEYWORDS: Record<SemanticFailureCategory, RegExp> = {
  voluntary_promise: /\bi'll\b|\bi will\b|\bi can\b|voluntary|promise/i,
  verification_action: /\bverify|\bconfirm|\bcheck\b|\btest\b/i,
  experiment_or_evaluation: /\btry\b|\bexperiment|\bevaluate|\bobserve|see how|see whether/i,
  compound_turn_secondary_action: /\band then\b|\band\b.*\band\b/i,
  multi_owner_work: /./, // determined structurally (owners.length > 1), regex unused but kept for shape symmetry
  conditional_activation: /\bif\b.*\bi can\b|\bif you\b/i,
  completion_detection: /completed_during_meeting/i
};

export function categorizeGroundTruthItem(
  text: string,
  ownerCount: number,
  expectedState: string
): SemanticFailureCategory[] {
  const categories: SemanticFailureCategory[] = [];
  if (ownerCount > 1) categories.push("multi_owner_work");
  if (expectedState === "completed_during_meeting") categories.push("completion_detection");
  for (const category of SEMANTIC_FAILURE_CATEGORIES) {
    if (category === "multi_owner_work" || category === "completion_detection") continue;
    if (CATEGORY_KEYWORDS[category].test(text)) categories.push(category);
  }
  return Array.from(new Set(categories));
}

export type CrossMeetingAggregate = {
  meetingsEvaluated: number;
  macroStrictRecall: number;
  microStrictRecall: number;
  partialAdjustedRecall: number;
  ownerAccuracy: number;
  falsePositivesPerMeeting: number;
  duplicateRate: number;
  falseCompletionCount: number;
  /** All active GT items across every meeting, regardless of resolution. */
  totalActiveGroundTruth: number;
  /** Active GT items the evaluator resolved without leaving a needs_review verdict -- the
   * denominator headline recall figures above are computed against. */
  totalResolvedActiveGroundTruth: number;
  /** Active GT items still awaiting manual review -- never folded into correct/partial/missed at
   * the cross-meeting level either, per the same rule as the per-meeting metrics. */
  totalNeedsReview: number;
  /** GT items (any expected_state) flagged with a duplicate quality flag, across all meetings. */
  totalDuplicateFlagged: number;
  earliestFailureStageCounts: Record<EarliestFailureStage, number>;
  semanticFailureCategoryCounts: Record<SemanticFailureCategory, number>;
  perMeeting: PerMeetingMetrics[];
};

export function aggregateAcrossMeetings(
  results: Array<{ groundTruth: MeetingGroundTruth; snapshot: MeetingSnapshot; traces: GroundTruthItemTrace[]; metrics: PerMeetingMetrics }>
): CrossMeetingAggregate {
  const perMeeting = results.map((r) => r.metrics);
  const meetingsEvaluated = perMeeting.length;

  const macroStrictRecall =
    meetingsEvaluated === 0 ? 1 : perMeeting.reduce((sum, m) => sum + m.strictActiveWorkRecall, 0) / meetingsEvaluated;

  const totalActive = perMeeting.reduce((sum, m) => sum + m.resolvedActiveGroundTruthTotal, 0);
  const totalCorrect = perMeeting.reduce((sum, m) => sum + m.correct, 0);
  const totalPartial = perMeeting.reduce((sum, m) => sum + m.partial, 0);
  const microStrictRecall = totalActive === 0 ? 1 : totalCorrect / totalActive;
  const partialAdjustedRecall = totalActive === 0 ? 1 : (totalCorrect + 0.5 * totalPartial) / totalActive;

  const totalActiveGroundTruth = perMeeting.reduce((sum, m) => sum + m.activeGroundTruthTotal, 0);
  const totalResolvedActiveGroundTruth = totalActive;
  const totalNeedsReview = perMeeting.reduce((sum, m) => sum + m.needsReview, 0);
  const totalDuplicateFlagged = perMeeting.reduce((sum, m) => sum + m.duplicateFlagged, 0);

  const ownerAccuracy =
    meetingsEvaluated === 0 ? 1 : perMeeting.reduce((sum, m) => sum + m.ownerAccuracy, 0) / meetingsEvaluated;
  const falsePositivesPerMeeting =
    meetingsEvaluated === 0 ? 0 : perMeeting.reduce((sum, m) => sum + m.falsePositiveFinalActiveItems, 0) / meetingsEvaluated;
  const totalDuplicate = perMeeting.reduce((sum, m) => sum + m.duplicateActiveItems, 0);
  const totalFinalActive = perMeeting.reduce((sum, m) => sum + m.pipelineCounts.eligibleWorkItems, 0);
  const duplicateRate = totalFinalActive === 0 ? 0 : totalDuplicate / totalFinalActive;
  const falseCompletionCount = perMeeting.reduce((sum, m) => sum + m.falseCompletionClosures, 0);

  const earliestFailureStageCounts = emptyStageCounts();
  for (const meeting of perMeeting) {
    for (const stage of EARLIEST_FAILURE_STAGES) earliestFailureStageCounts[stage] += meeting.earliestFailureStageCounts[stage];
  }

  const semanticFailureCategoryCounts = Object.fromEntries(
    SEMANTIC_FAILURE_CATEGORIES.map((category) => [category, 0])
  ) as Record<SemanticFailureCategory, number>;
  for (const result of results) {
    for (const item of result.groundTruth.ground_truth) {
      const trace = result.traces.find((t) => t.groundTruthId === item.id);
      // needs_review is an unresolved verdict, not a known failure -- excluded from failure-category
      // attribution the same way it's excluded from correct/partial/missed at every other level.
      if (!trace || trace.finalResult === "correct" || trace.finalResult === "needs_review") continue;
      const text = [item.semantic_outcome, ...(item.compound_outcomes ?? [])].join(" ");
      for (const category of categorizeGroundTruthItem(text, item.owners.length, item.expected_state)) {
        semanticFailureCategoryCounts[category] += 1;
      }
    }
  }

  return {
    meetingsEvaluated,
    macroStrictRecall,
    microStrictRecall,
    partialAdjustedRecall,
    ownerAccuracy,
    falsePositivesPerMeeting,
    duplicateRate,
    falseCompletionCount,
    totalActiveGroundTruth,
    totalResolvedActiveGroundTruth,
    totalNeedsReview,
    totalDuplicateFlagged,
    earliestFailureStageCounts,
    semanticFailureCategoryCounts,
    perMeeting
  };
}
