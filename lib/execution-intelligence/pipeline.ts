import {
  enforceExecutionGraphGrounding,
  mergeAndDeduplicateGraphs
} from "./graph";
import { linkTasksToCommitments } from "./linking";
import {
  createExecutionMetrics,
  logExecutionStage,
  logExecutionSummary
} from "./observability";
import { persistExecutionGraph } from "./persistence";
import { resolveAssigneesAndDueDates } from "./resolution";
import type { ExecutionGraph } from "./schemas";
import {
  findMissingExecutionWork,
  generateExecutionCandidates,
  verifyExecutionGraph,
  type ExecutionSourceContext
} from "./stages";

type ExecutionPipelineDependencies = {
  generateCandidates: typeof generateExecutionCandidates;
  verifyGraph: typeof verifyExecutionGraph;
  findMissing: typeof findMissingExecutionWork;
  persistGraph: typeof persistExecutionGraph;
};

export async function runExecutionIntelligence(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  dependencies?: Partial<ExecutionPipelineDependencies>;
}) {
  const dependencies: ExecutionPipelineDependencies = {
    generateCandidates: generateExecutionCandidates,
    verifyGraph: verifyExecutionGraph,
    findMissing: findMissingExecutionWork,
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
    return { ok: false as const, status: 502, error: verified.error, metrics };
  }

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

  const missing = await dependencies.findMissing({
    source: input.source,
    graph: initiallyGrounded.graph
  });
  metrics.openAiLatencyMs.completeness = missing.latencyMs;
  if (!missing.ok) {
    metrics.validationFailures += Number(missing.validationFailure);
    return { ok: false as const, status: 502, error: missing.error, metrics };
  }
  metrics.missingCommitments = missing.graph.commitments.length;
  metrics.missingTasks = missing.graph.tasks.length;

  const merged = mergeAndDeduplicateGraphs(
    initiallyGrounded.graph,
    missing.graph
  );
  metrics.deduplicatedCommitments += merged.deduplicatedCommitments;
  metrics.deduplicatedTasks += merged.deduplicatedTasks;

  // Completeness candidates are verified again before persistence.
  const finalVerification = await dependencies.verifyGraph({
    source: input.source,
    graph: merged.graph
  });
  metrics.openAiLatencyMs.finalVerification = finalVerification.latencyMs;
  if (!finalVerification.ok) {
    metrics.validationFailures += Number(finalVerification.validationFailure);
    return {
      ok: false as const,
      status: 502,
      error: finalVerification.error,
      metrics
    };
  }

  const finalResolved = resolveAssigneesAndDueDates(
    linkTasksToCommitments(finalVerification.graph)
  );
  const finalGrounded = enforceExecutionGraphGrounding({
    source: input.source,
    graph: finalResolved
  });
  metrics.groundingRejectedCommitments += finalGrounded.rejectedCommitments;
  metrics.groundingRejectedTasks += finalGrounded.rejectedTasks;

  const finalDeduped = mergeAndDeduplicateGraphs(finalGrounded.graph);
  metrics.deduplicatedCommitments += finalDeduped.deduplicatedCommitments;
  metrics.deduplicatedTasks += finalDeduped.deduplicatedTasks;

  const graph: ExecutionGraph = finalDeduped.graph;
  metrics.verifiedCommitments = graph.commitments.length;
  metrics.verifiedTasks = graph.tasks.length;
  metrics.linkedTasks = graph.tasks.filter((task) => task.commitment_ref).length;
  metrics.unlinkedTasks = graph.tasks.length - metrics.linkedTasks;

  const insightNextSteps = input.source.insights.filter(
    (insight) => insight.category === "next_steps"
  ).length;
  if (
    insightNextSteps > 0 &&
    graph.commitments.length === 0 &&
    graph.tasks.length === 0
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
      status: 500,
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
