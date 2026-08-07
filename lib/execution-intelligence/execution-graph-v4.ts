import type { CommitmentCandidate, ExecutionGraph, TaskCandidate } from "./schemas";
import type { ExecutionTree, WorkItem } from "./work-item-schemas";

/**
 * Flattens the V4 execution tree into the legacy ExecutionGraph shape (commitments + tasks with a
 * nullable commitment_ref) purely so the existing `meeting_commitments` / `meeting_tasks`
 * persistence path can be reused without a schema migration. The tree, not this flat shape, is the
 * authoritative V4 output -- this function only exists at the boundary to storage.
 */
export function treeToExecutionGraph(tree: ExecutionTree): ExecutionGraph {
  const commitments: CommitmentCandidate[] = tree.commitments.map((commitment) => {
    const evidenceQuote =
      commitment.tasks[0]?.source_quote ??
      commitment.explicit_outcome_evidence?.source_quote ??
      commitment.title;
    const evidenceSegmentIds =
      commitment.tasks.length > 0
        ? Array.from(new Set(commitment.tasks.flatMap((task) => task.source_segment_ids)))
        : commitment.explicit_outcome_evidence?.source_segment_ids ?? [];
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
      type: commitment.owners.length > 1 ? "team" : "personal",
      completion_state: "open",
      execution_classification: "committed",
      consolidated_from_refs: [],
      supporting_action_refs: commitment.member_refs,
      commitment_reason: commitment.purpose_reason,
      scope_added_beyond_actions: commitment.scope_added_beyond_members
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
      relationship_decision: commitmentRef ? "child_task" : "standalone_task"
    };
  }

  const tasks: TaskCandidate[] = [
    ...tree.commitments.flatMap((commitment) =>
      commitment.tasks.map((task) => toTaskCandidate(task, commitment.ref))
    ),
    ...tree.standalone_tasks.map((task) => toTaskCandidate(task, null))
  ];

  return { commitments, tasks };
}
