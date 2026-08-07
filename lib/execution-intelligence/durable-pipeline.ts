import {
  createExecutionMetrics,
  logExecutionStage,
  logExecutionSummary,
  type ExecutionMetrics
} from "./observability";
import { persistExecutionGraph } from "./persistence";
import { persistConversationEvents } from "./persistence";
import { extractAndLinkConversationEvents } from "./conversation-events";
import {
  deterministicallyValidateIndependentGraph,
  mergeTopicActions,
  reconcileRelationshipEvaluation,
  type IndependentExecutionTrace,
  type RelationshipDecision,
  type VerificationDecision
} from "./independent-execution";
import { transcriptSourceSegmentIds } from "./conversation-event-identity";
import type { CommitmentCandidate, ExecutionGraph, TaskCandidate } from "./schemas";
import {
  evaluateTaskCommitmentRelationships,
  extractIndependentCommitments,
  extractTopicActions,
  verifyIndependentExecutionGraph,
  type TopicActionExtraction,
  type ExecutionSourceContext
} from "./stages";

export type DurableExecutionState = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  metrics: ExecutionMetrics;
  graph: ExecutionGraph;
  topicActions: TopicActionExtraction[];
  mergedActions: TaskCandidate[];
  extractedCommitments: CommitmentCandidate[];
  relationshipDecisions: RelationshipDecision[];
  verificationDecisions: VerificationDecision[];
  debugTrace?: IndependentExecutionTrace;
};

function stageFailure(stage: string, error: string, details?: string): never {
  throw new Error(`${stage}: ${details ? `${error}: ${details}` : error}`);
}

export async function runActionExtraction(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
}): Promise<DurableExecutionState> {
  const metrics = createExecutionMetrics(input.source.meetingId, input.fallbackUsed);
  const extracted = await extractTopicActions(input.source);
  metrics.openAiLatencyMs.topicActions = extracted.latencyMs;
  if (!extracted.ok) {
    metrics.validationFailures += Number(extracted.validationFailure);
    stageFailure("topic_action_extraction", extracted.error, extracted.details);
  }
  const merged = mergeTopicActions(extracted.topics);
  const graph: ExecutionGraph = { commitments: [], tasks: merged.actions };
  metrics.deduplicatedTasks += merged.deduplicated;
  metrics.candidateCommitments = 0;
  metrics.candidateTasks = graph.tasks.length;
  logExecutionStage(metrics, "topic_actions_merged", {
    topics: extracted.topics.length,
    actions: graph.tasks.length,
    deduplicated_actions: merged.deduplicated
  });
  return {
    ...input,
    metrics,
    graph,
    topicActions: extracted.topics,
    mergedActions: merged.actions,
    extractedCommitments: [],
    relationshipDecisions: [],
    verificationDecisions: []
  };
}

export async function runConversationEventExtraction(
  source: ExecutionSourceContext,
  generation: number
): Promise<ExecutionSourceContext> {
  const result = await extractAndLinkConversationEvents(source, { generation });
  if (!result.ok) {
    console.warn("[execution-intelligence] Optional Conversation Event extraction failed", {
      meeting_id: source.meetingId,
      error: result.error,
      details: result.details
    });
    return { ...source, conversationEvents: [] };
  }
  logExecutionStage(createExecutionMetrics(source.meetingId, false), "conversation_events_extracted", {
    events: result.events.length,
    linked_events: result.events.filter((event) => event.linked_event_refs.length > 0).length,
    latency_ms: result.latencyMs
  });
  return { ...source, conversationEvents: result.events };
}

export async function runCommitmentExtraction(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const extracted = await extractIndependentCommitments({
    source: state.source,
    actions: state.mergedActions
  });
  state.metrics.openAiLatencyMs.commitments = extracted.latencyMs;
  if (!extracted.ok) {
    state.metrics.validationFailures += Number(extracted.validationFailure);
    stageFailure("commitment_extraction", extracted.error, extracted.details);
  }
  state.metrics.salvagedItems += extracted.salvagedItems ?? 0;
  const extractedCommitments = extracted.graph.commitments;
  const graph = {
    commitments: extractedCommitments,
    tasks: state.mergedActions
  };
  logExecutionStage(state.metrics, "commitments_extracted_independently", {
    commitments: extractedCommitments.length,
    zero_task_commitments_allowed: true
  });
  return { ...state, graph, extractedCommitments };
}

export async function runRelationshipEvaluation(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const evaluated = await evaluateTaskCommitmentRelationships({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.relationships = evaluated.latencyMs;
  if (!evaluated.ok) {
    state.metrics.validationFailures += Number(evaluated.validationFailure);
    stageFailure("relationship_evaluation", evaluated.error, evaluated.details);
  }
  state.metrics.salvagedItems += evaluated.salvagedItems ?? 0;
  const reconciled = reconcileRelationshipEvaluation({
    proposed: state.graph,
    evaluated: evaluated.graph
  });
  logExecutionStage(state.metrics, "task_commitment_relationships_evaluated", {
    linked: reconciled.graph.tasks.filter((task) => task.commitment_ref).length,
    standalone: reconciled.graph.tasks.filter((task) => !task.commitment_ref).length
  });
  return {
    ...state,
    graph: reconciled.graph,
    relationshipDecisions: reconciled.decisions
  };
}

export async function runEvidenceVerification(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const verified = await verifyIndependentExecutionGraph({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.finalVerification = verified.latencyMs;
  if (!verified.ok) {
    state.metrics.validationFailures += Number(verified.validationFailure);
    stageFailure("evidence_verification", verified.error, verified.details);
  }
  state.metrics.salvagedItems += verified.salvagedItems ?? 0;
  const validated = deterministicallyValidateIndependentGraph({
    source: state.source,
    proposed: state.graph,
    verified: verified.graph
  });
  state.metrics.verifiedCommitments = validated.graph.commitments.length;
  state.metrics.verifiedTasks = validated.graph.tasks.length;
  return {
    ...state,
    graph: validated.graph,
    verificationDecisions: validated.decisions
  };
}

export async function finalizeIndependentExecution(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  state.metrics.linkedTasks = state.graph.tasks.filter(
    (task) => task.commitment_ref
  ).length;
  state.metrics.unlinkedTasks =
    state.graph.tasks.length - state.metrics.linkedTasks;
  const verificationByRef = new Map(
    state.verificationDecisions.map((decision) => [
      `${decision.item_type}:${decision.item_ref}`,
      decision
    ])
  );
  const relationshipByRef = new Map(
    state.relationshipDecisions.map((decision) => [decision.action_ref, decision])
  );
  const debugTrace: IndependentExecutionTrace = {
    version: "independent-commitments-tasks-v1",
    topics: state.topicActions.map((topic) => ({
      topic_id: topic.topicId,
      title: topic.topicTitle,
      transcript: topic.transcript
    })),
    topic_actions: state.topicActions,
    merged_actions: state.mergedActions,
    extracted_commitments: state.extractedCommitments,
    relationship_decisions: state.relationshipDecisions,
    verification_decisions: state.verificationDecisions,
    commitments_debug: state.extractedCommitments.map((commitment) => ({
      ...commitment,
      verification: verificationByRef.get(`commitment:${commitment.client_ref}`) ?? null
    })),
    tasks_debug: state.mergedActions.map((task) => ({
      ...task,
      relationship: relationshipByRef.get(task.client_ref) ?? null,
      verification: verificationByRef.get(`task:${task.client_ref}`) ?? null
    })),
    final_graph: state.graph
  };
  logExecutionStage(state.metrics, "independent_graph_finalized", {
    commitments: state.graph.commitments.length,
    linked_tasks: state.metrics.linkedTasks,
    standalone_tasks: state.metrics.unlinkedTasks
  });
  return {
    ...state,
    debugTrace
  };
}

export async function persistDurableExecutionGraph(input: {
  state: DurableExecutionState;
  generation: number;
}) {
  const persisted = await persistExecutionGraph({
    meetingId: input.state.source.meetingId,
    generation: input.generation,
    graph: input.state.graph
  });
  if (!persisted.ok) {
    const error = new Error(persisted.error);
    if (persisted.stale) error.name = "StaleAnalysisError";
    throw error;
  }
  const persistedEvents = await persistConversationEvents({
    meetingId: input.state.source.meetingId,
    generation: input.generation,
    events: input.state.source.conversationEvents ?? [],
    validSourceSegmentIds: transcriptSourceSegmentIds(
      input.state.source.transcript
    )
  });
  if (!persistedEvents.ok) {
    console.warn("[execution-intelligence] Optional Conversation Event persistence failed", {
      meeting_id: input.state.source.meetingId,
      error: persistedEvents.error,
      details: persistedEvents.details
    });
  }
  logExecutionSummary(input.state.metrics);
  return {
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    metrics: input.state.metrics
  };
}
