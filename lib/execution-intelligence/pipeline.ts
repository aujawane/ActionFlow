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
import { persistExecutionGraph } from "./persistence";
import { resolveAssigneesAndDueDates } from "./resolution";
import type { ExecutionGraph } from "./schemas";
import {
  findMissingExecutionWorkInBatches,
  generateChunkedExecutionCandidates,
  verifyExecutionGraphInBatches,
  type ExecutionSourceContext
} from "./stages";

type ExecutionPipelineDependencies = {
  generateCandidates: typeof generateChunkedExecutionCandidates;
  verifyGraph: typeof verifyExecutionGraphInBatches;
  findMissing: typeof findMissingExecutionWorkInBatches;
  persistGraph: typeof persistExecutionGraph;
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
    persistGraph: persistExecutionGraph,
    ...input.dependencies
  };
  const metrics = createExecutionMetrics(
    input.source.meetingId,
    input.fallbackUsed
  );

  const candidates = await dependencies.generateCandidates(input.source);
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
  metrics.candidateCommitments = candidates.graph.commitments.length;
  metrics.candidateTasks = candidates.graph.tasks.length;
  logExecutionStage(metrics, "candidates_generated", {
    commitments: metrics.candidateCommitments,
    tasks: metrics.candidateTasks
  });

  const verified = await dependencies.verifyGraph({
    source: input.source,
    graph: candidates.graph
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
    linkTasksToCommitments(verified.graph)
  );
  const initiallyGrounded = enforceExecutionGraphGrounding({
    source: input.source,
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
    source: input.source,
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
    missing.graph
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
    source: input.source,
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
    linkTasksToCommitments(finalVerification.graph)
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
    source: input.source,
    graph: finalNormalized.graph
  });
  metrics.groundingRejectedCommitments += finalGrounded.rejectedCommitments;
  metrics.groundingRejectedTasks += finalGrounded.rejectedTasks;

  const finalDeduped = mergeAndDeduplicateGraphs(finalGrounded.graph);
  metrics.deduplicatedCommitments += finalDeduped.deduplicatedCommitments;
  metrics.deduplicatedTasks += finalDeduped.deduplicatedTasks;

  const consolidated = consolidateExecutionGraph(finalDeduped.graph);
  logExecutionStage(metrics, "graph_consolidated", {
    merged_commitments: consolidated.mergedCommitments,
    merged_tasks: consolidated.mergedTasks,
    rejected_restatements: consolidated.rejectedRestatements,
    removed_generic_inferred: consolidated.removedGenericInferred
  });

  const graph: ExecutionGraph = consolidated.graph;
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

  const insightNextSteps = input.source.insights.filter(
    (insight) => insight.category === "next_steps"
  ).length;
  const committedCommitments = graph.commitments.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  const committedTasks = graph.tasks.filter(
    (item) => (item.execution_classification ?? "committed") === "committed"
  ).length;
  if (
    insightNextSteps > 0 &&
    committedCommitments === 0 &&
    committedTasks === 0
  ) {
    logExecutionStage(metrics, "completeness_invariant_failed", {
      insight_next_steps: insightNextSteps
    });
    return {
      ok: false as const,
      status: 502,
      error:
        "Completeness verification found no executable work despite insight next steps.",
      metrics
    };
  }

  const persisted = await dependencies.persistGraph({
    meetingId: input.source.meetingId,
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

  logExecutionSummary(metrics);
  return {
    ok: true as const,
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    graph,
    metrics
  };
}
