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
  logExecutionSummary
} from "./observability";
import { persistConversationEvents, persistExecutionGraph } from "./persistence";
import { extractAndLinkConversationEvents } from "./conversation-events";
import { ensureAcceptedWorkTasks } from "./standalone-events";
import {
  applyCommitmentPromotionGuard,
  buildResponsibilityLedger,
  finalizeResponsibilityTrace,
  responsibilitiesOnlyGraph
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

type ExecutionPipelineDependencies = {
  generateCandidates: typeof generateChunkedExecutionCandidates;
  verifyGraph: typeof verifyExecutionGraphInBatches;
  findMissing: typeof findMissingExecutionWorkInBatches;
  synthesizeGraph: typeof synthesizeExecutionGraph;
  judgeGraph: typeof judgeExecutionGraph;
  persistGraph: typeof persistExecutionGraph;
  extractEvents: typeof extractAndLinkConversationEvents;
  persistEvents: typeof persistConversationEvents;
};

export async function runExecutionIntelligence(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  generation: number;
  dependencies?: Partial<ExecutionPipelineDependencies>;
}) {
  const dependencies: ExecutionPipelineDependencies = {
    generateCandidates: generateChunkedExecutionCandidates,
    verifyGraph: verifyExecutionGraphInBatches,
    findMissing: findMissingExecutionWorkInBatches,
    synthesizeGraph: synthesizeExecutionGraph,
    judgeGraph: judgeExecutionGraph,
    persistGraph: persistExecutionGraph,
    extractEvents: extractAndLinkConversationEvents,
    persistEvents: persistConversationEvents,
    ...input.dependencies
  };
  // Preserve the existing dependency-injection contract for callers that mock synthesis.
  // Production always uses the independent V2 judge.
  if (input.dependencies?.synthesizeGraph && !input.dependencies.judgeGraph) {
    dependencies.judgeGraph = async ({ graph }) => ({
      ok: true,
      graph,
      latencyMs: 0
    });
  }
  const metrics = createExecutionMetrics(
    input.source.meetingId,
    input.fallbackUsed
  );

  let source = input.source;
  if (!source.conversationEvents) {
    const events = await dependencies.extractEvents(source);
    if (!events.ok) {
      logExecutionStage(metrics, "conversation_event_extraction_failed", {
        error: events.error,
        details: events.details
      });
      return { ok: false as const, status: 502, error: events.error, metrics };
    }
    source = { ...source, conversationEvents: events.events };
  }
  const conversationEvents = source.conversationEvents ?? [];
  logExecutionStage(metrics, "conversation_events_extracted", {
    events: conversationEvents.length,
    linked_events: conversationEvents.filter((event) => event.linked_event_refs.length > 0).length
  });

  const candidates = await dependencies.generateCandidates(source);
  metrics.openAiLatencyMs.candidates = candidates.latencyMs;
  if (!candidates.ok) {
    metrics.validationFailures += Number(candidates.validationFailure);
    logExecutionStage(metrics, "candidate_generation_failed", {
      error: candidates.error,
      details: candidates.details
    });
    return { ok: false as const, status: 502, error: candidates.error, metrics };
  }
  metrics.salvagedItems += candidates.salvagedItems ?? 0;
  const responsibilityGraph = responsibilitiesOnlyGraph(candidates.graph);
  let responsibilityLedger = buildResponsibilityLedger({
    graph: responsibilityGraph,
    events: conversationEvents
  });
  metrics.candidateCommitments = 0;
  metrics.candidateTasks = responsibilityGraph.tasks.length;
  logExecutionStage(metrics, "candidates_generated", {
    commitments: metrics.candidateCommitments,
    tasks: metrics.candidateTasks
  });

  const verified = await dependencies.verifyGraph({
    source,
    graph: responsibilityGraph
  });
  metrics.openAiLatencyMs.initialVerification = verified.latencyMs;
  if (!verified.ok) {
    metrics.validationFailures += Number(verified.validationFailure);
    logExecutionStage(metrics, "initial_verification_failed", {
      error: verified.error,
      details: verified.details,
      validation_failure: verified.validationFailure
    });
    return { ok: false as const, status: 502, error: verified.error, metrics };
  }
  metrics.salvagedItems += verified.salvagedItems ?? 0;

  const initiallyResolved = resolveAssigneesAndDueDates(
    responsibilitiesOnlyGraph(verified.graph)
  );
  const initiallyGrounded = enforceExecutionGraphGrounding({
    source,
    graph: initiallyResolved
  });
  metrics.groundingRejectedCommitments +=
    initiallyGrounded.rejectedCommitments;
  metrics.groundingRejectedTasks += initiallyGrounded.rejectedTasks;
  metrics.verifiedCommitments = initiallyGrounded.graph.commitments.length;
  metrics.verifiedTasks = initiallyGrounded.graph.tasks.length;
  logExecutionStage(metrics, "initial_graph_verified", {
    commitments: metrics.verifiedCommitments,
    tasks: metrics.verifiedTasks
  });

  const missing = await dependencies.findMissing({
    source,
    graph: initiallyGrounded.graph
  });
  metrics.openAiLatencyMs.completeness = missing.latencyMs;
  if (!missing.ok) {
    metrics.validationFailures += Number(missing.validationFailure);
    logExecutionStage(metrics, "completeness_failed", {
      error: missing.error,
      details: missing.details,
      validation_failure: missing.validationFailure
    });
    return { ok: false as const, status: 502, error: missing.error, metrics };
  }
  metrics.salvagedItems += missing.salvagedItems ?? 0;
  metrics.missingCommitments = missing.graph.commitments.length;
  metrics.missingTasks = missing.graph.tasks.length;

  const merged = mergeAndDeduplicateGraphs(
    initiallyGrounded.graph,
    responsibilitiesOnlyGraph(missing.graph)
  );
  metrics.deduplicatedCommitments += merged.deduplicatedCommitments;
  metrics.deduplicatedTasks += merged.deduplicatedTasks;

  const preFinalNormalized = normalizeExecutionGraphQuality(merged.graph);
  logExecutionStage(metrics, "graph_quality_normalized", {
    phase: "before_final_verification",
    removed_ownership_commitments:
      preFinalNormalized.removedOwnershipCommitments,
    removed_ownership_tasks: preFinalNormalized.removedOwnershipTasks,
    merged_group_tasks: preFinalNormalized.mergedGroupTasks,
    blocker_tasks_added: preFinalNormalized.blockerTasksAdded
  });

  // Completeness candidates are normalized and verified again before persistence.
  const finalVerification = await dependencies.verifyGraph({
    source,
    graph: preFinalNormalized.graph
  });
  metrics.openAiLatencyMs.finalVerification = finalVerification.latencyMs;
  if (!finalVerification.ok) {
    metrics.validationFailures += Number(finalVerification.validationFailure);
    logExecutionStage(metrics, "final_verification_failed", {
      error: finalVerification.error,
      details: finalVerification.details,
      validation_failure: finalVerification.validationFailure
    });
    return {
      ok: false as const,
      status: 502,
      error: finalVerification.error,
      metrics
    };
  }
  metrics.salvagedItems += finalVerification.salvagedItems ?? 0;

  const finalResolved = resolveAssigneesAndDueDates(
    responsibilitiesOnlyGraph(finalVerification.graph)
  );
  const finalNormalized = normalizeExecutionGraphQuality(finalResolved);
  logExecutionStage(metrics, "graph_quality_normalized", {
    phase: "after_final_verification",
    removed_ownership_commitments: finalNormalized.removedOwnershipCommitments,
    removed_ownership_tasks: finalNormalized.removedOwnershipTasks,
    merged_group_tasks: finalNormalized.mergedGroupTasks,
    blocker_tasks_added: finalNormalized.blockerTasksAdded
  });
  const finalGrounded = enforceExecutionGraphGrounding({
    source,
    graph: finalNormalized.graph
  });
  metrics.groundingRejectedCommitments += finalGrounded.rejectedCommitments;
  metrics.groundingRejectedTasks += finalGrounded.rejectedTasks;

  const finalDeduped = mergeAndDeduplicateGraphs(finalGrounded.graph);
  metrics.deduplicatedCommitments += finalDeduped.deduplicatedCommitments;
  metrics.deduplicatedTasks += finalDeduped.deduplicatedTasks;
  responsibilityLedger = buildResponsibilityLedger({
    graph: finalDeduped.graph,
    events: conversationEvents
  });

  const synthesis = await dependencies.synthesizeGraph({
    source,
    graph: finalDeduped.graph
  });
  metrics.openAiLatencyMs.synthesis = synthesis.latencyMs;
  if (!synthesis.ok) {
    metrics.validationFailures += Number(synthesis.validationFailure);
    logExecutionStage(metrics, "synthesis_failed", {
      error: synthesis.error,
      details: synthesis.details,
      validation_failure: synthesis.validationFailure
    });
    return {
      ok: false as const,
      status: 502,
      error: synthesis.error,
      metrics
    };
  }
  metrics.salvagedItems += synthesis.salvagedItems ?? 0;
  const judged = await dependencies.judgeGraph({ source, graph: synthesis.graph });
  metrics.openAiLatencyMs.judge = judged.latencyMs;
  if (!judged.ok) {
    metrics.validationFailures += Number(judged.validationFailure);
    return { ok: false as const, status: 502, error: judged.error, metrics };
  }
  metrics.salvagedItems += judged.salvagedItems ?? 0;
  const promotionGuard = applyCommitmentPromotionGuard(judged.graph);
  const synthesizedCommittedOutcomes = promotionGuard.graph.commitments.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  if (synthesizedCommittedOutcomes > 7) {
    logExecutionStage(metrics, "synthesis_fragmentation_warning", {
      committed_outcomes: synthesizedCommittedOutcomes,
      quality_signal: "more_than_seven_commitments"
    });
  }
  const synthesisResolved = resolveAssigneesAndDueDates(
    linkTasksToCommitments(promotionGuard.graph)
  );
  const synthesisGrounded = enforceExecutionGraphGrounding({
    source,
    graph: normalizeExecutionGraphQuality(synthesisResolved).graph
  });
  metrics.groundingRejectedCommitments += synthesisGrounded.rejectedCommitments;
  metrics.groundingRejectedTasks += synthesisGrounded.rejectedTasks;
  const synthesisDeduped = mergeAndDeduplicateGraphs(synthesisGrounded.graph);
  metrics.deduplicatedCommitments += synthesisDeduped.deduplicatedCommitments;
  metrics.deduplicatedTasks += synthesisDeduped.deduplicatedTasks;

  const acceptedWork = ensureAcceptedWorkTasks({
    graph: synthesisDeduped.graph,
    events: conversationEvents
  });
  logExecutionStage(metrics, "accepted_work_audited", {
    standalone_tasks_added: acceptedWork.added
  });
  const consolidated = consolidateExecutionGraph(acceptedWork.graph, {
    projectName: source.project?.name,
    projectGoal: source.project?.goal
  });
  logExecutionStage(metrics, "graph_consolidated", {
    merged_commitments: consolidated.mergedCommitments,
    converted_commitments: consolidated.convertedCommitments,
    merged_tasks: consolidated.mergedTasks,
    rejected_restatements: consolidated.rejectedRestatements,
    removed_generic_inferred: consolidated.removedGenericInferred
  });

  const graph: ExecutionGraph = consolidated.graph;
  const reasoningTrace = finalizeResponsibilityTrace({
    ledger: responsibilityLedger,
    graph,
    judgments: promotionGuard.judgments
  });
  metrics.verifiedCommitments = graph.commitments.length;
  metrics.verifiedTasks = graph.tasks.length;
  metrics.linkedTasks = graph.tasks.filter((task) => task.commitment_ref).length;
  metrics.unlinkedTasks = graph.tasks.length - metrics.linkedTasks;
  logExecutionStage(metrics, "final_graph_verified", {
    commitments: metrics.verifiedCommitments,
    tasks: metrics.verifiedTasks,
    linked_tasks: metrics.linkedTasks,
    unlinked_tasks: metrics.unlinkedTasks
  });

  const groundedExecutionSignals = conversationEvents.filter(
    (event) => ["accepted", "explicit"].includes(event.commitment_signal)
  ).length;
  const committedCommitments = graph.commitments.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  const committedTasks = graph.tasks.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  if (
    groundedExecutionSignals > 0 &&
    committedCommitments === 0 &&
    committedTasks === 0
  ) {
    logExecutionStage(metrics, "completeness_invariant_failed", {
      grounded_execution_signals: groundedExecutionSignals
    });
    return {
      ok: false as const,
      status: 502,
      error:
        "Completeness verification found no executable work despite accepted conversation events.",
      metrics
    };
  }

  const persisted = await dependencies.persistGraph({
    meetingId: source.meetingId,
    generation: input.generation,
    graph
  });
  if (!persisted.ok) {
    metrics.databaseFailures += 1;
    logExecutionStage(metrics, "persistence_failed", {
      error: persisted.error,
      details: persisted.details
    });
    return {
      ok: false as const,
      status: persisted.stale ? 409 : 500,
      error: persisted.error,
      details: persisted.details,
      metrics
    };
  }
  const persistedEvents = await dependencies.persistEvents({
    meetingId: source.meetingId,
    generation: input.generation,
    events: conversationEvents
  });
  if (!persistedEvents.ok) {
    metrics.databaseFailures += 1;
    return { ok: false as const, status: 500, error: persistedEvents.error, metrics };
  }

  logExecutionSummary(metrics);
  return {
    ok: true as const,
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    graph,
    reasoningTrace,
    metrics
  };
}
