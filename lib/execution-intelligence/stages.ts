import {
  CANDIDATE_GENERATION_PROMPT,
  COMPLETENESS_PROMPT,
  EXECUTION_JUDGE_PROMPT,
  GLOBAL_SYNTHESIS_PROMPT,
  INDEPENDENT_COMMITMENT_EXTRACTION_PROMPT,
  INDEPENDENT_GRAPH_VERIFICATION_PROMPT,
  TASK_COMMITMENT_RELATIONSHIP_PROMPT,
  TOPIC_ACTION_EXTRACTION_PROMPT,
  VERIFICATION_PROMPT
} from "./prompts";
import { getExecutionIntelligenceTimeoutMs } from "@/lib/env";
import {
  EXECUTION_CHUNK_CONCURRENCY,
  splitExecutionSourceIntoChunks
} from "./chunking";
import {
  buildExecutionGraphBatches,
  type ExecutionGraphBatch
} from "./graph-batching";
import { mergeAndDeduplicateGraphs } from "./graph";
import { linkTasksToCommitments } from "./linking";
import { runExecutionGraphModel, type ModelStageResult } from "./model";
import { normalizeExecutionGraphQuality } from "./normalization";
import {
  logExecutionBatchDiagnostics,
  logExecutionCandidateDiagnostics
} from "./observability";
import type { ExecutionGraph } from "./schemas";
import type { ConversationEvent } from "./conversation-event-schemas";
import type { TaskCandidate } from "./schemas";

export type ExecutionSourceContext = {
  meetingId: string;
  project?: {
    id: string;
    name: string;
    goal: string | null;
    memory?: {
      summary: string | null;
      current_scope: unknown;
      future_scope: unknown;
      technical_context: unknown;
      constraints: unknown[];
      decisions: unknown[];
      confirmed_fields: unknown;
    } | null;
  } | null;
  transcript: string;
  transcriptSegmentCount?: number;
  topics: Array<{
    id: string;
    title: string;
    summary: string | null;
    segment_ids: unknown;
  }>;
  insights: Array<{
    topic_id: string | null;
    category: string;
    content: string;
  }>;
  meetingDate: string;
  conversationEvents?: ConversationEvent[];
};

export function buildExecutionSourcePayload(source: ExecutionSourceContext) {
  return {
    meeting_id: source.meetingId,
    meeting_date: source.meetingDate,
    project: source.project ?? null,
    transcript_segment_count: source.transcriptSegmentCount,
    topics: source.topics,
    meeting_summaries: source.insights.filter(
      (insight) => insight.category === "product_summary"
    ),
    insight_next_steps: source.insights.filter(
      (insight) => insight.category === "next_steps"
    ),
    conversation_events: source.conversationEvents ?? [],
    transcript: source.transcript
  };
}

const SEGMENT_LINE = /^\[([0-9a-f-]{36})\]/i;

export function transcriptForSegmentIds(transcript: string, ids: Set<string>) {
  return transcript.split("\n").filter((line) => {
    const id = line.match(SEGMENT_LINE)?.[1];
    return Boolean(id && ids.has(id));
  }).join("\n");
}

export type TopicActionExtraction = {
  topicId: string | null;
  topicTitle: string;
  transcript: string;
  actions: TaskCandidate[];
};

export async function extractTopicActions(
  source: ExecutionSourceContext
): Promise<
  | { ok: true; topics: TopicActionExtraction[]; latencyMs: number }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean }
> {
  const startedAt = Date.now();
  const scopes = source.topics.length > 0
    ? source.topics.map((topic) => {
        const ids = new Set(
          Array.isArray(topic.segment_ids)
            ? topic.segment_ids.filter((id): id is string => typeof id === "string")
            : []
        );
        return {
          topicId: topic.id,
          topicTitle: topic.title,
          topicSummary: topic.summary,
          transcript: transcriptForSegmentIds(source.transcript, ids)
        };
      }).filter((topic) => topic.transcript.trim())
    : [{
        topicId: null,
        topicTitle: "Whole meeting",
        topicSummary: null,
        transcript: source.transcript
      }];
  const results: Array<ModelStageResult | undefined> = new Array(scopes.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= scopes.length) return;
      const scope = scopes[index];
      const result = await runExecutionGraphModel({
        stage: "topic_actions",
        systemPrompt: TOPIC_ACTION_EXTRACTION_PROMPT,
        context: {
          meeting_id: source.meetingId,
          meeting_date: source.meetingDate,
          project: source.project ?? null,
          topic: {
            id: scope.topicId,
            title: scope.topicTitle,
            summary: scope.topicSummary
          },
          conversation_events: source.conversationEvents ?? [],
          transcript: scope.transcript
        }
      });
      results[index] = result;
      if (!result.ok) failed = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, scopes.length) }, () => worker()));
  const failure = results.find((result) => result && !result.ok);
  if (failure && !failure.ok) return { ...failure, latencyMs: Date.now() - startedAt };
  if (results.some((result) => !result)) {
    return {
      ok: false,
      error: "Topic action extraction stopped before every topic completed.",
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    };
  }
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    topics: scopes.map((scope, topicIndex) => {
      const result = results[topicIndex]!;
      if (!result.ok) throw new Error("Unexpected failed topic action result.");
      return {
        topicId: scope.topicId,
        topicTitle: scope.topicTitle,
        transcript: scope.transcript,
        actions: result.graph.tasks.map((task, actionIndex) => ({
          ...task,
          client_ref: `action_t${topicIndex + 1}_a${actionIndex + 1}`,
          topic_id: scope.topicId,
          commitment_ref: null
        }))
      };
    })
  };
}

export async function extractIndependentCommitments(input: {
  source: ExecutionSourceContext;
  actions: TaskCandidate[];
}): Promise<ModelStageResult> {
  const result = await runExecutionGraphModel({
    stage: "commitment_extraction",
    systemPrompt: INDEPENDENT_COMMITMENT_EXTRACTION_PROMPT,
    timeoutMs: Math.max(getExecutionIntelligenceTimeoutMs(), 90_000),
    context: {
      ...buildExecutionSourcePayload(input.source),
      participants: participantMap(input.source.transcript),
      extracted_actions: input.actions
    }
  });
  if (!result.ok) return result;
  return {
    ...result,
    graph: {
      tasks: [],
      commitments: result.graph.commitments.map((commitment, index) => ({
        ...commitment,
        client_ref: `commitment_c${index + 1}`,
        execution_classification: "committed"
      }))
    }
  };
}

export function evaluateTaskCommitmentRelationships(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "relationship_evaluation",
    systemPrompt: TASK_COMMITMENT_RELATIONSHIP_PROMPT,
    context: {
      meeting_id: input.source.meetingId,
      transcript: input.source.transcript,
      proposed_graph: input.graph
    }
  });
}

export function verifyIndependentExecutionGraph(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "graph_verification",
    systemPrompt: INDEPENDENT_GRAPH_VERIFICATION_PROMPT,
    context: {
      ...buildExecutionSourcePayload(input.source),
      proposed_graph: input.graph
    }
  });
}

export function generateExecutionCandidates(
  source: ExecutionSourceContext
): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "candidates",
    systemPrompt: CANDIDATE_GENERATION_PROMPT,
    context: buildExecutionSourcePayload(source)
  });
}

function namespaceChunkGraph(graph: ExecutionGraph, chunkIndex: number) {
  const prefix = `chunk_${chunkIndex + 1}_`;
  const commitmentRefs = new Map(
    graph.commitments.map((commitment) => [
      commitment.client_ref,
      `${prefix}${commitment.client_ref}`
    ])
  );
  return {
    commitments: graph.commitments.map((commitment) => ({
      ...commitment,
      client_ref: commitmentRefs.get(commitment.client_ref)!
    })),
    tasks: graph.tasks.map((task) => ({
      ...task,
      client_ref: `${prefix}${task.client_ref}`,
      commitment_ref: task.commitment_ref
        ? commitmentRefs.get(task.commitment_ref) ?? null
        : null
    }))
  };
}

export async function generateChunkedExecutionCandidates(
  source: ExecutionSourceContext,
  options: {
    generateChunk?: typeof generateExecutionCandidates;
    concurrency?: number;
  } = {}
): Promise<ModelStageResult> {
  const chunks = splitExecutionSourceIntoChunks(source);
  const generateChunk =
    options.generateChunk ?? generateExecutionCandidates;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? EXECUTION_CHUNK_CONCURRENCY, chunks.length)
  );
  const startedAt = Date.now();
  const results: Array<ModelStageResult | undefined> = new Array(chunks.length);
  let nextIndex = 0;
  let failed = false;

  logExecutionCandidateDiagnostics({
    event: "chunks_planned",
    chunk_count: chunks.length,
    concurrency,
    chunks: chunks.map((chunk) => ({
      chunk: chunk.index + 1,
      start_segment: chunk.startSegment,
      end_segment: chunk.endSegment,
      segment_count: chunk.source.transcriptSegmentCount
    }))
  });

  async function worker() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const chunkStartedAt = Date.now();
      const result = await generateChunk(chunk.source);
      results[index] = result;
      logExecutionCandidateDiagnostics({
        event: "chunk_complete",
        chunk: index + 1,
        start_segment: chunk.startSegment,
        end_segment: chunk.endSegment,
        segment_count: chunk.source.transcriptSegmentCount,
        elapsed_ms: Date.now() - chunkStartedAt,
        success: result.ok,
        commitments: result.ok ? result.graph.commitments.length : undefined,
        tasks: result.ok ? result.graph.tasks.length : undefined,
        error: result.ok ? undefined : result.error
      });
      if (!result.ok) failed = true;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failedIndex = results.findIndex((result) => result && !result.ok);
  if (failedIndex !== -1) {
    const failure = results[failedIndex];
    if (!failure || failure.ok) {
      throw new Error("Chunk failure state was inconsistent.");
    }
    return {
      ...failure,
      error: `Candidate chunk ${failedIndex + 1} failed: ${failure.error}`,
      latencyMs: Date.now() - startedAt
    };
  }
  if (results.some((result) => !result)) {
    return {
      ok: false,
      error: "Candidate chunk generation stopped before all chunks completed.",
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    };
  }

  const successful = results.filter(
    (result): result is Extract<ModelStageResult, { ok: true }> =>
      Boolean(result?.ok)
  );
  const merged = mergeAndDeduplicateGraphs(
    ...successful.map((result, index) =>
      namespaceChunkGraph(result.graph, index)
    )
  );
  const normalized = normalizeExecutionGraphQuality(merged.graph);
  const mergedCommitments = normalized.graph.commitments.length;
  const mergedTasks = normalized.graph.tasks.length;
  logExecutionCandidateDiagnostics({
    event: "chunks_merged",
    chunk_count: chunks.length,
    elapsed_ms: Date.now() - startedAt,
    commitments: mergedCommitments,
    tasks: mergedTasks,
    deduplicated_commitments:
      merged.deduplicatedCommitments +
      normalized.removedOwnershipCommitments,
    deduplicated_tasks:
      merged.deduplicatedTasks + normalized.mergedGroupTasks,
    removed_ownership_tasks: normalized.removedOwnershipTasks
  });

  return {
    ok: true,
    graph: normalized.graph,
    latencyMs: Date.now() - startedAt,
    salvagedItems: successful.reduce(
      (total, result) => total + (result.salvagedItems ?? 0),
      0
    )
  };
}

export function verifyExecutionGraph(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "verification",
    systemPrompt: VERIFICATION_PROMPT,
    context: {
      ...buildExecutionSourcePayload(input.source),
      candidate_graph: input.graph
    }
  });
}

export function participantMap(transcript: string) {
  const counts = new Map<string, number>();
  for (const line of transcript.split("\n")) {
    const match = line.match(
      /^\s*(?:\[[^\]]+\]\s*)*([^:\[\]]{1,80}):\s+\S/
    );
    if (!match) continue;
    const name = match[1].trim();
    if (!name || /^(unknown|speaker(?:\s+\d+)?)$/i.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, segment_count]) => ({
    name,
    segment_count
  })).sort((left, right) => right.segment_count - left.segment_count);
}

export function synthesizeExecutionGraph(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  const summaries = input.source.insights.filter(
    (insight) => insight.category === "product_summary"
  );
  return runExecutionGraphModel({
    stage: "synthesis",
    systemPrompt: GLOBAL_SYNTHESIS_PROMPT,
    timeoutMs: Math.max(getExecutionIntelligenceTimeoutMs(), 90_000),
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      meeting_objective:
        summaries.map((summary) => summary.content).filter(Boolean).join("\n") ||
        input.source.project?.goal ||
        null,
      topic_summaries: input.source.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        summary: topic.summary
      })),
      requirements: input.source.insights
        .filter((insight) =>
          ["requirements", "product_requirements"].includes(insight.category)
        )
        .map((insight) => insight.content),
      decisions: input.source.insights
        .filter((insight) => insight.category === "decisions")
        .map((insight) => insight.content),
      participant_map: participantMap(input.source.transcript),
      conversation_events: input.source.conversationEvents ?? [],
      candidate_graph: input.graph
    }
  });
}

export function judgeExecutionGraph(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "judge",
    systemPrompt: EXECUTION_JUDGE_PROMPT,
    timeoutMs: Math.max(getExecutionIntelligenceTimeoutMs(), 90_000),
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      conversation_events: input.source.conversationEvents ?? [],
      proposed_hierarchy: input.graph
    }
  });
}

type SuccessfulModelStageResult = Extract<ModelStageResult, { ok: true }>;

async function runExecutionGraphBatches(input: {
  stage: "verification" | "completeness";
  batches: ExecutionGraphBatch[];
  runBatch: (batch: ExecutionGraphBatch) => Promise<ModelStageResult>;
  namespaceOutputs: boolean;
  concurrency?: number;
}): Promise<ModelStageResult> {
  if (input.batches.length === 0) {
    return {
      ok: true,
      graph: { commitments: [], tasks: [] },
      latencyMs: 0,
      salvagedItems: 0
    };
  }
  const startedAt = Date.now();
  const concurrency = Math.min(
    Math.max(1, input.concurrency ?? EXECUTION_CHUNK_CONCURRENCY),
    input.batches.length
  );
  const results: Array<ModelStageResult | undefined> = new Array(
    input.batches.length
  );
  let nextIndex = 0;
  let failed = false;

  logExecutionBatchDiagnostics(input.stage, {
    event: "batches_planned",
    batch_count: input.batches.length,
    concurrency,
    batches: input.batches.map((batch) => ({
      batch: batch.index + 1,
      source_chunk: batch.sourceChunkIndex + 1,
      start_segment: batch.startSegment,
      end_segment: batch.endSegment,
      commitments: batch.graph.commitments.length,
      tasks: batch.graph.tasks.length
    }))
  });

  async function worker() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.batches.length) return;
      const batch = input.batches[index];
      const batchStartedAt = Date.now();
      const result = await input.runBatch(batch);
      results[index] = result;
      logExecutionBatchDiagnostics(input.stage, {
        event: "batch_complete",
        batch: index + 1,
        source_chunk: batch.sourceChunkIndex + 1,
        start_segment: batch.startSegment,
        end_segment: batch.endSegment,
        elapsed_ms: Date.now() - batchStartedAt,
        success: result.ok,
        input_commitments: batch.graph.commitments.length,
        input_tasks: batch.graph.tasks.length,
        output_commitments: result.ok
          ? result.graph.commitments.length
          : undefined,
        output_tasks: result.ok ? result.graph.tasks.length : undefined,
        error: result.ok ? undefined : result.error
      });
      if (!result.ok) failed = true;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failedIndex = results.findIndex((result) => result && !result.ok);
  if (failedIndex !== -1) {
    const failure = results[failedIndex];
    if (!failure || failure.ok) {
      throw new Error("Execution batch failure state was inconsistent.");
    }
    return {
      ...failure,
      error: `${input.stage} batch ${failedIndex + 1} failed: ${failure.error}`,
      latencyMs: Date.now() - startedAt
    };
  }
  if (results.some((result) => !result)) {
    return {
      ok: false,
      error: `${input.stage} stopped before all batches completed.`,
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    };
  }

  const successful = results.filter(
    (result): result is SuccessfulModelStageResult => Boolean(result?.ok)
  );
  const merged = mergeAndDeduplicateGraphs(
    ...successful.map((result, index) =>
      input.namespaceOutputs
        ? namespaceChunkGraph(result.graph, index)
        : result.graph
    )
  );
  const graph = linkTasksToCommitments(merged.graph);
  logExecutionBatchDiagnostics(input.stage, {
    event: "batches_merged",
    batch_count: input.batches.length,
    elapsed_ms: Date.now() - startedAt,
    commitments: graph.commitments.length,
    tasks: graph.tasks.length,
    deduplicated_commitments: merged.deduplicatedCommitments,
    deduplicated_tasks: merged.deduplicatedTasks
  });
  return {
    ok: true,
    graph,
    latencyMs: Date.now() - startedAt,
    salvagedItems: successful.reduce(
      (total, result) => total + (result.salvagedItems ?? 0),
      0
    )
  };
}

export function verifyExecutionGraphInBatches(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
  verifyBatch?: (batch: ExecutionGraphBatch) => Promise<ModelStageResult>;
  concurrency?: number;
}): Promise<ModelStageResult> {
  const batches = buildExecutionGraphBatches({
    source: input.source,
    graph: input.graph
  });
  return runExecutionGraphBatches({
    stage: "verification",
    batches,
    namespaceOutputs: false,
    concurrency: input.concurrency,
    runBatch:
      input.verifyBatch ??
      ((batch) =>
        verifyExecutionGraph({ source: batch.source, graph: batch.graph }))
  });
}

export function findMissingExecutionWork(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "completeness",
    systemPrompt: COMPLETENESS_PROMPT,
    context: {
      ...buildExecutionSourcePayload(input.source),
      verified_graph: input.graph
    }
  });
}

export function findMissingExecutionWorkInBatches(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
  findMissingBatch?: (
    batch: ExecutionGraphBatch
  ) => Promise<ModelStageResult>;
  concurrency?: number;
}): Promise<ModelStageResult> {
  const batches = buildExecutionGraphBatches({
    source: input.source,
    graph: input.graph,
    includeEmptySourceChunks: true
  });
  return runExecutionGraphBatches({
    stage: "completeness",
    batches,
    namespaceOutputs: true,
    concurrency: input.concurrency,
    runBatch:
      input.findMissingBatch ??
      ((batch) =>
        findMissingExecutionWork({
          source: batch.source,
          graph: batch.graph
        }))
  });
}
