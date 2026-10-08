import { isEphemeralCompletedMeetingAction } from "./execution-tree";
import type { CommitmentCandidate, ExecutionGraph, TaskCandidate } from "./schemas";
import type { ExecutionTree, TaskMergeProvenance, WorkItem } from "./work-item-schemas";

/**
 * A genuinely completed-during-meeting WorkItem (see isCompletedDuringMeeting in
 * execution-tree.ts) becomes its own zero-task commitment with `completion_state: "completed"` --
 * the one commitment shape that already has a real, working path to a persisted `status:
 * "completed"` row (see persistence.ts / the `replace_meeting_execution_graph` RPC's existing
 * completion_state -> status mapping). Deliberately NOT routed through the regular
 * commitment-mapping below, which hardcodes `completion_state: "open"` for every entry -- that
 * hardcoding is correct for `tree.commitments` (by construction, by the time an item reaches that
 * array it has already cleared `isExecutionEligible`, which itself requires status to be
 * open/in_progress/blocked, never completed), so it is intentionally left unchanged here; this is
 * a separate, additive construction path for the separate `completed_work` bucket only.
 */
function completedWorkItemToCommitmentCandidate(item: WorkItem): CommitmentCandidate {
  return {
    client_ref: item.ref,
    topic_id: item.topic_id,
    title: item.title,
    description: item.description,
    owner: item.owner,
    owners: item.owners,
    due_date: item.due_date,
    due_date_text: item.due_date_text,
    priority: "medium",
    confidence: item.confidence ?? 0.75,
    source_quote: item.source_quote,
    source_segment_ids: item.source_segment_ids,
    evidence_source: "transcript",
    conversation_event_ids: [],
    type: item.owner ? "personal" : "unassigned",
    completion_state: "completed",
    execution_classification: "committed",
    consolidated_from_refs: [],
    supporting_action_refs: [item.ref],
    commitment_reason: item.extraction_reason ?? item.classification_reason,
    scope_added_beyond_actions: null,
    acceptance_criteria: [],
    group_basis: "completed_during_meeting",
    primary_owner_reason: item.owner
      ? "Completed work's own owner is the accountable owner."
      : "No owner resolved for this completed action."
  };
}

/**
 * Flattens the V4 execution tree into the legacy ExecutionGraph shape (commitments + tasks with a
 * nullable commitment_ref) purely so the existing `meeting_commitments` / `meeting_tasks`
 * persistence path can be reused without a schema migration. The tree, not this flat shape, is the
 * authoritative V4 output -- this function only exists at the boundary to storage.
 */
export function treeToExecutionGraph(
  tree: ExecutionTree,
  provenanceByRef: Record<string, TaskMergeProvenance> = {}
): ExecutionGraph {
  const commitments: CommitmentCandidate[] = tree.commitments.map((commitment) => {
    const evidenceQuote =
      commitment.tasks[0]?.source_quote ??
      commitment.explicit_outcome_evidence?.source_quote ??
      commitment.title;
    // Evidence union: member tasks, acceptance criteria, AND (for the zero-task case) the group's
    // own explicit_outcome_evidence -- a multi-criteria commitment's description can state material
    // requirements (e.g. an output format, a cost estimate, a retry behavior) that live entirely on
    // its acceptance_criteria, not on any member task; omitting them here left those requirements in
    // the persisted description with no traceable segment-level provenance back to the transcript.
    const evidenceSegmentIds = Array.from(
      new Set([
        ...commitment.tasks.flatMap((task) => task.source_segment_ids),
        ...commitment.acceptance_criteria.flatMap((criterion) => criterion.source_segment_ids),
        ...(commitment.tasks.length === 0
          ? commitment.explicit_outcome_evidence?.source_segment_ids ?? []
          : [])
      ])
    );
    return {
      client_ref: commitment.ref,
      topic_id: null,
      title: commitment.title,
      description: commitment.description,
      owner: commitment.owner,
      owners: commitment.owners,
      due_date: commitment.due_date,
      due_date_text: commitment.due_date_text,
      priority: "medium",
      confidence: 0.85,
      source_quote: evidenceQuote,
      source_segment_ids: evidenceSegmentIds,
      evidence_source: "transcript",
      conversation_event_ids: [],
      type: commitment.owner ? "personal" : "unassigned",
      completion_state: "open",
      execution_classification: "committed",
      consolidated_from_refs: [],
      // Member tasks AND acceptance criteria -- both are work-item refs that materially
      // contributed to this commitment's scope/description (see evidenceSegmentIds above for the
      // matching segment-level union).
      supporting_action_refs: [...commitment.member_refs, ...commitment.acceptance_criteria_refs],
      commitment_reason: commitment.purpose_reason,
      scope_added_beyond_actions: null,
      // A resolved single accountable owner (see final-reconciliation.ts's ownership repair pass)
      // makes this a "personal" commitment regardless of how many contributors have child tasks --
      // having supporting contributors is never itself evidence of shared/team accountability.
      // "team" is reserved for a commitment with no resolvable single owner at all.
      acceptance_criteria: commitment.acceptance_criteria.map((criterion) => ({
        ref: criterion.ref,
        title: criterion.title,
        description: criterion.description,
        source_quote: criterion.source_quote,
        source_segment_ids: criterion.source_segment_ids
      })),
      group_basis: commitment.group_basis,
      primary_owner_reason: commitment.primary_owner_reason
    };
  });

  function toTaskCandidate(item: WorkItem, commitmentRef: string | null): TaskCandidate {
    return {
      client_ref: item.ref,
      commitment_ref: commitmentRef,
      topic_id: item.topic_id,
      title: item.title,
      description: item.description,
      owner: item.owner,
      owners: item.owners,
      due_date: item.due_date,
      due_date_text: item.due_date_text,
      priority: "medium",
      confidence: item.confidence ?? 0.75,
      source_quote: item.source_quote,
      source_segment_ids: item.source_segment_ids,
      evidence_source: "transcript",
      conversation_event_ids: [],
      inferred: false,
      task_type: "commitment",
      workspace_type: "other",
      suggested_steps: [],
      execution_classification: "committed",
      consolidated_from_refs: [],
      action_classification: item.classification,
      action_status: item.status,
      requester: item.requester,
      recipient: item.recipient,
      extraction_reason: item.extraction_reason,
      relationship_confidence: null,
      relationship_reason: commitmentRef
        ? `Claimed by a verified group as part of its accepted outcome.`
        : "Active accepted work not claimed by any verified group.",
      relationship_evidence: [],
      relationship_decision: commitmentRef ? "child_task" : "standalone_task",
      work_item_role: item.work_item_role,
      scope_state: item.scope_state,
      merge_provenance: provenanceByRef[item.ref] ?? null
    };
  }

  const tasks: TaskCandidate[] = [
    ...tree.commitments.flatMap((commitment) =>
      commitment.tasks.map((task) => toTaskCandidate(task, commitment.ref))
    ),
    ...tree.standalone_tasks.map((task) => toTaskCandidate(task, null))
  ];

  // Completed-during-meeting history: one zero-task, completion_state="completed" commitment per
  // item, appended to (never merged with) the active commitments above -- see
  // completedWorkItemToCommitmentCandidate. Never produces a task candidate for the same ref, so
  // a genuine in-meeting completion persists exactly once, as a closed commitment, never as an
  // open task. isCompletedDuringMeeting's own classification is untouched -- an ephemeral
  // meeting-process action (opening a template, reviewing bullet points, asking someone their
  // goal) is still genuinely "completed history," it just never becomes its own persisted
  // workspace row; a material completed deliverable (sent, delivered, published, finished, handed
  // off) is unaffected by this filter and still persists exactly as before.
  const completedCommitments = (tree.completed_work ?? [])
    .filter((item) => !isEphemeralCompletedMeetingAction(item))
    .map(completedWorkItemToCommitmentCandidate);

  return { commitments: [...commitments, ...completedCommitments], tasks };
}
