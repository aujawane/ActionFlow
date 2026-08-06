import type { ConversationEvent } from "./conversation-event-schemas";

/** @deprecated Not used by the active independent commitments/tasks runtime. */
import { semanticTokenSimilarity } from "./graph";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";

export const EXECUTION_INTELLIGENCE_VERSION = "responsibility-first-v2" as const;

export type ResponsibilityType =
  | "completed"
  | "in_progress"
  | "future_accepted"
  | "future_proposal"
  | "decision"
  | "future_idea"
  | "reminder"
  | "scheduling"
  | "blocked_work"
  | "question";

export type ExecutionIntent = ResponsibilityType;

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
  execution_intent: ExecutionIntent;
  execution_intent_reason: string;
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

const COMPLETED_LANGUAGE = /\b(?:i|we)(?:'ve| have)?\s+(?:already\s+)?(?:fixed|finished|completed|sent|shipped|deployed|implemented|resolved|closed|stopped|set up|configured)\b/i;
const IN_PROGRESS_LANGUAGE = /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:currently\s+)?(?:working|implementing|testing|building|fixing|deploying|setting up)\b|\b(?:i|we)(?:'ve| have)\s+been\s+\w+ing\b|\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:halfway|partway)\b/i;
const FIRST_PERSON_FUTURE = /\b(?:i(?:'ll| will|'m going to| am going to|'m gonna| am gonna)|we(?:'ll| will|'re going to| are going to|'re gonna| are gonna)|let['’]?s)\b/i;
const PROPOSAL_LANGUAGE = /\b(?:maybe|perhaps|might|could|should)\b/i;

export type ExecutionIntentClassification = {
  intent: ExecutionIntent;
  reason: string;
};

function linkedEventsFor(
  event: ConversationEvent | undefined,
  events: Map<string, ConversationEvent>
) {
  if (!event) return [];
  const directlyLinked = event.linked_event_refs
    .map((ref) => events.get(ref))
    .filter((candidate): candidate is ConversationEvent => Boolean(candidate));
  const reverseLinked = Array.from(events.values()).filter((candidate) =>
    candidate.linked_event_refs.includes(event.client_ref)
  );
  return Array.from(new Map(
    [...directlyLinked, ...reverseLinked].map((candidate) => [candidate.client_ref, candidate])
  ).values());
}

/** Classifies what happened to accountability, independent of the event's sentence label. */
export function classifyExecutionIntent(input: {
  task: TaskCandidate;
  event?: ConversationEvent;
  events?: ConversationEvent[];
}): ExecutionIntentClassification {
  const events = new Map((input.events ?? []).map((event) => [event.client_ref, event]));
  if (input.event) events.set(input.event.client_ref, input.event);
  const taskEvents = (input.task.conversation_event_ids ?? [])
    .map((ref) => events.get(ref))
    .filter((event): event is ConversationEvent => Boolean(event));
  const seedEvents = Array.from(new Map(
    [input.event, ...taskEvents]
      .filter((event): event is ConversationEvent => Boolean(event))
      .map((event) => [event.client_ref, event])
  ).values());
  const linked = Array.from(new Map(
    seedEvents.flatMap((event) => linkedEventsFor(event, events))
      .map((event) => [event.client_ref, event])
  ).values());
  const evidence = [
    ...seedEvents.map((event) => event.source_quote),
    ...linked.map((event) => event.source_quote),
    input.task.source_quote,
    input.task.title
  ].filter(Boolean).join(" ").replaceAll("’", "'");
  const allEvents = Array.from(new Map(
    [...seedEvents, ...linked].map((event) => [event.client_ref, event])
  ).values());
  const acceptedTurn = allEvents.some((event) =>
    event.type === "acceptance" || event.commitment_signal === "accepted"
  );
  const acceptedFutureEvent = allEvents.some((event) =>
    event.temporal_state === "future" &&
    (event.type === "promise" || ["accepted", "explicit"].includes(event.commitment_signal))
  );

  if (COMPLETED_LANGUAGE.test(evidence) || allEvents.some((event) =>
    event.type === "completed_work" || event.temporal_state === "past"
  )) {
    return { intent: "completed", reason: "Completed work; no future accountability was created." };
  }
  if (PROPOSAL_LANGUAGE.test(evidence) && !acceptedTurn && !acceptedFutureEvent) {
    return { intent: "future_proposal", reason: "Proposal without acceptance." };
  }
  if (FIRST_PERSON_FUTURE.test(evidence) || acceptedTurn || acceptedFutureEvent) {
    return {
      intent: "future_accepted",
      reason: acceptedTurn
        ? "A linked acceptance created future accountability."
        : "Accepted first-person future commitment."
    };
  }
  if (IN_PROGRESS_LANGUAGE.test(evidence) || allEvents.some((event) =>
    event.type === "progress_update" && event.temporal_state !== "future"
  )) {
    return { intent: "in_progress", reason: "Current progress report; no new future accountability was created." };
  }
  if (input.event?.type === "blocker") {
    return { intent: "blocked_work", reason: "Existing work is blocked." };
  }
  if (input.event?.type === "scheduling_agreement") {
    return { intent: "scheduling", reason: "The statement establishes scheduling intent." };
  }
  if (input.event?.type === "reminder") {
    return { intent: "reminder", reason: "The statement records a reminder." };
  }
  if (input.event?.type === "decision") {
    return { intent: "decision", reason: "A decision was recorded without separate accepted future work." };
  }
  if (input.event?.type === "future_idea") {
    return { intent: "future_idea", reason: "Optional future idea without accepted accountability." };
  }
  if (
    input.event?.type === "proposal" ||
    input.event?.commitment_signal === "proposed" ||
    PROPOSAL_LANGUAGE.test(evidence)
  ) {
    return { intent: "future_proposal", reason: "Proposal without acceptance." };
  }
  if (
    input.event?.type === "question" ||
    input.event?.type === "request" ||
    input.event?.commitment_signal === "requested"
  ) {
    return { intent: "question", reason: "Request or question without acceptance; no accountable owner yet." };
  }
  if ((input.task.execution_classification ?? "committed") === "future_consideration") {
    return { intent: "future_idea", reason: "Optional future work without accepted accountability." };
  }
  if ((input.task.execution_classification ?? "committed") === "proposed") {
    return { intent: "future_proposal", reason: "Proposal without acceptance." };
  }
  if (
    (input.task.owner || input.task.owners.length > 0) &&
    (input.task.execution_classification ?? "committed") === "committed"
  ) {
    return {
      intent: "future_accepted",
      reason: "The extracted responsibility has an accountable owner and no passive execution signal."
    };
  }
  return {
    intent: "question",
    reason: "No accepted accountability could be established from the available evidence."
  };
}

function compatibilityClassification(
  intent: ExecutionIntent,
  task: TaskCandidate,
  event?: ConversationEvent
): TaskCandidate["execution_classification"] {
  switch (intent) {
    case "future_accepted": return "committed";
    case "blocked_work":
    case "scheduling":
    case "reminder": {
      const accepted = event && ["accepted", "explicit"].includes(event.commitment_signal);
      return accepted && Boolean(task.owner || task.owners.length) ? "committed" : "requirement";
    }
    case "future_proposal": return "proposed";
    case "future_idea": return "future_consideration";
    default: return "requirement";
  }
}

function actionState(intent: ExecutionIntent): ResponsibilityActionState {
  if (intent === "future_accepted") return "accepted";
  if (intent === "completed") return "completed";
  if (intent === "blocked_work") return "blocked";
  if (["future_proposal", "future_idea"].includes(intent)) return "future";
  return "open";
}

function signal(
  task: TaskCandidate,
  event: ConversationEvent | undefined,
  events: Map<string, ConversationEvent>
): ResponsibilityLedgerEntry["commitment_signal"] {
  const taskEvents = (task.conversation_event_ids ?? [])
    .map((ref) => events.get(ref))
    .filter((candidate): candidate is ConversationEvent => Boolean(candidate));
  const related = Array.from(new Map(
    [event, ...taskEvents, ...taskEvents.flatMap((candidate) => linkedEventsFor(candidate, events))]
      .filter((candidate): candidate is ConversationEvent => Boolean(candidate))
      .map((candidate) => [candidate.client_ref, candidate])
  ).values());
  if (related.some((candidate) => candidate.commitment_signal === "accepted")) return "accepted";
  if (related.some((candidate) => candidate.commitment_signal === "requested")) return "requested";
  if (related.some((candidate) => candidate.commitment_signal === "proposed")) return "proposed";
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
export function responsibilitiesOnlyGraph(
  graph: ExecutionGraph,
  events: ConversationEvent[] = []
): ExecutionGraph {
  const eventsByRef = new Map(events.map((event) => [event.client_ref, event]));
  const tasks = [
    ...graph.tasks.map((task) => ({ ...task, commitment_ref: null })),
    ...graph.commitments.map(commitmentAsResponsibility)
  ].map((task) => {
    const event = (task.conversation_event_ids ?? []).map((id) => eventsByRef.get(id)).find(Boolean);
    const classification = classifyExecutionIntent({ task, event, events });
    return {
      ...task,
      execution_classification: compatibilityClassification(
        classification.intent,
        task,
        event
      )
    };
  });
  return {
    commitments: [],
    tasks
  };
}

export function buildResponsibilityLedger(input: {
  graph: ExecutionGraph;
  events: ConversationEvent[];
}): ResponsibilityLedgerEntry[] {
  const events = new Map(input.events.map((event) => [event.client_ref, event]));
  return input.graph.tasks.map((task) => {
    const event = (task.conversation_event_ids ?? []).map((id) => events.get(id)).find(Boolean);
    const classification = classifyExecutionIntent({
      task,
      event,
      events: input.events
    });
    return {
      responsibility_ref: task.client_ref,
      title: task.title,
      responsibility_type: classification.intent,
      execution_intent: classification.intent,
      execution_intent_reason: classification.reason,
      action_state: actionState(classification.intent),
      commitment_signal: signal(task, event, events),
      owner: task.owner,
      conversation_event_ids: task.conversation_event_ids ?? [],
      source_segment_ids: task.source_segment_ids,
      source_quote: task.source_quote,
      disposition: null,
      target_ref: null,
      reason: classification.reason
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
      in_progress: "progress_update",
      completed: "completed_work",
      future_proposal: "proposal",
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
