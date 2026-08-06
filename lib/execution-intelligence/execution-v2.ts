import type { ConversationEvent } from "./conversation-event-schemas";
import { semanticTokenSimilarity } from "./graph";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";

export const EXECUTION_INTELLIGENCE_VERSION = "responsibility-first-v2" as const;

export type ResponsibilityType =
  | "open_task"
  | "completed_work"
  | "proposal"
  | "decision"
  | "future_idea"
  | "reminder"
  | "scheduling"
  | "blocked_work"
  | "question"
  | "progress_update";

export type ResponsibilityActionState =
  | "open"
  | "completed"
  | "blocked"
  | "future"
  | "cancelled"
  | "accepted"
  | "rejected";

export type ResponsibilityDisposition =
  | "commitment"
  | "child_task"
  | "standalone_task"
  | "decision"
  | "idea"
  | "progress_update"
  | "completed_work"
  | "proposal"
  | "question"
  | "cancelled";

export type ResponsibilityLedgerEntry = {
  responsibility_ref: string;
  title: string;
  responsibility_type: ResponsibilityType;
  action_state: ResponsibilityActionState;
  commitment_signal: "explicit" | "implicit" | "accepted" | "requested" | "proposed";
  owner: string | null;
  conversation_event_ids: string[];
  source_segment_ids: string[];
  source_quote: string;
  disposition: ResponsibilityDisposition | null;
  target_ref: string | null;
  reason: string;
};

export type ExecutionIntelligenceV2Trace = {
  version: typeof EXECUTION_INTELLIGENCE_VERSION;
  responsibilities: ResponsibilityLedgerEntry[];
  proposed_clusters: Array<{
    commitment_ref: string;
    outcome: string;
    responsibility_refs: string[];
  }>;
  judged_commitments: Array<{
    commitment_ref: string;
    outcome: string;
    decision: "kept" | "demoted";
    reason: string;
  }>;
};

const TASK_VERBS = /^(?:send|share|email|contact|follow up|research|evaluate|test|review|meet|hold|schedule|export|configure|confirm|ask|provide|upload)\b/i;
const MILESTONE_LANGUAGE = /\b(?:milestone|release|rollout|launch|first version|mvp|establish|enable|complete|deliver|ready|operational|internally)\b/i;

function eventResponsibilityType(event?: ConversationEvent): ResponsibilityType {
  switch (event?.type) {
    case "completed_work": return "completed_work";
    case "proposal": return "proposal";
    case "decision": return "decision";
    case "future_idea": return "future_idea";
    case "reminder": return "reminder";
    case "scheduling_agreement": return "scheduling";
    case "blocker": return "blocked_work";
    case "question": return "question";
    case "progress_update": return "progress_update";
    default: return "open_task";
  }
}

function actionState(task: TaskCandidate, event?: ConversationEvent): ResponsibilityActionState {
  if (event?.commitment_signal === "accepted") return "accepted";
  if (event?.type === "completed_work" || event?.temporal_state === "past") return "completed";
  if (event?.type === "blocker") return "blocked";
  if ((task.execution_classification ?? "committed") === "future_consideration") return "future";
  return "open";
}

function signal(task: TaskCandidate, event?: ConversationEvent): ResponsibilityLedgerEntry["commitment_signal"] {
  if (event?.commitment_signal === "accepted") return "accepted";
  if (event?.commitment_signal === "requested") return "requested";
  if (event?.commitment_signal === "proposed") return "proposed";
  return task.inferred ? "implicit" : "explicit";
}

function commitmentAsResponsibility(commitment: CommitmentCandidate): TaskCandidate {
  return {
    client_ref: `responsibility_${commitment.client_ref}`,
    commitment_ref: null,
    topic_id: commitment.topic_id,
    title: commitment.title,
    description: commitment.description,
    owner: commitment.owner,
    owners: commitment.owners,
    due_date: commitment.due_date,
    due_date_text: commitment.due_date_text,
    priority: commitment.priority,
    confidence: commitment.confidence,
    source_quote: commitment.source_quote,
    source_segment_ids: commitment.source_segment_ids,
    evidence_source: commitment.evidence_source,
    conversation_event_ids: commitment.conversation_event_ids ?? [],
    inferred: commitment.type === "implicit",
    task_type: commitment.type === "implicit" ? "implicit_commitment" : "commitment",
    workspace_type: "other",
    suggested_steps: [],
    execution_classification: commitment.execution_classification ?? "committed",
    consolidated_from_refs: [
      commitment.client_ref,
      ...(commitment.consolidated_from_refs ?? [])
    ]
  };
}

/** Candidate output is a compatibility graph, but V2 permits no commitments before clustering. */
export function responsibilitiesOnlyGraph(graph: ExecutionGraph): ExecutionGraph {
  return {
    commitments: [],
    tasks: [
      ...graph.tasks.map((task) => ({ ...task, commitment_ref: null })),
      ...graph.commitments.map(commitmentAsResponsibility)
    ]
  };
}

export function buildResponsibilityLedger(input: {
  graph: ExecutionGraph;
  events: ConversationEvent[];
}): ResponsibilityLedgerEntry[] {
  const events = new Map(input.events.map((event) => [event.client_ref, event]));
  return input.graph.tasks.map((task) => {
    const event = (task.conversation_event_ids ?? []).map((id) => events.get(id)).find(Boolean);
    const type = eventResponsibilityType(event);
    return {
      responsibility_ref: task.client_ref,
      title: task.title,
      responsibility_type: type,
      action_state: actionState(task, event),
      commitment_signal: signal(task, event),
      owner: task.owner,
      conversation_event_ids: task.conversation_event_ids ?? [],
      source_segment_ids: task.source_segment_ids,
      source_quote: task.source_quote,
      disposition: null,
      target_ref: null,
      reason: `Preserved as a ${type.replaceAll("_", " ")} responsibility before hierarchy construction.`
    };
  });
}

function demoteCommitment(commitment: CommitmentCandidate): TaskCandidate {
  return {
    ...commitmentAsResponsibility(commitment),
    client_ref: `demoted_${commitment.client_ref}`,
    consolidated_from_refs: [commitment.client_ref, ...(commitment.consolidated_from_refs ?? [])]
  };
}

/** Enforces the non-negotiable promotion rules after the model judge. */
export function applyCommitmentPromotionGuard(graph: ExecutionGraph): {
  graph: ExecutionGraph;
  judgments: ExecutionIntelligenceV2Trace["judged_commitments"];
} {
  const kept: CommitmentCandidate[] = [];
  const demoted: TaskCandidate[] = [];
  const tasks = graph.tasks.map((task) => ({ ...task }));
  const judgments: ExecutionIntelligenceV2Trace["judged_commitments"] = [];

  for (const commitment of graph.commitments) {
    const children = tasks.filter((task) => task.commitment_ref === commitment.client_ref);
    const committed = (commitment.execution_classification ?? "committed") === "committed";
    const acceptedOwnership = committed && Boolean(commitment.owner || commitment.owners.length || children.some((task) => task.owner || task.owners.length));
    const multipleResponsibilities = children.length >= 2;
    const explicitMilestone = MILESTONE_LANGUAGE.test(commitment.title);
    const actionLevel = TASK_VERBS.test(commitment.title.trim());
    const promote = acceptedOwnership && (multipleResponsibilities || explicitMilestone) && !actionLevel;

    if (promote) {
      kept.push(commitment);
      judgments.push({
        commitment_ref: commitment.client_ref,
        outcome: commitment.title,
        decision: "kept",
        reason: multipleResponsibilities
          ? `Outcome has accepted ownership and groups ${children.length} distinct responsibilities.`
          : "Outcome has accepted ownership and explicit milestone language."
      });
      continue;
    }

    demoted.push(demoteCommitment(commitment));
    for (const child of children) child.commitment_ref = null;
    const reason = !acceptedOwnership
      ? "No accepted owner was grounded for the proposed outcome."
      : actionLevel
        ? "The title is a straightforward action and failed the verb demotion guard."
        : "The item has neither multiple supporting responsibilities nor explicit milestone language.";
    judgments.push({
      commitment_ref: commitment.client_ref,
      outcome: commitment.title,
      decision: "demoted",
      reason
    });
  }

  return { graph: { commitments: kept, tasks: [...tasks, ...demoted] }, judgments };
}

function relatedTask(entry: ResponsibilityLedgerEntry, task: TaskCandidate) {
  if (entry.responsibility_ref === task.client_ref) return true;
  if ((task.consolidated_from_refs ?? []).includes(entry.responsibility_ref)) return true;
  if (entry.conversation_event_ids.some((id) => (task.conversation_event_ids ?? []).includes(id))) return true;
  if (entry.source_segment_ids.some((id) => task.source_segment_ids.includes(id))) return true;
  return semanticTokenSimilarity(entry.title, task.title) >= 0.72;
}

export function finalizeResponsibilityTrace(input: {
  ledger: ResponsibilityLedgerEntry[];
  graph: ExecutionGraph;
  judgments: ExecutionIntelligenceV2Trace["judged_commitments"];
}): ExecutionIntelligenceV2Trace {
  const responsibilities = input.ledger.map((entry) => {
    const task = input.graph.tasks.find((candidate) => relatedTask(entry, candidate));
    if (task) {
      const disposition = task.commitment_ref ? "child_task" : "standalone_task";
      return {
        ...entry,
        disposition,
        target_ref: task.client_ref,
        reason: task.commitment_ref
          ? `Linked as a child task because it contributes to promoted outcome ${task.commitment_ref}.`
          : "Kept standalone because no promoted broader outcome naturally requires it."
      } satisfies ResponsibilityLedgerEntry;
    }
    const passive: Partial<Record<ResponsibilityType, ResponsibilityDisposition>> = {
      decision: "decision",
      future_idea: "idea",
      progress_update: "progress_update",
      completed_work: "completed_work",
      proposal: "proposal",
      question: "question"
    };
    const disposition = passive[entry.responsibility_type] ?? (entry.action_state === "cancelled" ? "cancelled" : "standalone_task");
    return {
      ...entry,
      disposition,
      target_ref: null,
      reason: `Excluded from the open execution queue because it is classified as ${entry.responsibility_type.replaceAll("_", " ")}.`
    } satisfies ResponsibilityLedgerEntry;
  });
  return {
    version: EXECUTION_INTELLIGENCE_VERSION,
    responsibilities,
    proposed_clusters: input.graph.commitments.map((commitment) => ({
      commitment_ref: commitment.client_ref,
      outcome: commitment.title,
      responsibility_refs: input.graph.tasks
        .filter((task) => task.commitment_ref === commitment.client_ref)
        .map((task) => task.client_ref)
    })),
    judged_commitments: input.judgments
  };
}
