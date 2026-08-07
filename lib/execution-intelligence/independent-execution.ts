/**
 * Implements the `independent` execution-intelligence engine: parallel task/commitment
 * extraction reconciled by a relationship-evaluation pass. `v4` (work-item-schemas.ts,
 * execution-tree.ts, work-item-*.ts) is now the default engine outside production; this module
 * is kept live behind `EXECUTION_INTELLIGENCE_ENGINE=independent` for direct comparison. See
 * docs/execution-intelligence-v4.md for what changed and the removal plan for this engine.
 */
import { semanticTokenSimilarity } from "./graph";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";
import type { ExecutionSourceContext, TopicActionExtraction } from "./stages";

export type RelationshipDecision = {
  action_ref: string;
  commitment_ref: string | null;
  confidence: number | null;
  reason: string;
  supporting_evidence: string[];
};

export type VerificationDecision = {
  item_ref: string;
  item_type: "commitment" | "task";
  disposition: "kept" | "excluded" | "standalone" | "child_task" | "unlinked";
  reason: string;
};

export type IndependentExecutionTrace = {
  version: "independent-commitments-tasks-v1";
  topics: Array<{
    topic_id: string | null;
    title: string;
    transcript: string;
  }>;
  topic_actions: TopicActionExtraction[];
  merged_actions: TaskCandidate[];
  extracted_commitments: CommitmentCandidate[];
  relationship_decisions: RelationshipDecision[];
  verification_decisions: VerificationDecision[];
  commitments_debug: Array<CommitmentCandidate & { verification: VerificationDecision | null }>;
  tasks_debug: Array<
    TaskCandidate & {
      relationship: RelationshipDecision | null;
      verification: VerificationDecision | null;
    }
  >;
  final_graph: ExecutionGraph;
};

function normalizedOwners(item: Pick<TaskCandidate, "owner" | "owners">) {
  return new Set(
    [item.owner, ...item.owners]
      .filter((owner): owner is string => Boolean(owner?.trim()))
      .map((owner) => owner.trim().toLowerCase())
  );
}

function ownersCompatible(left: TaskCandidate, right: TaskCandidate) {
  const a = normalizedOwners(left);
  const b = normalizedOwners(right);
  if (a.size === 0 || b.size === 0) return true;
  return Array.from(a).some((owner) => b.has(owner));
}

function sharesEvidence(left: TaskCandidate, right: TaskCandidate) {
  const ids = new Set(left.source_segment_ids);
  return right.source_segment_ids.some((id) => ids.has(id));
}

function duplicateAction(left: TaskCandidate, right: TaskCandidate) {
  if (left.action_classification !== right.action_classification) return false;
  if (left.action_status !== right.action_status) return false;
  const similarity = semanticTokenSimilarity(left.title, right.title);
  return (
    (similarity >= 0.82 || (sharesEvidence(left, right) && similarity >= 0.65)) &&
    ownersCompatible(left, right)
  );
}

function mergeAction(left: TaskCandidate, right: TaskCandidate): TaskCandidate {
  const preferred = right.confidence > left.confidence ? right : left;
  const other = preferred === left ? right : left;
  const owners = Array.from(new Set([
    ...preferred.owners,
    ...other.owners,
    ...(preferred.owner ? [preferred.owner] : []),
    ...(other.owner ? [other.owner] : [])
  ]));
  return {
    ...preferred,
    owner: preferred.owner ?? other.owner ?? owners[0] ?? null,
    owners,
    source_segment_ids: Array.from(new Set([
      ...preferred.source_segment_ids,
      ...other.source_segment_ids
    ])),
    conversation_event_ids: Array.from(new Set([
      ...(preferred.conversation_event_ids ?? []),
      ...(other.conversation_event_ids ?? [])
    ])),
    consolidated_from_refs: Array.from(new Set([
      ...(preferred.consolidated_from_refs ?? []),
      ...(other.consolidated_from_refs ?? []),
      other.client_ref
    ]))
  };
}

export function mergeTopicActions(topicActions: TopicActionExtraction[]) {
  const merged: TaskCandidate[] = [];
  let deduplicated = 0;
  for (const action of topicActions.flatMap((topic) => topic.actions)) {
    const duplicateIndex = merged.findIndex((candidate) =>
      duplicateAction(candidate, action)
    );
    if (duplicateIndex === -1) {
      merged.push({ ...action, commitment_ref: null });
      continue;
    }
    merged[duplicateIndex] = mergeAction(merged[duplicateIndex], action);
    deduplicated += 1;
  }
  return {
    actions: merged.map((action, index) => ({
      ...action,
      client_ref: `action_a${index + 1}`,
      commitment_ref: null
    })),
    deduplicated
  };
}

function isOpenExecutionAction(task: TaskCandidate) {
  return (
    task.action_status === "open" &&
    [
      "open_task",
      "accepted_request",
      "assignment",
      "promise",
      "reminder",
      "scheduling"
    ].includes(task.action_classification ?? "")
  );
}

export function reconcileRelationshipEvaluation(input: {
  proposed: ExecutionGraph;
  evaluated: ExecutionGraph;
}) {
  const validCommitments = new Set(
    input.proposed.commitments.map((commitment) => commitment.client_ref)
  );
  const evaluatedTasks = new Map(
    input.evaluated.tasks.map((task) => [task.client_ref, task])
  );
  const tasks = input.proposed.tasks.map((task) => {
    const evaluation = evaluatedTasks.get(task.client_ref);
    const modelWantsLink = Boolean(
      evaluation?.commitment_ref && validCommitments.has(evaluation.commitment_ref)
    );
    const chosen =
      isOpenExecutionAction(task) &&
      modelWantsLink &&
      evaluation?.relationship_decision !== "uncertain"
        ? evaluation!.commitment_ref
        : null;
    const decision: TaskCandidate["relationship_decision"] = chosen
      ? "child_task"
      : evaluation?.relationship_decision === "uncertain"
        ? "uncertain"
        : "standalone_task";
    return {
      ...task,
      commitment_ref: chosen,
      relationship_confidence: evaluation?.relationship_confidence ?? null,
      relationship_reason:
        evaluation?.relationship_reason ??
        (chosen ? "Linked by relationship evaluation." : "No supported commitment relationship."),
      relationship_evidence: evaluation?.relationship_evidence ?? [],
      relationship_decision: decision
    };
  });
  const decisions: RelationshipDecision[] = tasks.map((task) => ({
    action_ref: task.client_ref,
    commitment_ref: task.commitment_ref,
    confidence: task.relationship_confidence ?? null,
    reason: task.relationship_reason ?? "No relationship reason returned.",
    supporting_evidence: task.relationship_evidence ?? []
  }));
  return {
    graph: { commitments: input.proposed.commitments, tasks },
    decisions
  };
}

function normalizeEvidenceText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

function isVacuousScopeStatement(
  scope: string | null | undefined,
  task: TaskCandidate
) {
  const normalized = normalizeEvidenceText(scope);
  if (!normalized) return true;
  return (
    normalized === normalizeEvidenceText(task.title) ||
    normalized === normalizeEvidenceText(task.description) ||
    normalized === normalizeEvidenceText(task.source_quote)
  );
}

function isRedundantSingleTaskCommitment(
  commitment: CommitmentCandidate,
  task: TaskCandidate
) {
  const sameEvidence =
    normalizeEvidenceText(commitment.source_quote) === normalizeEvidenceText(task.source_quote) &&
    sameIdSet(commitment.source_segment_ids, task.source_segment_ids) &&
    normalizeEvidenceText(commitment.title) === normalizeEvidenceText(task.title) &&
    normalizeEvidenceText(commitment.description) === normalizeEvidenceText(task.description) &&
    (commitment.due_date ?? null) === (task.due_date ?? null) &&
    normalizeEvidenceText(commitment.due_date_text) === normalizeEvidenceText(task.due_date_text);
  // Both signals must agree: identical grounding evidence AND a scope statement that names no
  // outcome beyond the task itself. Either signal alone is not enough to collapse a commitment.
  return sameEvidence && isVacuousScopeStatement(commitment.scope_added_beyond_actions, task);
}

function collapseRedundantSingleTaskCommitments(input: {
  commitments: CommitmentCandidate[];
  tasks: TaskCandidate[];
}) {
  const linkedTasksByCommitment = new Map<string, TaskCandidate[]>();
  for (const task of input.tasks) {
    if (!task.commitment_ref) continue;
    const linked = linkedTasksByCommitment.get(task.commitment_ref) ?? [];
    linked.push(task);
    linkedTasksByCommitment.set(task.commitment_ref, linked);
  }

  const collapsedCommitmentRefs = new Set<string>();
  const collapsedTaskRefs = new Map<string, string>();
  for (const commitment of input.commitments) {
    const linked = linkedTasksByCommitment.get(commitment.client_ref);
    if (!linked || linked.length !== 1) continue;
    const [task] = linked;
    if (!isRedundantSingleTaskCommitment(commitment, task)) continue;
    collapsedCommitmentRefs.add(commitment.client_ref);
    collapsedTaskRefs.set(task.client_ref, commitment.client_ref);
  }

  const commitments = input.commitments.filter(
    (commitment) => !collapsedCommitmentRefs.has(commitment.client_ref)
  );
  const tasks = input.tasks.map((task) =>
    collapsedTaskRefs.has(task.client_ref)
      ? {
          ...task,
          commitment_ref: null,
          relationship_confidence: null,
          relationship_reason:
            "Collapsed: the linked commitment added no evidence, deadline, or scope beyond this task.",
          relationship_evidence: []
        }
      : task
  );
  return { commitments, tasks, collapsedCommitmentRefs, collapsedTaskRefs };
}

function transcriptSegmentIds(transcript: string) {
  return new Set(Array.from(
    transcript.matchAll(/\[([0-9a-f]{8}-[0-9a-f-]{27})\]/gi),
    (match) => match[1]
  ));
}

export function deterministicallyValidateIndependentGraph(input: {
  source: ExecutionSourceContext;
  proposed: ExecutionGraph;
  verified: ExecutionGraph;
}) {
  const validSegments = transcriptSegmentIds(input.source.transcript);
  const proposedCommitments = new Map(
    input.proposed.commitments.map((item) => [item.client_ref, item])
  );
  const proposedTasks = new Map(
    input.proposed.tasks.map((item) => [item.client_ref, item])
  );
  const seenCommitmentRefs = new Set<string>();
  const commitments = input.verified.commitments.flatMap((candidate) => {
    const original = proposedCommitments.get(candidate.client_ref);
    if (!original || seenCommitmentRefs.has(candidate.client_ref)) return [];
    const sourceSegmentIds = candidate.source_segment_ids.filter((id) => validSegments.has(id));
    if (!candidate.source_quote.trim() || sourceSegmentIds.length === 0) return [];
    seenCommitmentRefs.add(candidate.client_ref);
    return [{
      ...original,
      ...candidate,
      client_ref: original.client_ref,
      source_segment_ids: sourceSegmentIds,
      execution_classification: "committed" as const,
      consolidated_from_refs: original.consolidated_from_refs ?? []
    }];
  });
  const commitmentRefs = new Set(commitments.map((item) => item.client_ref));
  const seenTaskRefs = new Set<string>();
  const tasks = input.verified.tasks.flatMap((candidate) => {
    const original = proposedTasks.get(candidate.client_ref);
    const demotedCommitment = proposedCommitments.get(candidate.client_ref);
    if ((!original && !demotedCommitment) || seenTaskRefs.has(candidate.client_ref)) return [];
    const merged = {
      ...(original ?? candidate),
      ...candidate,
      client_ref: candidate.client_ref,
      commitment_ref: original?.commitment_ref ?? null
    };
    if (!isOpenExecutionAction(merged)) return [];
    const sourceSegmentIds = merged.source_segment_ids.filter((id) => validSegments.has(id));
    if (!merged.source_quote.trim() || sourceSegmentIds.length === 0) return [];
    seenTaskRefs.add(candidate.client_ref);
    return [{
      ...merged,
      source_segment_ids: sourceSegmentIds,
      commitment_ref:
        merged.commitment_ref && commitmentRefs.has(merged.commitment_ref)
          ? merged.commitment_ref
          : null,
      execution_classification: "committed" as const,
      consolidated_from_refs: original?.consolidated_from_refs ?? [candidate.client_ref]
    }];
  });
  const collapsed = collapseRedundantSingleTaskCommitments({ commitments, tasks });
  const keptCommitments = new Set(collapsed.commitments.map((item) => item.client_ref));
  const keptTasks = new Map(collapsed.tasks.map((item) => [item.client_ref, item]));
  const decisions: VerificationDecision[] = [
    ...input.proposed.commitments.map((item) => {
      if (keptCommitments.has(item.client_ref)) {
        return {
          item_ref: item.client_ref,
          item_type: "commitment" as const,
          disposition: "kept" as const,
          reason: "Verified as an accepted future outcome; zero child tasks are allowed."
        };
      }
      return {
        item_ref: item.client_ref,
        item_type: "commitment" as const,
        disposition: "excluded" as const,
        reason: collapsed.collapsedCommitmentRefs.has(item.client_ref)
          ? "Collapsed: its single linked task already covers this commitment's evidence, title, and scope."
          : "Verifier or deterministic evidence validation rejected the commitment."
      };
    }),
    ...input.proposed.tasks.map((item) => {
      const kept = keptTasks.get(item.client_ref);
      const collapsedInto = collapsed.collapsedTaskRefs.get(item.client_ref);
      if (!kept) {
        return {
          item_ref: item.client_ref,
          item_type: "task" as const,
          disposition: "excluded" as const,
          reason: `Excluded because ${item.action_classification ?? "the item"} is not verified open execution.`
        };
      }
      if (collapsedInto) {
        return {
          item_ref: item.client_ref,
          item_type: "task" as const,
          disposition: "standalone" as const,
          reason: "Standalone: absorbed its linked commitment, which added no evidence, deadline, or scope beyond this task."
        };
      }
      return {
        item_ref: item.client_ref,
        item_type: "task" as const,
        disposition: kept.commitment_ref
          ? ("child_task" as const)
          : item.commitment_ref
            ? ("unlinked" as const)
            : ("standalone" as const),
        reason: kept.commitment_ref
          ? kept.relationship_reason ?? "Verified as materially advancing the commitment."
          : kept.relationship_reason ?? "Verified open work with no supported commitment relationship."
      };
    })
  ];
  return { graph: { commitments: collapsed.commitments, tasks: collapsed.tasks }, decisions };
}
