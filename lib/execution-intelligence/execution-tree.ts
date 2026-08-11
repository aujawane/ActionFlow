import { transcriptSourceSegmentIds } from "./conversation-event-identity";
import { semanticTokenSimilarity } from "./graph";
import type {
  ExecutionTree,
  GroupProposal,
  RawGroupProposal,
  VerifiedGroup,
  WorkItem
} from "./work-item-schemas";

const ELIGIBLE_CLASSIFICATIONS = [
  "open_task",
  "assignment",
  "promise",
  "accepted_request",
  "scheduling",
  "in_progress"
];
const ELIGIBLE_STATUSES = ["open", "in_progress", "blocked"];
const ELIGIBLE_ROLES = ["action", "input_dependency"];

/**
 * The single deterministic eligibility gate for grouping membership and for the final tree.
 * Personal logistics, informational status, unaccepted requests/proposals/ideas/questions,
 * decisions with no accepted follow-up, completed work, acceptance criteria, scope decisions,
 * future features, references, and anything not in current scope are never eligible -- by
 * construction, not by a later filter -- so none of them can ever persist as pending work, child
 * or standalone.
 */
export function isExecutionEligible(item: WorkItem) {
  return (
    item.execution_scope === "project_work" &&
    item.acceptance_state === "accepted" &&
    item.scope_state === "current_scope" &&
    ELIGIBLE_STATUSES.includes(item.status) &&
    ELIGIBLE_CLASSIFICATIONS.includes(item.classification) &&
    ELIGIBLE_ROLES.includes(item.work_item_role)
  );
}

/** A current-scope requirement attachable to a commitment. Never a task, never standalone. */
export function isEligibleAcceptanceCriterion(item: WorkItem) {
  return item.scope_state === "current_scope" && item.work_item_role === "acceptance_criterion";
}

/** A current-scope item explicitly deferred, i.e. everything the "future scope" UI surfaces. */
export function isFutureScopeItem(item: WorkItem) {
  return item.scope_state === "future_scope" && item.work_item_role !== "reference";
}

function normalizeEvidenceText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isValidOutcomeEvidence(
  evidence: { source_quote: string; source_segment_ids: string[] } | null,
  validSegments: Set<string>
) {
  return (
    Boolean(evidence?.source_quote?.trim()) &&
    (evidence?.source_segment_ids ?? []).some((id) => validSegments.has(id))
  );
}

/** For a single-member explicit_deliverable, the member itself already carries validated
 * grounding (it would not be execution-eligible otherwise) -- the prompt tells the model to copy
 * that member's own quote/segment IDs into explicit_outcome_evidence verbatim (see
 * work-item-prompts.ts's group_basis guidance), but a model omitting or slightly diverging from
 * that copy is a presentation slip, not evidence that the deliverable itself is ungrounded.
 * Falling back to the member's own evidence here is what keeps an explicit, accepted,
 * single-task deliverable (owner, future result, completion condition, optional deadline) from
 * being discarded to standalone over nothing more than the model forgetting to restate evidence
 * it already had to establish eligibility in the first place. */
function memberEvidenceIsValid(member: WorkItem, validSegments: Set<string>) {
  return Boolean(member.source_quote?.trim()) && member.source_segment_ids.some((id) => validSegments.has(id));
}

/** An explicit_deliverable group is redundant when its own evidence and title are just its one
 * member restated verbatim -- no broader outcome was actually articulated. */
function isRedundantSingleMemberOutcome(
  candidate: Pick<GroupProposal, "title" | "explicit_outcome_evidence">,
  member: WorkItem
) {
  const sameTitle = normalizeEvidenceText(candidate.title) === normalizeEvidenceText(member.title);
  const sameQuote =
    normalizeEvidenceText(candidate.explicit_outcome_evidence?.source_quote) ===
    normalizeEvidenceText(member.source_quote);
  return sameTitle && sameQuote;
}

/** A description that just restates one member/acceptance-criterion item is misleading on a
 * broader-titled group; strip it rather than reject work that is otherwise well-supported. */
function sanitizeNarrowDescription(
  description: string | null,
  items: WorkItem[]
): { description: string | null; wasNarrow: boolean } {
  if (!description || items.length < 2) return { description, wasNarrow: false };
  const normalized = normalizeEvidenceText(description);
  const matchesExactlyOne = items.filter(
    (item) =>
      normalizeEvidenceText(item.title) === normalized ||
      normalizeEvidenceText(item.description) === normalized ||
      normalizeEvidenceText(item.source_quote) === normalized
  ).length;
  if (matchesExactlyOne === 1) return { description: null, wasNarrow: true };
  return { description, wasNarrow: false };
}

// ============================================================
// Deterministic explicit-deliverable recovery (no model call)
// ============================================================

/** A narrow, explicitly-scoped set of deliverable-outcome verb phrases -- only ever a confirming
 * signal alongside classification="promise" (see hasExplicitDeliverableEvidence), never sufficient
 * on its own. Deliberately does not include generic action verbs ("contact", "test", "review",
 * "text") -- an ordinary task phrased as a first-person promise must not qualify by verb alone. */
const DELIVERABLE_OUTCOME_PATTERN =
  /\b(deploy(?:s|ed|ing)?|deliver(?:s|ed|ing)?|present(?:s|ed|ing)?|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)?|send (?:the|a|an) finished|have (?:a|the) (?:version|draft|release)|ready to (?:share|present|ship|deploy|deliver))\b/i;

export type ExplicitDeliverableEvidenceResult = {
  eligible: boolean;
  reason: string;
};

/** Of the six ELIGIBLE_CLASSIFICATIONS, only these two inherently mean "an accepted, future,
 * accountable outcome" as opposed to routine delegated/open work ("assignment", "open_task",
 * "scheduling", "in_progress" can all describe perfectly ordinary child-task-shaped actions with
 * an owner, a due date, or even a named recipient, none of which makes them independent
 * deliverables). Every strong signal below requires this baseline first -- a due date or a
 * recipient on an "assignment" is not enough on its own; recovery needs both. */
const STRONG_SIGNAL_CLASSIFICATIONS = new Set(["promise", "accepted_request"]);

/**
 * Deterministic, no-model-call check for whether one work item independently carries strong
 * enough explicit-deliverable evidence to justify recovering it into its own commitment when
 * grouping/verification left it unclaimed (see recoverExplicitDeliverables). Structured fields
 * already extracted upstream come first (classification, due date, recipient); the only lexical
 * check is the narrow verb pattern above, and only as a second, confirming condition alongside
 * classification="promise" -- phrase matching alone never qualifies an item.
 */
export function hasExplicitDeliverableEvidence(
  item: WorkItem,
  validSegments: Set<string>
): ExplicitDeliverableEvidenceResult {
  if (!isExecutionEligible(item)) {
    return {
      eligible: false,
      reason: `Not execution-eligible (execution_scope=${item.execution_scope}, acceptance_state=${item.acceptance_state}, scope_state=${item.scope_state}, status=${item.status}, classification=${item.classification}, work_item_role=${item.work_item_role}).`
    };
  }
  if (!item.owner?.trim()) {
    return { eligible: false, reason: "No resolved owner; accountability cannot be attributed." };
  }
  if (!memberEvidenceIsValid(item, validSegments)) {
    return { eligible: false, reason: "No valid grounded evidence (empty quote, or no segment id present in this transcript)." };
  }
  if (!STRONG_SIGNAL_CLASSIFICATIONS.has(item.classification)) {
    return {
      eligible: false,
      reason: `Classification "${item.classification}" does not itself signal an accepted future deliverable (requires promise or accepted_request) -- a due date or recipient alone on routine/assigned work is not independent deliverable evidence.`
    };
  }

  // Only the RESOLVED, structured due_date counts -- due_date_text is a raw, unvalidated capture
  // of whatever timing language the transcript used, which can be as vague as "soon" or
  // "eventually" and must never independently justify recovery on its own.
  if (item.due_date) {
    return { eligible: true, reason: `Explicit deadline evidence (due_date=${item.due_date}).` };
  }
  if (item.recipient?.trim()) {
    return { eligible: true, reason: `Explicit handoff evidence (recipient=${item.recipient}), classification=${item.classification}.` };
  }
  if (item.classification === "accepted_request") {
    return {
      eligible: true,
      reason: "Explicit requested outcome immediately followed by acceptance (classification=accepted_request)."
    };
  }
  if (item.classification === "promise" && DELIVERABLE_OUTCOME_PATTERN.test(item.source_quote)) {
    return {
      eligible: true,
      reason: "Explicit promise phrased as a future deliverable result (classification=promise, deliverable-outcome verb in its own source quote)."
    };
  }
  return {
    eligible: false,
    reason: "No strong deliverable signal (no resolved due date, no recipient, and its quote has no deliverable-outcome verb)."
  };
}

/** Is this eligible-but-unclaimed item already completion-equivalent to an existing commitment's
 * own outcome, or to one of its child tasks? Reuses the same token-overlap signal and threshold
 * final-reconciliation.ts's reconcileStandaloneDuplicates uses for the identical judgment
 * post-consolidation, so an item is never independently recovered as a new commitment when it is
 * really just a restatement of work already represented elsewhere in the tree. */
function findEquivalentExisting(
  item: WorkItem,
  commitments: ExecutionTree["commitments"]
): { commitmentRef: string; taskRef: string | null; score: number } | null {
  const EQUIVALENCE_THRESHOLD = 0.5;
  let best: { commitmentRef: string; taskRef: string | null; score: number } | null = null;
  for (const commitment of commitments) {
    const titleScore = semanticTokenSimilarity(item.title, commitment.title);
    if (titleScore >= EQUIVALENCE_THRESHOLD && (!best || titleScore > best.score)) {
      best = { commitmentRef: commitment.ref, taskRef: null, score: titleScore };
    }
    for (const task of commitment.tasks) {
      const taskScore = semanticTokenSimilarity(item.title, task.title);
      if (taskScore >= EQUIVALENCE_THRESHOLD && (!best || taskScore > best.score)) {
        best = { commitmentRef: commitment.ref, taskRef: task.ref, score: taskScore };
      }
    }
  }
  return best;
}

export type RecoveryDecision = {
  work_item_ref: string;
  disposition: "recovered" | "not_recovered" | "already_equivalent";
  reason: string;
  created_commitment_ref: string | null;
};

/**
 * Runs once, after the standalone complement is computed, over exactly the eligible items
 * grouping/verification left unclaimed -- never over anything already claimed as a child or
 * acceptance criterion. A recovered commitment reuses the exact one-member explicit_deliverable
 * shape and evidence-fallback rule assembly's own commitCandidate path already applies (see
 * memberEvidenceIsValid above): the work item's own validated quote/segment IDs become
 * explicit_outcome_evidence directly, with no model call and no new promotion mechanism. Each
 * standalone item is checked independently against the ORIGINAL (pre-recovery) commitment set
 * only -- two independently strong-evidenced recoveries are never equivalence-checked against each
 * other, since by construction each already cleared its own bar for being a distinct deliverable.
 */
function recoverExplicitDeliverables(
  commitments: ExecutionTree["commitments"],
  standaloneTasks: WorkItem[],
  validSegments: Set<string>
): {
  commitments: ExecutionTree["commitments"];
  standaloneTasks: WorkItem[];
  decisions: RecoveryDecision[];
} {
  const decisions: RecoveryDecision[] = [];
  const recovered: ExecutionTree["commitments"] = [];
  const survivingStandalone: WorkItem[] = [];
  let recoveryIndex = 0;

  for (const item of standaloneTasks) {
    const evidence = hasExplicitDeliverableEvidence(item, validSegments);
    if (!evidence.eligible) {
      decisions.push({
        work_item_ref: item.ref,
        disposition: "not_recovered",
        reason: evidence.reason,
        created_commitment_ref: null
      });
      survivingStandalone.push(item);
      continue;
    }

    const equivalent = findEquivalentExisting(item, commitments);
    if (equivalent) {
      decisions.push({
        work_item_ref: item.ref,
        disposition: "already_equivalent",
        reason: equivalent.taskRef
          ? `Completion-equivalent to existing child task ${equivalent.taskRef} of commitment ${equivalent.commitmentRef} (similarity ${equivalent.score.toFixed(2)}); left for existing disposition/reconciliation rather than recovered as a duplicate commitment.`
          : `Completion-equivalent to existing commitment ${equivalent.commitmentRef}'s own outcome (similarity ${equivalent.score.toFixed(2)}); not recovered as a duplicate commitment.`,
        created_commitment_ref: null
      });
      survivingStandalone.push(item);
      continue;
    }

    recoveryIndex += 1;
    const ref = `recovered_${recoveryIndex}`;
    recovered.push({
      ref,
      title: item.title,
      description: item.description,
      owner: item.owner,
      owners: item.owners,
      due_date: item.due_date,
      due_date_text: item.due_date_text,
      group_basis: "explicit_deliverable",
      member_refs: [item.ref],
      acceptance_criteria_refs: [],
      purpose_reason: `Recovered: an eligible work item with direct explicit-deliverable evidence was left unclaimed by grouping/verification. ${evidence.reason}`,
      explicit_outcome_evidence: {
        source_quote: item.source_quote,
        source_segment_ids: item.source_segment_ids
      },
      tasks: [item],
      acceptance_criteria: [],
      primary_owner_reason: "Recovered explicit deliverable: the work item's own owner is the accountable owner."
    });
    decisions.push({
      work_item_ref: item.ref,
      disposition: "recovered",
      reason: `Recovered as a new one-member explicit_deliverable commitment. ${evidence.reason}`,
      created_commitment_ref: ref
    });
  }

  return {
    commitments: [...commitments, ...recovered],
    standaloneTasks: survivingStandalone,
    decisions
  };
}

/** Assigns application-owned refs to a model's raw group output. The model never owns identity. */
export function assignDraftGroupRefs(groups: RawGroupProposal[]): GroupProposal[] {
  return groups.map((group, index) => ({ ...group, ref: `group_g${index + 1}` }));
}

export type GroupDecision = {
  group_ref: string;
  disposition: "kept" | "removed" | "demoted_to_standalone" | "added";
  reason: string;
};

export type WorkItemDecision = {
  work_item_ref: string;
  claimed_group_ref: string | null;
  disposition: "child" | "acceptance_criterion" | "standalone" | "excluded_ineligible";
  reason: string;
};

export type AssembledExecutionTree = {
  tree: ExecutionTree;
  groupDecisions: GroupDecision[];
  workItemDecisions: WorkItemDecision[];
  recoveryDecisions: RecoveryDecision[];
};

/**
 * Deterministically assembles the final execution tree from verified grouping output. This is the
 * only place a group is accepted, rejected, or demoted, and the only place "standalone" is
 * decided -- it is always the computed complement of claimed eligible work items, never a modeled
 * choice. Work-item-level correction/reconciliation happens upstream in the global correction
 * stage; this function never rewrites a work item's evidence, only its description-sanitization
 * pass (narrow-description stripping) touches presentation, and only on the group, never the item.
 */
export function assembleExecutionTree(input: {
  transcript: string;
  workItems: WorkItem[];
  draftGroups: GroupProposal[];
  verifiedGroups: VerifiedGroup[];
}): AssembledExecutionTree {
  const validSegments = new Set(transcriptSourceSegmentIds(input.transcript));
  const workItemsByRef = new Map(input.workItems.map((item) => [item.ref, item]));
  const draftByRef = new Map(input.draftGroups.map((group) => [group.ref, group]));

  const groupDecisions: GroupDecision[] = [];
  const claimedTaskRefs = new Set<string>();
  const claimedCriterionRefs = new Set<string>();
  const commitments: ExecutionTree["commitments"] = [];

  let newGroupIndex = 0;
  const seenDraftRefs = new Set<string>();

  for (const verified of input.verifiedGroups) {
    const isNew = verified.ref === null;
    const draft = verified.ref !== null ? draftByRef.get(verified.ref) : undefined;
    if (!isNew && !draft) continue; // verifier echoed an unknown ref; ignore defensively
    if (draft) seenDraftRefs.add(draft.ref);

    const ref = isNew ? `group_new_${++newGroupIndex}` : draft!.ref;
    const candidate: GroupProposal = {
      ref,
      title: verified.title,
      description: verified.description,
      owner: verified.owner,
      owners: verified.owners,
      due_date: verified.due_date,
      due_date_text: verified.due_date_text,
      group_basis: verified.group_basis,
      member_refs: verified.member_refs,
      acceptance_criteria_refs: verified.acceptance_criteria_refs,
      purpose_reason: verified.purpose_reason,
      explicit_outcome_evidence: verified.explicit_outcome_evidence
    };

    // A group may only reference refs that actually exist and are eligible for the role being
    // claimed. Any reference to an unknown/ineligible ref rejects the whole group outright --
    // grouping/verification were only ever given the eligible/criterion universe, so such a
    // reference is either a hallucination or an attempt to smuggle in excluded work.
    const unknownOrIneligibleMembers = candidate.member_refs.filter((memberRef) => {
      const item = workItemsByRef.get(memberRef);
      return !item || !isExecutionEligible(item);
    });
    const unknownOrIneligibleCriteria = candidate.acceptance_criteria_refs.filter((criterionRef) => {
      const item = workItemsByRef.get(criterionRef);
      return !item || !isEligibleAcceptanceCriterion(item);
    });
    if (unknownOrIneligibleMembers.length > 0 || unknownOrIneligibleCriteria.length > 0) {
      groupDecisions.push({
        group_ref: ref,
        disposition: "removed",
        reason: `References unknown or ineligible ref(s): ${[
          ...unknownOrIneligibleMembers,
          ...unknownOrIneligibleCriteria
        ].join(", ")}.`
      });
      continue;
    }

    const resolvedMembers = candidate.member_refs
      .filter((memberRef) => !claimedTaskRefs.has(memberRef))
      .map((memberRef) => workItemsByRef.get(memberRef)!);
    const resolvedCriteria = candidate.acceptance_criteria_refs
      .filter((criterionRef) => !claimedCriterionRefs.has(criterionRef))
      .map((criterionRef) => workItemsByRef.get(criterionRef)!);

    const commitCandidate = (finalMembers: WorkItem[], reason: string) => {
      for (const member of finalMembers) claimedTaskRefs.add(member.ref);
      for (const criterion of resolvedCriteria) claimedCriterionRefs.add(criterion.ref);
      const owner =
        candidate.owner ??
        (() => {
          if (finalMembers.length === 0) return null;
          const counts = new Map<string, number>();
          for (const member of finalMembers) {
            const key = member.owner?.trim();
            if (!key) continue;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const [top] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
          return top ? top[0] : null;
        })();
      const primaryOwnerReason = candidate.owner
        ? "Declared accountable owner from grouping/verification."
        : owner
          ? `Inferred as the owner of the most member tasks (${owner}).`
          : "No single accountable owner could be determined from member ownership.";
      const sanitized = sanitizeNarrowDescription(candidate.description, [
        ...finalMembers,
        ...resolvedCriteria
      ]);
      groupDecisions.push({
        group_ref: ref,
        disposition: isNew ? "added" : "kept",
        reason: sanitized.wasNarrow ? `${reason} Description was narrower than the title; cleared.` : reason
      });
      commitments.push({
        ...candidate,
        owner,
        description: sanitized.description,
        member_refs: finalMembers.map((member) => member.ref),
        acceptance_criteria_refs: resolvedCriteria.map((criterion) => criterion.ref),
        tasks: finalMembers,
        acceptance_criteria: resolvedCriteria,
        primary_owner_reason: primaryOwnerReason
      });
    };

    if (candidate.group_basis === "explicit_zero_task_outcome") {
      if (resolvedMembers.length !== 0) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: `explicit_zero_task_outcome must have zero members; had ${resolvedMembers.length} after claim resolution.`
        });
        continue;
      }
      if (!isValidOutcomeEvidence(candidate.explicit_outcome_evidence, validSegments)) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: "explicit_zero_task_outcome has no valid explicit_outcome_evidence."
        });
        continue;
      }
      commitCandidate([], "Explicit accepted outcome with zero work items; valid evidence.");
      continue;
    }

    if (candidate.group_basis === "explicit_deliverable" && resolvedMembers.length > 1) {
      // Verification sometimes labels a group explicit_deliverable (there's a clear accepted
      // outcome/deadline) while still legitimately resolving >=2 supporting members -- that's
      // exactly what multi_item_shared_purpose means, not a reason to discard a group with real
      // evidence and members. Deterministically relabel to match reality rather than demoting the
      // whole group to standalone and losing it; no model call, no new category, just making the
      // existing 3-way reconciliation tolerant of this benign label/cardinality mismatch.
      candidate.group_basis = "multi_item_shared_purpose";
      commitCandidate(
        resolvedMembers,
        `Reclassified from explicit_deliverable to multi_item_shared_purpose: ${resolvedMembers.length} members after claim resolution satisfy multi_item_shared_purpose's at-least-two rule, not explicit_deliverable's exactly-one rule.`
      );
      continue;
    }

    if (candidate.group_basis === "explicit_deliverable") {
      if (resolvedMembers.length !== 1) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: `explicit_deliverable requires exactly one member; had ${resolvedMembers.length} after claim resolution.`
        });
        continue;
      }
      const ownEvidenceValid = isValidOutcomeEvidence(candidate.explicit_outcome_evidence, validSegments);
      const fallbackToMemberEvidence = !ownEvidenceValid && memberEvidenceIsValid(resolvedMembers[0], validSegments);
      if (!ownEvidenceValid && !fallbackToMemberEvidence) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: "explicit_deliverable has no valid explicit_outcome_evidence, and its single member has no valid evidence to fall back on either."
        });
        continue;
      }
      if (ownEvidenceValid && isRedundantSingleMemberOutcome(candidate, resolvedMembers[0])) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "demoted_to_standalone",
          reason: "Deliverable's title and evidence just restate its one member with no added scope; its work item becomes standalone."
        });
        continue;
      }
      commitCandidate(
        resolvedMembers,
        fallbackToMemberEvidence
          ? "explicit_deliverable with one member: the group's own explicit_outcome_evidence didn't validate, but the member's own accepted, owned, dated evidence grounds the deliverable directly."
          : "explicit_deliverable with one member: valid evidence and genuinely broader scope."
      );
      continue;
    }

    // group_basis === "multi_item_shared_purpose"
    if (resolvedMembers.length < 2) {
      groupDecisions.push({
        group_ref: ref,
        disposition: resolvedMembers.length === 1 ? "demoted_to_standalone" : "removed",
        reason: `multi_item_shared_purpose requires at least two eligible members; had ${resolvedMembers.length} after claim resolution.`
      });
      continue;
    }
    commitCandidate(resolvedMembers, "Verified as a broader outcome supported by its member work items.");
  }

  for (const draft of input.draftGroups) {
    if (!seenDraftRefs.has(draft.ref)) {
      groupDecisions.push({
        group_ref: draft.ref,
        disposition: "removed",
        reason: "Verification did not return this group; treated as unsupported."
      });
    }
  }

  const workItemDecisions: WorkItemDecision[] = [];
  const standaloneTasks: WorkItem[] = [];
  for (const item of input.workItems) {
    if (isEligibleAcceptanceCriterion(item)) {
      const owningGroup = commitments.find((commitment) =>
        commitment.acceptance_criteria_refs.includes(item.ref)
      );
      workItemDecisions.push({
        work_item_ref: item.ref,
        claimed_group_ref: owningGroup?.ref ?? null,
        disposition: "acceptance_criterion",
        reason: owningGroup
          ? `Attached as acceptance criteria to "${owningGroup.title}".`
          : "Current-scope acceptance criterion not attached to any commitment."
      });
      continue;
    }
    if (!isExecutionEligible(item)) {
      workItemDecisions.push({
        work_item_ref: item.ref,
        claimed_group_ref: null,
        disposition: "excluded_ineligible",
        reason: `Not eligible (execution_scope=${item.execution_scope}, acceptance_state=${item.acceptance_state}, scope_state=${item.scope_state}, status=${item.status}, classification=${item.classification}, work_item_role=${item.work_item_role}).`
      });
      continue;
    }
    const owningGroup = commitments.find((commitment) => commitment.member_refs.includes(item.ref));
    if (owningGroup) {
      workItemDecisions.push({
        work_item_ref: item.ref,
        claimed_group_ref: owningGroup.ref,
        disposition: "child",
        reason: `Claimed by "${owningGroup.title}".`
      });
    } else {
      standaloneTasks.push(item);
      workItemDecisions.push({
        work_item_ref: item.ref,
        claimed_group_ref: null,
        disposition: "standalone",
        reason: "Eligible work not claimed by any verified group."
      });
    }
  }

  const recovery = recoverExplicitDeliverables(commitments, standaloneTasks, validSegments);

  return {
    tree: { commitments: recovery.commitments, standalone_tasks: recovery.standaloneTasks },
    groupDecisions,
    workItemDecisions,
    recoveryDecisions: recovery.decisions
  };
}

/**
 * Phase 6: the last, cheap, purely structural check before persistence. Everything it checks
 * should already be guaranteed by construction (assembly's claim pools, consolidation only ever
 * removing/merging within a pool); this exists to catch a corrupted result -- e.g. from a bug
 * introduced by consolidation -- rather than to do assembly's job over again.
 */
export function validateFinalTree(tree: ExecutionTree): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const taskRefCounts = new Map<string, number>();
  const countRef = (ref: string) => taskRefCounts.set(ref, (taskRefCounts.get(ref) ?? 0) + 1);

  for (const commitment of tree.commitments) {
    for (const task of commitment.tasks) {
      countRef(task.ref);
      if (!isExecutionEligible(task)) {
        errors.push(`Commitment "${commitment.title}" contains ineligible task ${task.ref}.`);
      }
    }
    for (const criterion of commitment.acceptance_criteria) {
      if (!isEligibleAcceptanceCriterion(criterion)) {
        errors.push(`Commitment "${commitment.title}" contains an invalid acceptance criterion ${criterion.ref}.`);
      }
    }
    const expected =
      commitment.group_basis === "explicit_deliverable"
        ? 1
        : commitment.group_basis === "explicit_zero_task_outcome"
          ? 0
          : 2;
    const actual = commitment.tasks.length;
    const cardinalityOk =
      commitment.group_basis === "multi_item_shared_purpose" ? actual >= expected : actual === expected;
    if (!cardinalityOk) {
      errors.push(
        `Commitment "${commitment.title}" has group_basis=${commitment.group_basis} but ${actual} tasks.`
      );
    }
  }
  for (const task of tree.standalone_tasks) {
    countRef(task.ref);
    if (!isExecutionEligible(task)) {
      errors.push(`Standalone task ${task.ref} is not eligible.`);
    }
  }
  for (const [ref, count] of taskRefCounts) {
    if (count > 1) errors.push(`Task ${ref} appears ${count} times across the tree (child and/or standalone).`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
