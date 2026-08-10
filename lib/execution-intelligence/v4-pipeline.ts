import {
  createExecutionMetrics,
  logExecutionStage,
  logExecutionSummary,
  type ExecutionMetrics
} from "./observability";
import { persistConversationEvents, persistExecutionGraph } from "./persistence";
import { extractAndLinkConversationEvents } from "./conversation-events";
import { transcriptSourceSegmentIds } from "./conversation-event-identity";
import {
  assembleExecutionTree,
  isEligibleAcceptanceCriterion,
  isExecutionEligible,
  isFutureScopeItem,
  validateFinalTree,
  type GroupDecision,
  type WorkItemDecision
} from "./execution-tree";
import { treeToExecutionGraph } from "./execution-graph-v4";
import { mergeTopicWorkItems, type TopicWorkItemExtraction } from "./work-item-merge";
import {
  consolidateExecutionTree,
  type ConsolidationDecision
} from "./task-consolidation";
import { normalizeTranscriptSafely, type NormalizationResult } from "./transcript-normalization";
import {
  extractTopicWorkItems,
  runGlobalCorrectionPass,
  runGroupingPass,
  runGroupingVerificationPass
} from "./work-item-stages";
import { participantMap, type ExecutionSourceContext } from "./stages";
import type {
  ExecutionTree,
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
  GroupProposal,
  TaskMergeProvenance,
  VerifiedGroup,
  WorkItem
} from "./work-item-schemas";
import type { ExecutionGraph } from "./schemas";

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function buildProjectGlossary(source: ExecutionSourceContext): string[] {
  const glossary = new Set<string>();
  if (source.project?.name) glossary.add(source.project.name);
  return Array.from(glossary);
}

/**
 * Applies the global scope/role reconciliation pass's output to the merged work-item ledger.
 * Corrections only ever touch classification/status/acceptance_state/execution_scope/scope_state/
 * work_item_role/owner/evidence for a ref that already exists; anything else (title,
 * extraction_reason, confidence, topic_id) is untouched. Additions become brand-new work items
 * with app-assigned refs -- the model never owns identity here either. An addition or evidence
 * correction with no valid, transcript-grounded segment ID is dropped rather than trusted.
 */
export function applyGlobalCorrections(input: {
  workItems: WorkItem[];
  corrections: GlobalWorkItemCorrection[];
  additions: GlobalWorkItemAddition[];
  transcript: string;
}): WorkItem[] {
  const validSegments = new Set(transcriptSourceSegmentIds(input.transcript));
  const correctionsByRef = new Map(input.corrections.map((correction) => [correction.ref, correction]));
  const corrected = input.workItems.map((item) => {
    const correction = correctionsByRef.get(item.ref);
    if (!correction) return item;
    const validEvidence =
      normalizeText(correction.source_quote).length > 0 &&
      correction.source_segment_ids.some((id) => validSegments.has(id));
    return {
      ...item,
      classification: correction.classification,
      status: correction.status,
      acceptance_state: correction.acceptance_state,
      execution_scope: correction.execution_scope,
      scope_state: correction.scope_state,
      work_item_role: correction.work_item_role,
      owner: correction.owner,
      owners: correction.owners,
      classification_reason: correction.classification_reason,
      reconciliation_reason: correction.reconciliation_reason,
      superseding_segment_ids: correction.superseding_segment_ids.filter((id) => validSegments.has(id)),
      superseded_item_refs: correction.superseded_item_refs,
      ...(validEvidence
        ? {
            source_quote: correction.source_quote,
            source_segment_ids: correction.source_segment_ids.filter((id) => validSegments.has(id))
          }
        : {})
    };
  });
  const additions: WorkItem[] = input.additions.flatMap((addition, index) => {
    const segmentIds = addition.source_segment_ids.filter((id) => validSegments.has(id));
    if (!normalizeText(addition.source_quote) || segmentIds.length === 0) return [];
    return [{ ...addition, source_segment_ids: segmentIds, ref: `wi_g${index + 1}`, topic_id: null }];
  });
  return [...corrected, ...additions];
}

export type V4ExecutionTrace = {
  version: "execution-tree-v4-hardened-2";
  normalization: {
    enabled: boolean;
    failed: boolean;
    failure_reason: string | null;
    corrections: NormalizationResult["corrections"];
    applied_corrections: NormalizationResult["appliedCorrections"];
  };
  topic_work_items: TopicWorkItemExtraction[];
  merged_work_items: WorkItem[];
  global_corrections: GlobalWorkItemCorrection[];
  global_additions: GlobalWorkItemAddition[];
  corrected_work_items: WorkItem[];
  superseded_work_items: WorkItem[];
  eligible_work_items: WorkItem[];
  acceptance_criteria_items: WorkItem[];
  future_scope_items: WorkItem[];
  excluded_work_items: Array<WorkItem & { exclusion_reason: string | null }>;
  draft_groups: GroupProposal[];
  verified_groups: VerifiedGroup[];
  group_decisions: GroupDecision[];
  work_item_decisions: WorkItemDecision[];
  pre_consolidation_tree: ExecutionTree;
  consolidation_decisions: ConsolidationDecision[];
  consolidation_suggestions: ConsolidationDecision[];
  consolidation_provenance: Record<string, TaskMergeProvenance>;
  final_validation: { ok: boolean; errors: string[] };
  commitments_debug: Array<ExecutionTree["commitments"][number] & { decision: GroupDecision | null }>;
  work_items_debug: Array<WorkItem & { decision: WorkItemDecision | null }>;
  final_tree: ExecutionTree;
  final_graph: ExecutionGraph;
};

export type V4ExecutionState = {
  source: ExecutionSourceContext;
  rawTranscript: string;
  fallbackUsed: boolean;
  metrics: ExecutionMetrics;
  normalization: NormalizationResult;
  topicWorkItems: TopicWorkItemExtraction[];
  mergedWorkItems: WorkItem[];
  globalCorrections: GlobalWorkItemCorrection[];
  globalAdditions: GlobalWorkItemAddition[];
  workItems: WorkItem[];
  eligibleWorkItems: WorkItem[];
  acceptanceCriteriaItems: WorkItem[];
  draftGroups: GroupProposal[];
  verifiedGroups: VerifiedGroup[];
  groupDecisions: GroupDecision[];
  workItemDecisions: WorkItemDecision[];
  preConsolidationTree: ExecutionTree;
  consolidationDecisions: ConsolidationDecision[];
  consolidationSuggestions: ConsolidationDecision[];
  consolidationProvenance: Record<string, TaskMergeProvenance>;
  finalValidation: { ok: boolean; errors: string[] };
  tree: ExecutionTree;
  graph: ExecutionGraph;
  debugTrace?: V4ExecutionTrace;
};

function stageFailure(stage: string, error: string, details?: string): never {
  throw new Error(`${stage}: ${details ? `${error}: ${details}` : error}`);
}

const EMPTY_TREE: ExecutionTree = { commitments: [], standalone_tasks: [] };

export async function runV4WorkItemExtraction(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
}): Promise<V4ExecutionState> {
  const metrics = createExecutionMetrics(input.source.meetingId, input.fallbackUsed);

  // Phase 0: optional, non-blocking transcript normalization. Never blocks or fails the run --
  // any problem falls back to the untouched raw transcript.
  const normalization = await normalizeTranscriptSafely({
    meetingId: input.source.meetingId,
    meetingDate: input.source.meetingDate,
    transcript: input.source.transcript,
    participants: participantMap(input.source.transcript).map((participant) => participant.name),
    projectGlossary: buildProjectGlossary(input.source)
  });
  metrics.openAiLatencyMs.transcriptNormalization = normalization.latencyMs;
  if (normalization.usage) metrics.openAiUsage.transcriptNormalization = normalization.usage;
  const normalizedSource: ExecutionSourceContext = {
    ...input.source,
    transcript: normalization.normalizedTranscript
  };
  logExecutionStage(metrics, "v4_transcript_normalized", {
    enabled: normalization.enabled,
    failed: normalization.failed,
    proposed_corrections: normalization.corrections.length,
    applied_corrections: normalization.appliedCorrections.length
  });

  const extracted = await extractTopicWorkItems(normalizedSource);
  metrics.openAiLatencyMs.workItemExtraction = extracted.latencyMs;
  if (!extracted.ok) {
    metrics.validationFailures += Number(extracted.validationFailure);
    stageFailure("v4_work_item_extraction", extracted.error, extracted.details);
  }
  if (extracted.usage) metrics.openAiUsage.workItemExtraction = extracted.usage;
  const merged = mergeTopicWorkItems(extracted.topics);
  metrics.deduplicatedTasks += merged.deduplicated;
  metrics.candidateCommitments = 0;
  metrics.candidateTasks = merged.items.length;
  logExecutionStage(metrics, "v4_work_items_merged", {
    topics: extracted.topics.length,
    items: merged.items.length,
    deduplicated: merged.deduplicated
  });
  return {
    source: normalizedSource,
    rawTranscript: input.source.transcript,
    fallbackUsed: input.fallbackUsed,
    metrics,
    normalization,
    topicWorkItems: extracted.topics,
    mergedWorkItems: merged.items,
    globalCorrections: [],
    globalAdditions: [],
    workItems: merged.items,
    eligibleWorkItems: [],
    acceptanceCriteriaItems: [],
    draftGroups: [],
    verifiedGroups: [],
    groupDecisions: [],
    workItemDecisions: [],
    preConsolidationTree: EMPTY_TREE,
    consolidationDecisions: [],
    consolidationSuggestions: [],
    consolidationProvenance: {},
    finalValidation: { ok: true, errors: [] },
    tree: EMPTY_TREE,
    graph: { commitments: [], tasks: [] }
  };
}

export async function runV4ConversationEventExtraction(
  source: ExecutionSourceContext,
  generation: number
): Promise<ExecutionSourceContext> {
  const result = await extractAndLinkConversationEvents(source, { generation });
  if (!result.ok) {
    console.warn("[execution-intelligence-v4] Optional Conversation Event extraction failed", {
      meeting_id: source.meetingId,
      error: result.error,
      details: result.details
    });
    return { ...source, conversationEvents: [] };
  }
  return { ...source, conversationEvents: result.events };
}

export async function runV4GlobalCorrection(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await runGlobalCorrectionPass({ source: state.source, workItems: state.mergedWorkItems });
  state.metrics.openAiLatencyMs.globalCorrection = result.latencyMs;
  if (!result.ok) {
    state.metrics.validationFailures += Number(result.validationFailure);
    stageFailure("v4_global_correction", result.error, result.details);
  }
  if (result.usage) state.metrics.openAiUsage.globalCorrection = result.usage;
  state.metrics.salvagedItems += result.salvagedItems ?? 0;
  const workItems = applyGlobalCorrections({
    workItems: state.mergedWorkItems,
    corrections: result.corrections,
    additions: result.additions,
    transcript: state.source.transcript
  });
  const eligibleWorkItems = workItems.filter(isExecutionEligible);
  const acceptanceCriteriaItems = workItems.filter(isEligibleAcceptanceCriterion);
  logExecutionStage(state.metrics, "v4_global_correction_applied", {
    corrections: result.corrections.length,
    additions: result.additions.length,
    total_work_items: workItems.length,
    eligible_work_items: eligibleWorkItems.length,
    acceptance_criteria: acceptanceCriteriaItems.length
  });
  return {
    ...state,
    globalCorrections: result.corrections,
    globalAdditions: result.additions,
    workItems,
    eligibleWorkItems,
    acceptanceCriteriaItems
  };
}

export async function runV4Grouping(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await runGroupingPass({
    source: state.source,
    eligibleItems: state.eligibleWorkItems,
    acceptanceCriteria: state.acceptanceCriteriaItems
  });
  state.metrics.openAiLatencyMs.grouping = result.latencyMs;
  if (!result.ok) {
    state.metrics.validationFailures += Number(result.validationFailure);
    stageFailure("v4_grouping", result.error, result.details);
  }
  if (result.usage) state.metrics.openAiUsage.grouping = result.usage;
  state.metrics.salvagedItems += result.salvagedItems ?? 0;
  logExecutionStage(state.metrics, "v4_groups_proposed", { groups: result.groups.length });
  return { ...state, draftGroups: result.groups };
}

export async function runV4GroupingVerification(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await runGroupingVerificationPass({
    source: state.source,
    eligibleItems: state.eligibleWorkItems,
    acceptanceCriteria: state.acceptanceCriteriaItems,
    draftGroups: state.draftGroups
  });
  state.metrics.openAiLatencyMs.groupingVerification = result.latencyMs;
  if (!result.ok) {
    state.metrics.validationFailures += Number(result.validationFailure);
    stageFailure("v4_grouping_verification", result.error, result.details);
  }
  if (result.usage) state.metrics.openAiUsage.groupingVerification = result.usage;
  state.metrics.salvagedItems += result.salvagedItems ?? 0;
  return { ...state, verifiedGroups: result.groups };
}

export async function runV4TreeAssembly(state: V4ExecutionState): Promise<V4ExecutionState> {
  const assembled = assembleExecutionTree({
    transcript: state.source.transcript,
    workItems: state.workItems,
    draftGroups: state.draftGroups,
    verifiedGroups: state.verifiedGroups
  });
  logExecutionStage(state.metrics, "v4_tree_assembled", {
    commitments: assembled.tree.commitments.length,
    linked_tasks: assembled.tree.commitments.reduce((sum, c) => sum + c.tasks.length, 0),
    standalone_tasks: assembled.tree.standalone_tasks.length
  });
  return {
    ...state,
    groupDecisions: assembled.groupDecisions,
    workItemDecisions: assembled.workItemDecisions,
    preConsolidationTree: assembled.tree,
    tree: assembled.tree,
    graph: treeToExecutionGraph(assembled.tree)
  };
}

/** Phase 5: background task consolidation. Runs after tree assembly, before final validation. */
export async function runV4TaskConsolidation(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await consolidateExecutionTree({
    meetingId: state.source.meetingId,
    tree: state.preConsolidationTree
  });
  state.metrics.openAiLatencyMs.taskConsolidation = result.modelLatencyMs;
  if (result.modelUsage) state.metrics.openAiUsage.taskConsolidation = result.modelUsage;
  const linkedTasks = result.tree.commitments.reduce((sum, c) => sum + c.tasks.length, 0);
  state.metrics.linkedTasks = linkedTasks;
  state.metrics.unlinkedTasks = result.tree.standalone_tasks.length;
  state.metrics.verifiedCommitments = result.tree.commitments.length;
  state.metrics.verifiedTasks = linkedTasks + result.tree.standalone_tasks.length;
  logExecutionStage(state.metrics, "v4_tasks_consolidated", {
    decisions: result.decisions.length,
    applied: result.decisions.filter((d) => d.applied).length,
    suggestions: result.suggestions.length,
    commitments: result.tree.commitments.length,
    standalone_tasks: result.tree.standalone_tasks.length
  });
  const consolidationProvenance = Object.fromEntries(result.provenanceByRef);
  return {
    ...state,
    tree: result.tree,
    graph: treeToExecutionGraph(result.tree, consolidationProvenance),
    consolidationDecisions: result.decisions,
    consolidationSuggestions: result.suggestions,
    consolidationProvenance
  };
}

/** Phase 6: final deterministic integrity check + trace finalization. No model call. If
 * consolidation produced a corrupted tree, falls back to the pre-consolidation tree rather than
 * ever persisting a partial/corrupted graph. */
export async function finalizeV4Execution(state: V4ExecutionState): Promise<V4ExecutionState> {
  const validation = validateFinalTree(state.tree);
  let tree = state.tree;
  let graph = state.graph;
  if (!validation.ok) {
    console.warn("[execution-intelligence-v4] Final validation failed; falling back to pre-consolidation tree", {
      meeting_id: state.source.meetingId,
      errors: validation.errors
    });
    tree = state.preConsolidationTree;
    graph = treeToExecutionGraph(tree);
  }
  const finalState = { ...state, tree, graph, finalValidation: validation.ok ? { ok: true, errors: [] } : validation };

  const decisionByGroupRef = new Map(
    finalState.groupDecisions.map((decision) => [decision.group_ref, decision])
  );
  const decisionByWorkItemRef = new Map(
    finalState.workItemDecisions.map((decision) => [decision.work_item_ref, decision])
  );
  const debugTrace: V4ExecutionTrace = {
    version: "execution-tree-v4-hardened-2",
    normalization: {
      enabled: finalState.normalization.enabled,
      failed: finalState.normalization.failed,
      failure_reason: finalState.normalization.failureReason,
      corrections: finalState.normalization.corrections,
      applied_corrections: finalState.normalization.appliedCorrections
    },
    topic_work_items: finalState.topicWorkItems,
    merged_work_items: finalState.mergedWorkItems,
    global_corrections: finalState.globalCorrections,
    global_additions: finalState.globalAdditions,
    corrected_work_items: finalState.workItems,
    superseded_work_items: finalState.workItems.filter((item) => item.scope_state === "superseded"),
    eligible_work_items: finalState.eligibleWorkItems,
    acceptance_criteria_items: finalState.acceptanceCriteriaItems,
    future_scope_items: finalState.workItems.filter(isFutureScopeItem),
    excluded_work_items: finalState.workItems
      .filter((item) => !isExecutionEligible(item) && !isEligibleAcceptanceCriterion(item))
      .map((item) => ({
        ...item,
        exclusion_reason: decisionByWorkItemRef.get(item.ref)?.reason ?? null
      })),
    draft_groups: finalState.draftGroups,
    verified_groups: finalState.verifiedGroups,
    group_decisions: finalState.groupDecisions,
    work_item_decisions: finalState.workItemDecisions,
    pre_consolidation_tree: finalState.preConsolidationTree,
    consolidation_decisions: finalState.consolidationDecisions,
    consolidation_suggestions: finalState.consolidationSuggestions,
    consolidation_provenance: finalState.consolidationProvenance,
    final_validation: finalState.finalValidation,
    commitments_debug: finalState.tree.commitments.map((commitment) => ({
      ...commitment,
      decision: decisionByGroupRef.get(commitment.ref) ?? null
    })),
    work_items_debug: finalState.workItems.map((item) => ({
      ...item,
      decision: decisionByWorkItemRef.get(item.ref) ?? null
    })),
    final_tree: finalState.tree,
    final_graph: finalState.graph
  };
  logExecutionStage(finalState.metrics, "v4_finalized", {
    validation_ok: finalState.finalValidation.ok,
    commitments: finalState.tree.commitments.length,
    standalone_tasks: finalState.tree.standalone_tasks.length
  });
  return { ...finalState, debugTrace };
}

export async function persistV4ExecutionGraph(input: {
  state: V4ExecutionState;
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
    validSourceSegmentIds: transcriptSourceSegmentIds(input.state.source.transcript)
  });
  if (!persistedEvents.ok) {
    console.warn("[execution-intelligence-v4] Optional Conversation Event persistence failed", {
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

/** Synchronous, non-durable wrapper for tests, the dev debug endpoint, and evaluation scripts. */
export async function runV4ExecutionIntelligence(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  generation: number;
  persistGraph?: typeof persistExecutionGraph;
  persistEvents?: typeof persistConversationEvents;
}) {
  let state = await runV4WorkItemExtraction({
    source: input.source,
    fallbackUsed: input.fallbackUsed
  });
  state = await runV4GlobalCorrection(state);
  state = await runV4Grouping(state);
  state = await runV4GroupingVerification(state);
  state = await runV4TreeAssembly(state);
  state = await runV4TaskConsolidation(state);
  state = await finalizeV4Execution(state);

  const persistGraph = input.persistGraph ?? persistExecutionGraph;
  const persisted = await persistGraph({
    meetingId: input.source.meetingId,
    generation: input.generation,
    graph: state.graph
  });
  if (!persisted.ok) {
    return {
      ok: false as const,
      error: persisted.error,
      details: persisted.details,
      status: persisted.stale ? 409 : 500,
      metrics: state.metrics
    };
  }

  const persistEvents = input.persistEvents ?? persistConversationEvents;
  const persistedEvents = await persistEvents({
    meetingId: input.source.meetingId,
    generation: input.generation,
    events: input.source.conversationEvents ?? [],
    validSourceSegmentIds: transcriptSourceSegmentIds(input.source.transcript)
  });
  if (!persistedEvents.ok) {
    console.warn("[execution-intelligence-v4] Optional Conversation Event persistence failed", {
      meeting_id: input.source.meetingId,
      error: persistedEvents.error,
      details: persistedEvents.details
    });
  }

  return {
    ok: true as const,
    graph: state.graph,
    tree: state.tree,
    debugTrace: state.debugTrace,
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    metrics: state.metrics
  };
}
