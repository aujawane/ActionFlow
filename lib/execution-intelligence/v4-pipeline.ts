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
  isExecutionEligible,
  type GroupDecision,
  type WorkItemDecision
} from "./execution-tree";
import { treeToExecutionGraph } from "./execution-graph-v4";
import { mergeTopicWorkItems, type TopicWorkItemExtraction } from "./work-item-merge";
import {
  extractTopicWorkItems,
  runGlobalCorrectionPass,
  runGroupingPass,
  runGroupingVerificationPass
} from "./work-item-stages";
import type {
  ExecutionTree,
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
  GroupProposal,
  VerifiedGroup,
  WorkItem
} from "./work-item-schemas";
import type { ExecutionGraph } from "./schemas";
import type { ExecutionSourceContext } from "./stages";

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim();
}

/**
 * Applies the global correction stage's output to the merged work-item ledger. Corrections only
 * ever touch classification/status/acceptance_state/execution_scope/owner/evidence for a ref that
 * already exists; anything else on the item (title, extraction_reason, confidence, topic_id) is
 * untouched. Additions become brand-new eligible-or-not work items with app-assigned refs -- the
 * model never owns identity here either. An addition or evidence correction with no valid,
 * transcript-grounded segment ID is dropped rather than trusted.
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
      owner: correction.owner,
      owners: correction.owners,
      classification_reason: correction.classification_reason,
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
  version: "execution-tree-v4-hardened-1";
  topic_work_items: TopicWorkItemExtraction[];
  merged_work_items: WorkItem[];
  global_corrections: GlobalWorkItemCorrection[];
  global_additions: GlobalWorkItemAddition[];
  corrected_work_items: WorkItem[];
  eligible_work_items: WorkItem[];
  excluded_work_items: Array<WorkItem & { exclusion_reason: string | null }>;
  draft_groups: GroupProposal[];
  verified_groups: VerifiedGroup[];
  group_decisions: GroupDecision[];
  work_item_decisions: WorkItemDecision[];
  commitments_debug: Array<GroupProposal & { tasks: WorkItem[]; decision: GroupDecision | null }>;
  work_items_debug: Array<WorkItem & { decision: WorkItemDecision | null }>;
  final_tree: ExecutionTree;
  final_graph: ExecutionGraph;
};

export type V4ExecutionState = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  metrics: ExecutionMetrics;
  topicWorkItems: TopicWorkItemExtraction[];
  mergedWorkItems: WorkItem[];
  globalCorrections: GlobalWorkItemCorrection[];
  globalAdditions: GlobalWorkItemAddition[];
  workItems: WorkItem[];
  eligibleWorkItems: WorkItem[];
  draftGroups: GroupProposal[];
  verifiedGroups: VerifiedGroup[];
  groupDecisions: GroupDecision[];
  workItemDecisions: WorkItemDecision[];
  tree: ExecutionTree;
  graph: ExecutionGraph;
  debugTrace?: V4ExecutionTrace;
};

function stageFailure(stage: string, error: string, details?: string): never {
  throw new Error(`${stage}: ${details ? `${error}: ${details}` : error}`);
}

export async function runV4WorkItemExtraction(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
}): Promise<V4ExecutionState> {
  const metrics = createExecutionMetrics(input.source.meetingId, input.fallbackUsed);
  const extracted = await extractTopicWorkItems(input.source);
  metrics.openAiLatencyMs.workItemExtraction = extracted.latencyMs;
  if (!extracted.ok) {
    metrics.validationFailures += Number(extracted.validationFailure);
    stageFailure("v4_work_item_extraction", extracted.error, extracted.details);
  }
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
    source: input.source,
    fallbackUsed: input.fallbackUsed,
    metrics,
    topicWorkItems: extracted.topics,
    mergedWorkItems: merged.items,
    globalCorrections: [],
    globalAdditions: [],
    workItems: merged.items,
    eligibleWorkItems: [],
    draftGroups: [],
    verifiedGroups: [],
    groupDecisions: [],
    workItemDecisions: [],
    tree: { commitments: [], standalone_tasks: [] },
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
  state.metrics.salvagedItems += result.salvagedItems ?? 0;
  const workItems = applyGlobalCorrections({
    workItems: state.mergedWorkItems,
    corrections: result.corrections,
    additions: result.additions,
    transcript: state.source.transcript
  });
  const eligibleWorkItems = workItems.filter(isExecutionEligible);
  logExecutionStage(state.metrics, "v4_global_correction_applied", {
    corrections: result.corrections.length,
    additions: result.additions.length,
    total_work_items: workItems.length,
    eligible_work_items: eligibleWorkItems.length
  });
  return {
    ...state,
    globalCorrections: result.corrections,
    globalAdditions: result.additions,
    workItems,
    eligibleWorkItems
  };
}

export async function runV4Grouping(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await runGroupingPass({
    source: state.source,
    eligibleItems: state.eligibleWorkItems
  });
  state.metrics.openAiLatencyMs.grouping = result.latencyMs;
  if (!result.ok) {
    state.metrics.validationFailures += Number(result.validationFailure);
    stageFailure("v4_grouping", result.error, result.details);
  }
  state.metrics.salvagedItems += result.salvagedItems ?? 0;
  logExecutionStage(state.metrics, "v4_groups_proposed", { groups: result.groups.length });
  return { ...state, draftGroups: result.groups };
}

export async function runV4GroupingVerification(state: V4ExecutionState): Promise<V4ExecutionState> {
  const result = await runGroupingVerificationPass({
    source: state.source,
    eligibleItems: state.eligibleWorkItems,
    draftGroups: state.draftGroups
  });
  state.metrics.openAiLatencyMs.groupingVerification = result.latencyMs;
  if (!result.ok) {
    state.metrics.validationFailures += Number(result.validationFailure);
    stageFailure("v4_grouping_verification", result.error, result.details);
  }
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
  const linkedTasks = assembled.tree.commitments.reduce(
    (sum, commitment) => sum + commitment.tasks.length,
    0
  );
  state.metrics.verifiedCommitments = assembled.tree.commitments.length;
  state.metrics.verifiedTasks = linkedTasks + assembled.tree.standalone_tasks.length;
  state.metrics.linkedTasks = linkedTasks;
  state.metrics.unlinkedTasks = assembled.tree.standalone_tasks.length;
  logExecutionStage(state.metrics, "v4_tree_assembled", {
    commitments: assembled.tree.commitments.length,
    linked_tasks: linkedTasks,
    standalone_tasks: assembled.tree.standalone_tasks.length
  });
  return {
    ...state,
    groupDecisions: assembled.groupDecisions,
    workItemDecisions: assembled.workItemDecisions,
    tree: assembled.tree,
    graph: treeToExecutionGraph(assembled.tree)
  };
}

export async function finalizeV4Execution(state: V4ExecutionState): Promise<V4ExecutionState> {
  const decisionByGroupRef = new Map(
    state.groupDecisions.map((decision) => [decision.group_ref, decision])
  );
  const decisionByWorkItemRef = new Map(
    state.workItemDecisions.map((decision) => [decision.work_item_ref, decision])
  );
  const debugTrace: V4ExecutionTrace = {
    version: "execution-tree-v4-hardened-1",
    topic_work_items: state.topicWorkItems,
    merged_work_items: state.mergedWorkItems,
    global_corrections: state.globalCorrections,
    global_additions: state.globalAdditions,
    corrected_work_items: state.workItems,
    eligible_work_items: state.eligibleWorkItems,
    excluded_work_items: state.workItems
      .filter((item) => !isExecutionEligible(item))
      .map((item) => ({
        ...item,
        exclusion_reason: decisionByWorkItemRef.get(item.ref)?.reason ?? null
      })),
    draft_groups: state.draftGroups,
    verified_groups: state.verifiedGroups,
    group_decisions: state.groupDecisions,
    work_item_decisions: state.workItemDecisions,
    commitments_debug: state.tree.commitments.map((commitment) => ({
      ...commitment,
      decision: decisionByGroupRef.get(commitment.ref) ?? null
    })),
    work_items_debug: state.workItems.map((item) => ({
      ...item,
      decision: decisionByWorkItemRef.get(item.ref) ?? null
    })),
    final_tree: state.tree,
    final_graph: state.graph
  };
  return { ...state, debugTrace };
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
