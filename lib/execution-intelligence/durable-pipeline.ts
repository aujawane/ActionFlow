import {
  enforceExecutionGraphGrounding,
  mergeAndDeduplicateGraphs
} from "./graph";
import { consolidateExecutionGraph } from "./consolidation";
import { linkTasksToCommitments } from "./linking";
import { normalizeExecutionGraphQuality } from "./normalization";
import {
  createExecutionMetrics,
  logExecutionStage,
  logExecutionSummary,
  type ExecutionMetrics
} from "./observability";
import { persistExecutionGraph } from "./persistence";
import { persistConversationEvents } from "./persistence";
import { extractAndLinkConversationEvents } from "./conversation-events";
import { ensureAcceptedWorkTasks } from "./standalone-events";
import {
  applyCommitmentPromotionGuard,
  buildResponsibilityLedger,
  finalizeResponsibilityTrace,
  responsibilitiesOnlyGraph,
  type ExecutionIntelligenceV2Trace,
  type ResponsibilityLedgerEntry
} from "./execution-v2";
import { resolveAssigneesAndDueDates } from "./resolution";
import type { ExecutionGraph } from "./schemas";
import {
  findMissingExecutionWorkInBatches,
  generateChunkedExecutionCandidates,
  judgeExecutionGraph,
  synthesizeExecutionGraph,
  verifyExecutionGraphInBatches,
  type ExecutionSourceContext
} from "./stages";

export type DurableExecutionState = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  metrics: ExecutionMetrics;
  graph: ExecutionGraph;
  responsibilityLedger: ResponsibilityLedgerEntry[];
  reasoningTrace?: ExecutionIntelligenceV2Trace;
};

function stageFailure(stage: string, error: string, details?: string): never {
  throw new Error(`${stage}: ${details ? `${error}: ${details}` : error}`);
}

function countCommittedWork(graph: ExecutionGraph) {
  const commitments = graph.commitments.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  const tasks = graph.tasks.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  return { commitments, tasks };
}

export async function runCandidateExtraction(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
}): Promise<DurableExecutionState> {
  const metrics = createExecutionMetrics(input.source.meetingId, input.fallbackUsed);
  const candidates = await generateChunkedExecutionCandidates(input.source);
  metrics.openAiLatencyMs.candidates = candidates.latencyMs;
  if (!candidates.ok) {
    metrics.validationFailures += Number(candidates.validationFailure);
    stageFailure("candidate_generation", candidates.error, candidates.details);
  }

  metrics.salvagedItems += candidates.salvagedItems ?? 0;
  const graph = responsibilitiesOnlyGraph(candidates.graph);
  const responsibilityLedger = buildResponsibilityLedger({
    graph,
    events: input.source.conversationEvents ?? []
  });
  metrics.candidateCommitments = 0;
  metrics.candidateTasks = graph.tasks.length;
  logExecutionStage(metrics, "candidates_generated", {
    commitments: metrics.candidateCommitments,
    tasks: metrics.candidateTasks
  });
  return { ...input, metrics, graph, responsibilityLedger };
}

export async function runConversationEventExtraction(
  source: ExecutionSourceContext
): Promise<ExecutionSourceContext> {
  const result = await extractAndLinkConversationEvents(source);
  if (!result.ok) stageFailure("conversation_event_extraction", result.error, result.details);
  logExecutionStage(createExecutionMetrics(source.meetingId, false), "conversation_events_extracted", {
    events: result.events.length,
    linked_events: result.events.filter((event) => event.linked_event_refs.length > 0).length,
    latency_ms: result.latencyMs
  });
  return { ...source, conversationEvents: result.events };
}

export async function runInitialVerification(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const verified = await verifyExecutionGraphInBatches({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.initialVerification = verified.latencyMs;
  if (!verified.ok) {
    state.metrics.validationFailures += Number(verified.validationFailure);
    stageFailure("initial_verification", verified.error, verified.details);
  }

  state.metrics.salvagedItems += verified.salvagedItems ?? 0;
  const resolved = resolveAssigneesAndDueDates(
    responsibilitiesOnlyGraph(verified.graph)
  );
  const grounded = enforceExecutionGraphGrounding({
    source: state.source,
    graph: resolved
  });
  state.metrics.groundingRejectedCommitments += grounded.rejectedCommitments;
  state.metrics.groundingRejectedTasks += grounded.rejectedTasks;
  state.metrics.verifiedCommitments = grounded.graph.commitments.length;
  state.metrics.verifiedTasks = grounded.graph.tasks.length;
  return { ...state, graph: grounded.graph };
}

export async function runCompleteness(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const missing = await findMissingExecutionWorkInBatches({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.completeness = missing.latencyMs;
  if (!missing.ok) {
    state.metrics.validationFailures += Number(missing.validationFailure);
    stageFailure("completeness", missing.error, missing.details);
  }

  state.metrics.salvagedItems += missing.salvagedItems ?? 0;
  state.metrics.missingCommitments = missing.graph.commitments.length;
  state.metrics.missingTasks = missing.graph.tasks.length;
  const merged = mergeAndDeduplicateGraphs(
    state.graph,
    responsibilitiesOnlyGraph(missing.graph)
  );
  state.metrics.deduplicatedCommitments += merged.deduplicatedCommitments;
  state.metrics.deduplicatedTasks += merged.deduplicatedTasks;
  const normalized = normalizeExecutionGraphQuality(merged.graph);
  logExecutionStage(state.metrics, "graph_quality_normalized", {
    phase: "before_final_verification",
    removed_ownership_commitments: normalized.removedOwnershipCommitments,
    removed_ownership_tasks: normalized.removedOwnershipTasks,
    merged_group_tasks: normalized.mergedGroupTasks,
    blocker_tasks_added: normalized.blockerTasksAdded
  });
  return { ...state, graph: normalized.graph };
}

export async function runFinalVerification(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const verified = await verifyExecutionGraphInBatches({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.finalVerification = verified.latencyMs;
  if (!verified.ok) {
    state.metrics.validationFailures += Number(verified.validationFailure);
    stageFailure("final_verification", verified.error, verified.details);
  }

  state.metrics.salvagedItems += verified.salvagedItems ?? 0;
  const resolved = resolveAssigneesAndDueDates(
    responsibilitiesOnlyGraph(verified.graph)
  );
  const normalized = normalizeExecutionGraphQuality(resolved);
  const grounded = enforceExecutionGraphGrounding({
    source: state.source,
    graph: normalized.graph
  });
  state.metrics.groundingRejectedCommitments += grounded.rejectedCommitments;
  state.metrics.groundingRejectedTasks += grounded.rejectedTasks;
  const deduped = mergeAndDeduplicateGraphs(grounded.graph);
  state.metrics.deduplicatedCommitments += deduped.deduplicatedCommitments;
  state.metrics.deduplicatedTasks += deduped.deduplicatedTasks;
  return { ...state, graph: deduped.graph };
}

export async function runGlobalSynthesis(
  state: DurableExecutionState
): Promise<DurableExecutionState> {
  const responsibilityLedger = buildResponsibilityLedger({
    graph: state.graph,
    events: state.source.conversationEvents ?? []
  });
  const synthesis = await synthesizeExecutionGraph({
    source: state.source,
    graph: state.graph
  });
  state.metrics.openAiLatencyMs.synthesis = synthesis.latencyMs;
  if (!synthesis.ok) {
    state.metrics.validationFailures += Number(synthesis.validationFailure);
    stageFailure("synthesis", synthesis.error, synthesis.details);
  }
  state.metrics.salvagedItems += synthesis.salvagedItems ?? 0;
  const judged = await judgeExecutionGraph({
    source: state.source,
    graph: synthesis.graph
  });
  if (!judged.ok) {
    state.metrics.validationFailures += Number(judged.validationFailure);
    stageFailure("execution_judge", judged.error, judged.details);
  }
  state.metrics.openAiLatencyMs.judge = judged.latencyMs;
  state.metrics.salvagedItems += judged.salvagedItems ?? 0;
  const promotionGuard = applyCommitmentPromotionGuard(judged.graph);
  const synthesizedCommittedOutcomes = promotionGuard.graph.commitments.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  if (synthesizedCommittedOutcomes > 7) {
    logExecutionStage(state.metrics, "synthesis_fragmentation_warning", {
      committed_outcomes: synthesizedCommittedOutcomes,
      quality_signal: "more_than_seven_commitments"
    });
  }

  const resolved = resolveAssigneesAndDueDates(
    linkTasksToCommitments(promotionGuard.graph)
  );
  const normalized = normalizeExecutionGraphQuality(resolved);
  const grounded = enforceExecutionGraphGrounding({
    source: state.source,
    graph: normalized.graph
  });
  state.metrics.groundingRejectedCommitments += grounded.rejectedCommitments;
  state.metrics.groundingRejectedTasks += grounded.rejectedTasks;
  const deduped = mergeAndDeduplicateGraphs(grounded.graph);
  state.metrics.deduplicatedCommitments += deduped.deduplicatedCommitments;
  state.metrics.deduplicatedTasks += deduped.deduplicatedTasks;

  const acceptedWork = ensureAcceptedWorkTasks({
    graph: deduped.graph,
    events: state.source.conversationEvents ?? []
  });
  logExecutionStage(state.metrics, "accepted_work_audited", {
    standalone_tasks_added: acceptedWork.added
  });
  const consolidated = consolidateExecutionGraph(acceptedWork.graph, {
    projectName: state.source.project?.name,
    projectGoal: state.source.project?.goal
  });
  logExecutionStage(state.metrics, "graph_consolidated", {
    merged_commitments: consolidated.mergedCommitments,
    converted_commitments: consolidated.convertedCommitments,
    merged_tasks: consolidated.mergedTasks,
    rejected_restatements: consolidated.rejectedRestatements,
    removed_generic_inferred: consolidated.removedGenericInferred
  });

  state.metrics.verifiedCommitments = consolidated.graph.commitments.length;
  state.metrics.verifiedTasks = consolidated.graph.tasks.length;
  state.metrics.linkedTasks = consolidated.graph.tasks.filter(
    (task) => task.commitment_ref
  ).length;
  state.metrics.unlinkedTasks =
    consolidated.graph.tasks.length - state.metrics.linkedTasks;

  const committed = countCommittedWork(consolidated.graph);
  const groundedExecutionSignals = (state.source.conversationEvents ?? []).filter(
    (event) => ["accepted", "explicit"].includes(event.commitment_signal)
  ).length;
  if (groundedExecutionSignals > 0 && committed.commitments === 0 && committed.tasks === 0) {
    stageFailure(
      "synthesis",
      "Completeness verification found no executable work despite accepted conversation events."
    );
  }
  const reasoningTrace = finalizeResponsibilityTrace({
    ledger: responsibilityLedger,
    graph: consolidated.graph,
    judgments: promotionGuard.judgments
  });
  return {
    ...state,
    graph: consolidated.graph,
    responsibilityLedger,
    reasoningTrace
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
    events: input.state.source.conversationEvents ?? []
  });
  if (!persistedEvents.ok) throw new Error(persistedEvents.error);
  logExecutionSummary(input.state.metrics);
  return {
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    metrics: input.state.metrics
  };
}
