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
import { resolveAssigneesAndDueDates } from "./resolution";
import type { ExecutionGraph } from "./schemas";
import {
  findMissingExecutionWorkInBatches,
  generateChunkedExecutionCandidates,
  verifyExecutionGraphInBatches,
  type ExecutionSourceContext
} from "./stages";

export type DurableExecutionState = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  metrics: ExecutionMetrics;
  graph: ExecutionGraph;
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
  metrics.candidateCommitments = candidates.graph.commitments.length;
  metrics.candidateTasks = candidates.graph.tasks.length;
  logExecutionStage(metrics, "candidates_generated", {
    commitments: metrics.candidateCommitments,
    tasks: metrics.candidateTasks
  });
  return { ...input, metrics, graph: candidates.graph };
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
  const resolved = resolveAssigneesAndDueDates(linkTasksToCommitments(verified.graph));
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
  const merged = mergeAndDeduplicateGraphs(state.graph, missing.graph);
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
  const resolved = resolveAssigneesAndDueDates(linkTasksToCommitments(verified.graph));
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

  const consolidated = consolidateExecutionGraph(deduped.graph);
  logExecutionStage(state.metrics, "graph_consolidated", {
    merged_commitments: consolidated.mergedCommitments,
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

  const insightNextSteps = state.source.insights.filter(
    (insight) => insight.category === "next_steps"
  ).length;
  const committed = countCommittedWork(consolidated.graph);
  if (insightNextSteps > 0 && committed.commitments === 0 && committed.tasks === 0) {
    stageFailure(
      "final_verification",
      "Completeness verification found no executable work despite insight next steps."
    );
  }
  return { ...state, graph: consolidated.graph };
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
  logExecutionSummary(input.state.metrics);
  return {
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    metrics: input.state.metrics
  };
}
