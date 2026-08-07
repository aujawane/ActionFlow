import { transcriptSourceSegmentIds } from "./conversation-event-identity";
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

/**
 * The single deterministic eligibility gate for grouping membership and for the final tree.
 * Personal logistics, informational status, unaccepted requests/proposals/ideas/questions,
 * decisions with no accepted follow-up, and completed work are never eligible -- by construction,
 * not by a later filter -- so they can never persist as pending work, child or standalone.
 */
export function isExecutionEligible(item: WorkItem) {
  return (
    item.execution_scope === "project_work" &&
    item.acceptance_state === "accepted" &&
    ELIGIBLE_STATUSES.includes(item.status) &&
    ELIGIBLE_CLASSIFICATIONS.includes(item.classification)
  );
}

function normalizeEvidenceText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

/** A group's stated scope is vacuous when it says nothing beyond its one member's own wording. */
function isVacuousScopeStatement(scope: string | null | undefined, member: WorkItem) {
  const normalized = normalizeEvidenceText(scope);
  if (!normalized) return true;
  return (
    normalized === normalizeEvidenceText(member.title) ||
    normalized === normalizeEvidenceText(member.description) ||
    normalized === normalizeEvidenceText(member.source_quote)
  );
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
  disposition: "child" | "standalone" | "excluded_ineligible";
  reason: string;
};

export type AssembledExecutionTree = {
  tree: ExecutionTree;
  groupDecisions: GroupDecision[];
  workItemDecisions: WorkItemDecision[];
};

/**
 * Deterministically assembles the final execution tree from verified grouping output. This is the
 * only place a group is accepted, rejected, or demoted, and the only place "standalone" is
 * decided -- it is always the computed complement of claimed eligible work items, never a modeled
 * choice. Work-item-level correction (classification, status, acceptance_state, execution_scope,
 * owner, evidence) happens upstream in the global correction stage; this function never rewrites a
 * work item, it only decides which ones a group may keep.
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
  const claimedRefs = new Set<string>();
  const commitments: Array<GroupProposal & { tasks: WorkItem[] }> = [];

  let newGroupIndex = 0;
  const seenDraftRefs = new Set<string>();

  for (const verified of input.verifiedGroups) {
    const isNew = verified.ref === null;
    const draft = verified.ref !== null ? draftByRef.get(verified.ref) : undefined;
    if (!isNew && !draft) {
      // The verifier echoed a ref that was never proposed; ignore it defensively.
      continue;
    }
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
      purpose_reason: verified.purpose_reason,
      scope_added_beyond_members: verified.scope_added_beyond_members,
      explicit_outcome_evidence: verified.explicit_outcome_evidence
    };

    // A group may only ever reference refs that actually exist and are eligible. Any reference to
    // an unknown or ineligible ref rejects the whole group -- it is never silently repaired,
    // because grouping/verification were only ever given the eligible universe to begin with, so
    // such a reference is either a hallucination or an attempt to smuggle in excluded work.
    const unknownOrIneligible = candidate.member_refs.filter((memberRef) => {
      const item = workItemsByRef.get(memberRef);
      return !item || !isExecutionEligible(item);
    });
    if (unknownOrIneligible.length > 0) {
      groupDecisions.push({
        group_ref: ref,
        disposition: "removed",
        reason: `References unknown or ineligible ref(s): ${unknownOrIneligible.join(", ")}.`
      });
      continue;
    }

    // Among refs confirmed eligible, an earlier group in this same run may already have claimed
    // one -- that is ordinary first-claim-wins competition between two legitimate groups, not an
    // eligibility failure, so it only shrinks this group rather than rejecting it outright.
    const resolvedMembers = candidate.member_refs
      .filter((memberRef) => !claimedRefs.has(memberRef))
      .map((memberRef) => workItemsByRef.get(memberRef)!);

    if (candidate.group_basis === "explicit_outcome") {
      if (resolvedMembers.length > 1) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: `group_basis=explicit_outcome allows at most one member; had ${resolvedMembers.length} after claim resolution.`
        });
        continue;
      }
      const validEvidence = isValidOutcomeEvidence(candidate.explicit_outcome_evidence, validSegments);
      if (!validEvidence) {
        groupDecisions.push({
          group_ref: ref,
          disposition: "removed",
          reason: "explicit_outcome group has no valid explicit_outcome_evidence."
        });
        continue;
      }
      if (resolvedMembers.length === 1) {
        // Verbose scope text alone is never sufficient -- valid evidence (already checked above)
        // is required in addition to a non-vacuous scope statement, not instead of it.
        if (isVacuousScopeStatement(candidate.scope_added_beyond_members, resolvedMembers[0])) {
          groupDecisions.push({
            group_ref: ref,
            disposition: "demoted_to_standalone",
            reason: "Single member with no real scope beyond that member; its work item becomes standalone."
          });
          continue;
        }
        claimedRefs.add(resolvedMembers[0].ref);
        groupDecisions.push({
          group_ref: ref,
          disposition: isNew ? "added" : "kept",
          reason: "explicit_outcome with one member: valid evidence and genuinely broader scope."
        });
        commitments.push({ ...candidate, member_refs: [resolvedMembers[0].ref], tasks: resolvedMembers });
        continue;
      }
      // Zero members: a pure explicit accepted outcome grounded in its own evidence.
      groupDecisions.push({
        group_ref: ref,
        disposition: isNew ? "added" : "kept",
        reason: "explicit_outcome with zero members: valid explicit accepted-outcome evidence."
      });
      commitments.push({ ...candidate, member_refs: [], tasks: [] });
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
    for (const member of resolvedMembers) claimedRefs.add(member.ref);
    groupDecisions.push({
      group_ref: ref,
      disposition: "kept",
      reason: "Verified as a broader outcome supported by its member work items."
    });
    commitments.push({
      ...candidate,
      member_refs: resolvedMembers.map((member) => member.ref),
      tasks: resolvedMembers
    });
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
    if (!isExecutionEligible(item)) {
      workItemDecisions.push({
        work_item_ref: item.ref,
        claimed_group_ref: null,
        disposition: "excluded_ineligible",
        reason: `Not eligible (execution_scope=${item.execution_scope}, acceptance_state=${item.acceptance_state}, status=${item.status}, classification=${item.classification}).`
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

  return {
    tree: { commitments, standalone_tasks: standaloneTasks },
    groupDecisions,
    workItemDecisions
  };
}
