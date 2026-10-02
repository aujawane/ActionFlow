import { isExecutionEligible } from "../execution-tree";
import type { WorkItem } from "../work-item-schemas";
import type { GroundTruthItem } from "./ground-truth-schema";
import { findMatches, ownersOverlap, type MatchCandidate, type MatchResult } from "./matcher";
import { resolveCoverage, type CandidateResolution, type RetrievalFeatures, type SemanticBatchJudge } from "./hybrid-matcher";
import type { FinalCommitmentRow, FinalTaskRow, MeetingSnapshot } from "./snapshot";

/**
 * Per-GT-item pipeline tracer -- the evaluation harness's core. Walks a single ground-truth outcome
 * (or, for a compound commitment, each of its independently-checkable sub-outcomes) through every
 * stage the two-step completeness architecture and the rest of the V4 pipeline exposes, using only
 * already-persisted checkpoint data (see snapshot.ts) -- never re-running any stage.
 *
 * GENERATION-13-HARDENING UPDATE: the final "does this sub-outcome have a representative WorkItem"
 * question is now answered by the three-layer HYBRID matcher (hybrid-matcher.ts) against the
 * complete final ledger (`snapshot.workItems`), not by the plain deterministic `findMatches` used
 * for the Pass-A/Pass-B *diagnostic* trace sections below (those stay deterministic-only -- they
 * are "what did Pass A/B actually do", not "is the GT outcome represented", and changing them would
 * misrepresent what the pipeline itself decided). This is what lets a genuine semantic paraphrase
 * with low token overlap (the confirmed GT2 false negative) be correctly resolved via semantic
 * adjudication, while an ambiguous case that even the judge cannot confidently resolve is surfaced
 * as `needs_review` rather than silently guessed either way -- see combineFinalResult below.
 *
 * DOWNSTREAM SIMPLIFICATION (disclosed, not hidden): the task's stage enum distinguishes grouping /
 * recovery / consolidation / reconciliation / persistence individually. Fully differentiating those
 * would require diffing the pre- and post- trees at each of those four deterministic stages, which
 * the persisted checkpoint's `debugTrace` supports in principle (pre_consolidation_tree,
 * pre_reconciliation_tree, final_tree) but which this version does not attempt -- instead,
 * "downstream" presence is checked the same way the manual Gen-12/Gen-13 forensic benchmarks did:
 * is this ref (or a ref it was consolidated from/into) findable in the actually-persisted
 * `meeting_commitments`/`meeting_tasks` rows. When a ref is eligible but never reaches persisted
 * output, the earliest-failure stage is reported as the generic `"persistence"` catch-all rather
 * than a guess at which of the four intermediate stages actually dropped it.
 */

// Mirrors execution-tree.ts's own (private) eligibility field lists, read-only, for diagnostic
// "which field(s) failed" reporting only -- isExecutionEligible itself is always the actual,
// authoritative pass/fail source; this mirror never itself decides eligibility.
const ELIGIBLE_CLASSIFICATIONS = ["open_task", "assignment", "promise", "accepted_request", "scheduling", "in_progress"];
const ELIGIBLE_STATUSES = ["open", "in_progress", "blocked"];
const ELIGIBLE_ROLES = ["action", "input_dependency"];

export type PassAStatus = "harvested" | "not_needed" | "absent" | "unknown";
export type PassBDispositionStatus =
  | "add"
  | "already_represented"
  | "speculative_or_inactive"
  | "retrospective_or_completed"
  | "non_execution"
  | "insufficient_grounding"
  | "omitted_or_error"
  | "not_applicable"
  | "unknown";

/** "duplicate" is deliberately NOT a coverage result -- see `qualityFlags.duplicate` below. Two
 * independent dimensions: coverage quality (is the outcome represented, and how well) and quality
 * flags (is there something ELSE worth flagging about how it's represented). "needs_review" is a
 * genuine third outcome, not a coverage level -- it means the evaluator could not confidently reach
 * any of the other five without a human, and must never be silently collapsed into one. */
export type FinalResult = "correct" | "partial" | "missed" | "wrong_owner" | "wrong_state" | "needs_review";

export type QualityFlags = {
  /** 2+ independently-eligible, persisted final items all confidently represent the SAME
   * (sub-)outcome -- a genuine dedup/consolidation gap worth flagging, independent of whether
   * coverage itself is otherwise correct. */
  duplicate: boolean;
  /** An `active`-expected GT item's resolved WorkItem was marked completed/completed_work by
   * lifecycle -- a false closure, independent of coverage result. */
  falseCompletion: boolean;
};

export type EarliestFailureStage =
  | "initial_extraction"
  | "pass_a_harvest"
  | "pass_b_adjudication"
  | "work_item_classification"
  | "lifecycle"
  | "eligibility"
  | "grouping"
  | "tree"
  | "consolidation"
  | "reconciliation"
  | "persistence"
  | "needs_review"
  | "none";

export type ResolvedWorkItemTrace = {
  ref: string;
  owner: string | null;
  owners: string[];
  classification: string;
  acceptance_state: string;
  scope_state: string;
  execution_scope: string;
  work_item_role: string;
  status: string;
};

/** One candidate's full hybrid resolution, exactly as the task's "report separately" safety
 * requirement demands: deterministic_result, semantic_adjudication, and final_evaluator_result are
 * never merged into a single opaque verdict. */
export type CandidateCoverageTrace = {
  ref: string;
  title: string;
  deterministicResult: MatchResult;
  /** Present only for candidates that were ranked/shortlisted (i.e. not an immediate deterministic
   * match) -- the exact features that produced this candidate's rank score, echoed for "why was this
   * candidate even shown to the judge" observability. */
  retrievalFeatures: RetrievalFeatures | null;
  semanticRequested: boolean;
  semanticAdjudication: CandidateResolution<MatchCandidate>["semantic"];
  finalStatus: "matched" | "partial" | "needs_review" | "unmatched";
  eligible: boolean;
  foundInFinalOutput: boolean;
  /** PATH B positive completion evidence: this candidate's own final WorkItem state is
   * status="completed" AND classification="completed_work" -- i.e. it was already completed at
   * extraction time (same-breath in-meeting completion), never needing a separate lifecycle
   * correction to confirm it (see combineFinalResult's completed_during_meeting branch, which
   * accepts this as an alternative to PATH A's `lifecycle.completionDecisions` evidence). Never
   * inferred from `eligible === false` alone -- a candidate can be ineligible for many reasons
   * that are NOT completion (proposed, idea role, future scope, ...), so this checks the specific
   * status/classification pair directly. */
  isCompletedWorkItem: boolean;
};

export type SubOutcomeStatus = "matched" | "partially_matched" | "needs_review" | "unmatched";

export type SubOutcomeTrace = {
  subOutcome: string;
  initialExtraction: {
    present: boolean;
    matches: Array<{ ref: string; title: string; match: MatchResult }>;
  };
  passA: {
    status: PassAStatus;
    candidateIds: string[];
    matches: Array<{ candidateId: string; windowIndex: number; outcome: string; match: MatchResult }>;
    groundingRejectedNearMisses: Array<{ candidateId: string; windowIndex: number; rejectionReason: string }>;
  };
  passB: {
    decisions: Array<{
      candidateId: string;
      disposition: PassBDispositionStatus;
      reason: string | null;
      resultingWorkItemRef: string | null;
    }>;
  };
  /** Discovery + ranking + shortlisting + (optional) batched semantic coverage resolution against
   * the FULL final ledger -- this, not passA/passB above, is what decides whether the sub-outcome is
   * represented. `candidates` covers only deterministic matches plus the shortlist actually sent (or
   * eligible to be sent) to the judge -- NOT the full discovered ledger, so trace/report output stays
   * bounded regardless of ledger size. */
  coverage: {
    discoveredCount: number;
    shortlistCount: number;
    judgeCallCount: number;
    judgeRetried: boolean;
    judgeFailureCount: number;
    candidates: CandidateCoverageTrace[];
  };
  workItem: { items: ResolvedWorkItemTrace[] };
  lifecycle: {
    candidateRefs: string[];
    reviewedRefs: string[];
    completionDecisions: Array<{ ref: string; completed: boolean; completionReason: string | null }>;
  };
  eligibility: {
    results: Array<{ ref: string; eligible: boolean; failingFields: string[] }>;
  };
  downstream: {
    results: Array<{
      ref: string;
      foundInFinalOutput: boolean;
      finalKind: "commitment" | "task" | null;
      finalId: string | null;
      consolidatedFrom: string[];
    }>;
  };
  /** Refs whose coverage status is "matched" AND eligible AND present in final output -- full
   * credit for this sub-outcome. */
  finalActiveRefs: string[];
  /** Refs whose coverage status is "partial" AND eligible AND present in final output. */
  partialActiveRefs: string[];
  /** Refs whose coverage status is "needs_review" AND eligible AND present in final output --
   * ambiguous enough that a human must decide; never silently folded into matched or unmatched. */
  needsReviewActiveRefs: string[];
  subOutcomeStatus: SubOutcomeStatus;
  earliestFailureStage: EarliestFailureStage;
};

export type GroundTruthItemTrace = {
  groundTruthId: string;
  expectedState: GroundTruthItem["expected_state"];
  owners: string[];
  isCompound: boolean;
  subOutcomes: SubOutcomeTrace[];
  finalResult: FinalResult;
  qualityFlags: QualityFlags;
  earliestFailureStage: EarliestFailureStage;
};

function toWorkItemCandidate(item: WorkItem): MatchCandidate {
  return {
    id: item.ref,
    title: item.title,
    description: item.description,
    sourceQuote: item.source_quote,
    sourceSegmentIds: item.source_segment_ids,
    owner: item.owner,
    owners: item.owners
  };
}

function toResolvedWorkItemTrace(item: WorkItem): ResolvedWorkItemTrace {
  return {
    ref: item.ref,
    owner: item.owner,
    owners: item.owners,
    classification: item.classification,
    acceptance_state: item.acceptance_state,
    scope_state: item.scope_state,
    execution_scope: item.execution_scope,
    work_item_role: item.work_item_role,
    status: item.status
  };
}

function eligibilityFailingFields(item: WorkItem): string[] {
  const failing: string[] = [];
  if (item.execution_scope !== "project_work") failing.push(`execution_scope=${item.execution_scope}`);
  if (item.acceptance_state !== "accepted") failing.push(`acceptance_state=${item.acceptance_state}`);
  if (item.scope_state !== "current_scope") failing.push(`scope_state=${item.scope_state}`);
  if (!ELIGIBLE_STATUSES.includes(item.status)) failing.push(`status=${item.status}`);
  if (!ELIGIBLE_CLASSIFICATIONS.includes(item.classification)) failing.push(`classification=${item.classification}`);
  if (!ELIGIBLE_ROLES.includes(item.work_item_role)) failing.push(`work_item_role=${item.work_item_role}`);
  return failing;
}

function findDownstreamPresence(
  ref: string,
  snapshot: MeetingSnapshot
): { found: boolean; kind: "commitment" | "task" | null; id: string | null; consolidatedFrom: string[] } {
  const task = snapshot.finalTasks.find((t: FinalTaskRow) => {
    const meta = t.extraction_metadata;
    return meta?.client_ref === ref || (meta?.merge_provenance?.merged_from_task_refs ?? []).includes(ref);
  });
  if (task) {
    const meta = task.extraction_metadata;
    return {
      found: true,
      kind: "task",
      id: task.id,
      consolidatedFrom: meta?.merge_provenance?.merged_from_task_refs ?? []
    };
  }
  const commitment = snapshot.finalCommitments.find((c: FinalCommitmentRow) => {
    const meta = c.metadata;
    return (
      meta?.client_ref === ref ||
      (meta?.supporting_action_refs ?? []).includes(ref) ||
      (meta?.consolidated_from_refs ?? []).includes(ref)
    );
  });
  if (commitment) {
    const meta = commitment.metadata;
    return {
      found: true,
      kind: "commitment",
      id: commitment.id,
      consolidatedFrom: [...(meta?.supporting_action_refs ?? []), ...(meta?.consolidated_from_refs ?? [])]
    };
  }
  return { found: false, kind: null, id: null, consolidatedFrom: [] };
}

const HARVEST_TRACE_AVAILABLE = (snapshot: MeetingSnapshot) =>
  snapshot.harvestTrace.length > 0 || snapshot.adjudicationTrace.length > 0;

/** Real transcript text for the GT's own declared evidence segments -- looked up, never invented,
 * for the semantic judge's "GT source evidence text" input. Null when no segment is known or none
 * of the declared ids resolve (e.g. a fixture typo, or a generation whose transcript differs). */
function lookupEvidenceText(segmentIds: string[], snapshot: MeetingSnapshot): string | null {
  if (segmentIds.length === 0) return null;
  const texts = segmentIds
    .map((id) => snapshot.transcriptSegments.find((s) => s.id === id)?.text)
    .filter((t): t is string => Boolean(t));
  return texts.length > 0 ? texts.join(" ... ") : null;
}

async function traceSubOutcome(input: {
  subOutcome: string;
  owners: string[];
  sourceSegmentIds: string[];
  snapshot: MeetingSnapshot;
  judge?: SemanticBatchJudge;
}): Promise<SubOutcomeTrace> {
  const { subOutcome, owners, sourceSegmentIds, snapshot, judge } = input;
  const groundTruthMatchInput = { owners, semanticOutcome: subOutcome, sourceSegmentIds };

  // --- INITIAL EXTRACTION (diagnostic only -- deterministic, unchanged) ---
  const initialCandidates = snapshot.mergedWorkItems.map(toWorkItemCandidate);
  const initialMatches = findMatches(groundTruthMatchInput, initialCandidates);
  const initialExtraction = {
    present: initialMatches.length > 0,
    matches: initialMatches.map((m) => ({ ref: m.candidate.id, title: m.candidate.title, match: m.result }))
  };

  // --- PASS A (diagnostic only -- deterministic, unchanged) ---
  const harvestCandidates: MatchCandidate[] = snapshot.harvestTrace.map((t) => ({
    id: t.candidateId,
    title: t.outcome,
    sourceQuote: t.sourceQuote,
    sourceSegmentIds: t.sourceSegmentIds,
    owner: t.owner,
    owners: t.owners
  }));
  const harvestMatches = findMatches(groundTruthMatchInput, harvestCandidates);
  const harvestTraceByCandidateId = new Map(snapshot.harvestTrace.map((t) => [t.candidateId, t]));

  const groundingNearMisses = snapshot.groundingRejectionTrace.filter(
    (t) => sourceSegmentIds.length > 0 && t.sourceSegmentIds.some((id) => sourceSegmentIds.includes(id))
  );

  let passAStatus: PassAStatus;
  if (harvestMatches.length > 0) passAStatus = "harvested";
  else if (initialExtraction.present) passAStatus = "not_needed";
  else if (!HARVEST_TRACE_AVAILABLE(snapshot)) passAStatus = "unknown";
  else passAStatus = "absent";

  const passA = {
    status: passAStatus,
    candidateIds: harvestMatches.map((m) => m.candidate.id),
    matches: harvestMatches.map((m) => {
      const trace = harvestTraceByCandidateId.get(m.candidate.id)!;
      return { candidateId: trace.candidateId, windowIndex: trace.windowIndex, outcome: trace.outcome, match: m.result };
    }),
    groundingRejectedNearMisses: groundingNearMisses.map((t) => ({
      candidateId: t.candidateId,
      windowIndex: t.windowIndex,
      rejectionReason: t.rejectionReason
    }))
  };

  // --- PASS B (diagnostic only -- deterministic, unchanged) ---
  const adjudicationByCandidateId = new Map(snapshot.adjudicationTrace.map((t) => [t.candidate_id, t]));
  const passBDecisions = passA.candidateIds.map((candidateId) => {
    const decision = adjudicationByCandidateId.get(candidateId);
    if (!decision) {
      return { candidateId, disposition: "omitted_or_error" as PassBDispositionStatus, reason: null, resultingWorkItemRef: null };
    }
    return {
      candidateId,
      disposition: decision.disposition as PassBDispositionStatus,
      reason: decision.reason,
      resultingWorkItemRef: decision.resulting_work_item_ref
    };
  });
  const passB = { decisions: passBDecisions };

  // Pass-A/Pass-B trace linkage: a candidate ref is "pass-linked" to this GT (sub-)outcome when some
  // Pass-A harvest entry cited one of the GT's OWN declared evidence segments and Pass B's
  // adjudication of that same harvest candidate resulted in this ref. This is a genuinely distinct,
  // stronger-than-owner-alone retrieval signal from the pipeline's own recorded provenance -- see
  // hybrid-matcher.ts's rankScore -- and is what lets ranking find GT4/GT5/GT6-class candidates even
  // when their final persisted source_segment_ids drifted slightly from the harvest-time segment set.
  const passLinkedRefs = new Set<string>();
  if (sourceSegmentIds.length > 0) {
    for (const harvest of snapshot.harvestTrace) {
      if (!harvest.sourceSegmentIds.some((id) => sourceSegmentIds.includes(id))) continue;
      const adjudication = adjudicationByCandidateId.get(harvest.candidateId);
      if (adjudication?.resulting_work_item_ref) passLinkedRefs.add(adjudication.resulting_work_item_ref);
    }
  }

  // --- HYBRID COVERAGE RESOLUTION (this is the actual correctness gate) ---
  const workItemByRef = new Map(snapshot.workItems.map((item) => [item.ref, item]));
  const allWorkItemCandidates = snapshot.workItems.map(toWorkItemCandidate);
  const evidenceText = lookupEvidenceText(sourceSegmentIds, snapshot);
  const coverageOutcome = await resolveCoverage({
    groundTruth: groundTruthMatchInput,
    candidates: allWorkItemCandidates,
    isSubOutcome: sourceSegmentIds.length > 0,
    evidenceText,
    passLinkedRefs,
    judge
  });

  const coverageCandidates: CandidateCoverageTrace[] = coverageOutcome.resolutions
    .filter((r) => r.status !== "unmatched")
    .map((r) => {
      const item = workItemByRef.get(r.candidate.id);
      const eligible = item ? isExecutionEligible(item) : false;
      const foundInFinalOutput = findDownstreamPresence(r.candidate.id, snapshot).found;
      const isCompletedWorkItem = item ? item.status === "completed" && item.classification === "completed_work" : false;
      return {
        ref: r.candidate.id,
        title: r.candidate.title,
        deterministicResult: r.deterministic,
        retrievalFeatures: r.features,
        semanticRequested: r.semanticRequested,
        semanticAdjudication: r.semantic,
        finalStatus: r.status,
        eligible,
        foundInFinalOutput,
        isCompletedWorkItem
      };
    });

  const finalActiveRefs = coverageCandidates.filter((c) => c.finalStatus === "matched" && c.eligible && c.foundInFinalOutput).map((c) => c.ref);
  const partialActiveRefs = coverageCandidates.filter((c) => c.finalStatus === "partial" && c.eligible && c.foundInFinalOutput).map((c) => c.ref);
  // Deliberately does NOT require `eligible` the way finalActiveRefs/partialActiveRefs do --
  // "eligible" is categorically false for a genuinely completed (status="completed") candidate by
  // design (see isExecutionEligible), which is an orthogonal fact from whether the semantic judge
  // could confidently decide if this persisted candidate represents the SAME real-world outcome as
  // the GT. Gating on `eligible` would silently convert a genuine "the judge couldn't tell" about a
  // real, persisted completed-history candidate into "missed" -- exactly the kind of silent
  // ambiguity resolution this harness exists to prevent. `foundInFinalOutput` is kept: an ambiguous
  // candidate that never reached final output either way is safely "unmatched"/missed regardless of
  // how the judge felt about it, since the GT outcome isn't represented in the product either way.
  const needsReviewActiveRefs = coverageCandidates
    .filter((c) => c.finalStatus === "needs_review" && c.foundInFinalOutput)
    .map((c) => c.ref);

  let subOutcomeStatus: SubOutcomeStatus;
  if (finalActiveRefs.length > 0) subOutcomeStatus = "matched";
  else if (needsReviewActiveRefs.length > 0) subOutcomeStatus = "needs_review";
  else if (partialActiveRefs.length > 0) subOutcomeStatus = "partially_matched";
  else subOutcomeStatus = "unmatched";

  // --- WORK ITEM / LIFECYCLE / ELIGIBILITY / DOWNSTREAM trace sections, over every candidate the
  // coverage resolution considered relevant (matched, partial, or needs_review) ---
  const resolvedRefs = coverageCandidates.map((c) => c.ref);
  const resolvedItems = resolvedRefs.map((ref) => workItemByRef.get(ref)).filter((item): item is WorkItem => item !== undefined);
  const workItem = { items: resolvedItems.map(toResolvedWorkItemTrace) };

  const correctionByRef = new Map(snapshot.globalCorrections.map((c) => [c.ref, c]));
  const candidateRefs = resolvedItems.map((item) => item.ref);
  const reviewedRefs = candidateRefs.filter((ref) => correctionByRef.has(ref));
  const completionDecisions = candidateRefs.map((ref) => {
    const correction = correctionByRef.get(ref);
    return {
      ref,
      completed: correction ? correction.status === "completed" || correction.classification === "completed_work" : false,
      completionReason: correction?.completion_reason ?? null
    };
  });
  const lifecycle = { candidateRefs, reviewedRefs, completionDecisions };

  const eligibilityResults = resolvedItems.map((item) => ({
    ref: item.ref,
    eligible: isExecutionEligible(item),
    failingFields: isExecutionEligible(item) ? [] : eligibilityFailingFields(item)
  }));
  const eligibility = { results: eligibilityResults };

  const downstreamResults = resolvedItems.map((item) => ({ ref: item.ref, ...findDownstreamPresence(item.ref, snapshot) }));
  const downstream = {
    results: downstreamResults.map((d) => ({
      ref: d.ref,
      foundInFinalOutput: d.found,
      finalKind: d.kind,
      finalId: d.id,
      consolidatedFrom: d.consolidatedFrom
    }))
  };

  // --- EARLIEST FAILURE STAGE ---
  let earliestFailureStage: EarliestFailureStage = "none";
  if (subOutcomeStatus === "needs_review") {
    earliestFailureStage = "needs_review";
  } else if (finalActiveRefs.length === 0 && partialActiveRefs.length === 0) {
    if (resolvedItems.length === 0) {
      if (passA.status === "absent" || passA.status === "unknown") {
        earliestFailureStage = "pass_a_harvest";
      } else {
        earliestFailureStage = "pass_b_adjudication";
      }
    } else {
      const anyEligible = eligibilityResults.some((r) => r.eligible);
      if (!anyEligible) {
        const anyClassificationRepairable = eligibilityResults.some((r) =>
          r.failingFields.some((f) => f.startsWith("work_item_role") || f.startsWith("classification"))
        );
        earliestFailureStage = anyClassificationRepairable ? "work_item_classification" : "eligibility";
        if (reviewedRefs.length === 0 && candidateRefs.length > 0) earliestFailureStage = "lifecycle";
      } else {
        earliestFailureStage = "persistence";
      }
    }
  }

  return {
    subOutcome,
    initialExtraction,
    passA,
    passB,
    coverage: {
      discoveredCount: coverageOutcome.discoveredCount,
      shortlistCount: coverageOutcome.shortlistCount,
      judgeCallCount: coverageOutcome.judgeCallCount,
      judgeRetried: coverageOutcome.judgeRetried,
      judgeFailureCount: coverageOutcome.judgeFailureCount,
      candidates: coverageCandidates
    },
    workItem,
    lifecycle,
    eligibility,
    downstream,
    finalActiveRefs,
    partialActiveRefs,
    needsReviewActiveRefs,
    subOutcomeStatus,
    earliestFailureStage
  };
}

/** Positive completion evidence for one matched candidate, via EITHER valid path:
 *   PATH A -- the candidate was initially open/active and a later lifecycle correction explicitly
 *   confirmed completion (`lifecycle.completionDecisions`).
 *   PATH B -- the candidate's own final WorkItem state was already status="completed"/
 *   classification="completed_work" at extraction time (a same-breath in-meeting completion,
 *   persisted directly as completed history -- see `isCompletedWorkItem` on CandidateCoverageTrace),
 *   AND it actually reached final persisted output as that completed representation.
 * Deliberately requires POSITIVE evidence either way -- never inferred from `eligible === false`
 * alone (ineligible covers many non-completed reasons too: proposed, idea role, future scope, ...),
 * and PATH B additionally requires `foundInFinalOutput` so a completed-shaped candidate that never
 * actually persisted doesn't count. */
function hasCompletionEvidence(sub: SubOutcomeTrace, candidate: CandidateCoverageTrace): boolean {
  const viaLifecycle = sub.lifecycle.completionDecisions.some((d) => d.ref === candidate.ref && d.completed);
  const viaDirectState = candidate.isCompletedWorkItem && candidate.foundInFinalOutput;
  return viaLifecycle || viaDirectState;
}

/** completed_during_meeting-only duplicate signal: a matched (same-real-world-action) candidate was
 * both closed AND left with a separate matched-active representation of that SAME action -- distinct
 * from the general "2+ active refs" duplicate check below, which never fires here because a
 * completed candidate is ineligible by construction and so never appears in `finalActiveRefs`
 * alongside its own active duplicate. */
function hasCompletedAndActiveMatchedDuplicate(sub: SubOutcomeTrace): boolean {
  const matchedCandidates = sub.coverage.candidates.filter((c) => c.finalStatus === "matched");
  const activeExists = matchedCandidates.some((c) => c.eligible);
  const completedExists = matchedCandidates.some((c) => hasCompletionEvidence(sub, c));
  return activeExists && completedExists;
}

function computeQualityFlags(expectedState: GroundTruthItem["expected_state"], subOutcomes: SubOutcomeTrace[]): QualityFlags {
  const duplicate =
    subOutcomes.some((s) => s.finalActiveRefs.length > 1) ||
    (expectedState === "completed_during_meeting" && subOutcomes.some(hasCompletedAndActiveMatchedDuplicate));
  const falseCompletion =
    expectedState === "active" && subOutcomes.some((s) => s.lifecycle.completionDecisions.some((d) => d.completed));
  return { duplicate, falseCompletion };
}

function combineFinalResult(input: {
  expectedState: GroundTruthItem["expected_state"];
  owners: string[];
  subOutcomes: SubOutcomeTrace[];
  snapshot: MeetingSnapshot;
}): FinalResult {
  const { expectedState, owners, subOutcomes, snapshot } = input;

  // An ambiguous sub-outcome ALWAYS surfaces as needs_review, whatever the other sub-outcomes say --
  // per the explicit instruction never to silently convert ambiguity to correct or missed.
  if (subOutcomes.some((s) => s.subOutcomeStatus === "needs_review")) return "needs_review";

  if (expectedState === "negative") {
    const anyRepresented = subOutcomes.some((s) => s.subOutcomeStatus === "matched" || s.subOutcomeStatus === "partially_matched");
    return anyRepresented ? "wrong_state" : "correct";
  }

  if (expectedState === "completed_during_meeting") {
    // Reason over every candidate that actually represents the SAME real-world action (finalStatus
    // === "matched") -- a "partial"/weak candidate (even a highly-ranked one, even the only active
    // one) must never be consulted here at all, let alone override a genuine completed match. This
    // replaces the prior single-priority-ref ("finalActiveRefs[0] ?? partialActiveRefs[0] ?? first")
    // selection, which let an unrelated active "partial" candidate hijack the result ahead of ever
    // checking whether the true, matched representation was completed (the confirmed NEG1 bug: a
    // different-topic "partial" candidate outranked and pre-empted the real, correctly-closed demo).
    const sub = subOutcomes[0];
    const matchedCandidates = sub.coverage.candidates.filter((c) => c.finalStatus === "matched");
    if (matchedCandidates.length === 0) return "missed";
    // "eligible" (not finalActiveRefs, which also requires foundInFinalOutput) is the right bar for
    // "still open" here -- a demo item that hasn't yet been consolidated into final persisted output
    // is still meaningfully "left open" for completed_during_meeting purposes.
    const matchedActiveExists = matchedCandidates.some((c) => c.eligible);
    // Accepts EITHER valid completion path -- PATH A (lifecycle-confirmed) or PATH B (already
    // completed at extraction time, persisted directly) -- see hasCompletionEvidence.
    const matchedCompletedExists = matchedCandidates.some((c) => hasCompletionEvidence(sub, c));
    if (matchedActiveExists) return "wrong_state"; // covers both "active only" and "active + completed duplicate" -- see qualityFlags.duplicate for the latter
    if (matchedCompletedExists) return "correct";
    return "partial"; // matched, but neither completed nor eligible (e.g. still proposed) -- unresolved, not missed
  }

  // expectedState === "active"
  const matchedCount = subOutcomes.filter((s) => s.subOutcomeStatus === "matched").length;
  const anyRepresented = subOutcomes.some((s) => s.subOutcomeStatus === "matched" || s.subOutcomeStatus === "partially_matched");
  if (!anyRepresented) return "missed";

  const activeItems = subOutcomes
    .flatMap((s) => [...s.finalActiveRefs, ...s.partialActiveRefs])
    .map((ref) => snapshot.workItems.find((item) => item.ref === ref))
    .filter((item): item is WorkItem => item !== undefined);
  const ownerMismatch = activeItems.length > 0 && !activeItems.some((item) => ownersOverlap(owners, [item.owner, ...item.owners]));
  if (ownerMismatch) return "wrong_owner";

  if (matchedCount === subOutcomes.length) return "correct";
  return "partial";
}

function combineEarliestFailureStage(subOutcomes: SubOutcomeTrace[]): EarliestFailureStage {
  const order: EarliestFailureStage[] = [
    "needs_review",
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
  const failing = subOutcomes.map((s) => s.earliestFailureStage).filter((s) => s !== "none");
  if (failing.length === 0) return "none";
  return failing.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

export async function traceGroundTruthItem(
  groundTruth: GroundTruthItem,
  snapshot: MeetingSnapshot,
  judge?: SemanticBatchJudge
): Promise<GroundTruthItemTrace> {
  const isCompound = Boolean(groundTruth.compound_outcomes && groundTruth.compound_outcomes.length > 0);
  const subOutcomeTexts = isCompound ? (groundTruth.compound_outcomes as string[]) : [groundTruth.semantic_outcome];

  const subOutcomes: SubOutcomeTrace[] = [];
  for (const text of subOutcomeTexts) {
    // Sequential, not Promise.all -- keeps semantic-judge call volume easy to reason about/throttle
    // and keeps ordering deterministic for reporting; sub-outcome counts per GT item are small.
    subOutcomes.push(
      await traceSubOutcome({
        subOutcome: text,
        owners: groundTruth.owners,
        sourceSegmentIds: groundTruth.source_segment_ids,
        snapshot,
        judge
      })
    );
  }

  return {
    groundTruthId: groundTruth.id,
    expectedState: groundTruth.expected_state,
    owners: groundTruth.owners,
    isCompound,
    subOutcomes,
    finalResult: combineFinalResult({ expectedState: groundTruth.expected_state, owners: groundTruth.owners, subOutcomes, snapshot }),
    qualityFlags: computeQualityFlags(groundTruth.expected_state, subOutcomes),
    earliestFailureStage: combineEarliestFailureStage(subOutcomes)
  };
}
