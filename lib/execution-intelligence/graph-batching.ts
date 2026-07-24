import {
  splitExecutionSourceIntoChunks,
  type ExecutionSourceChunk
} from "./chunking";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";
import type { ExecutionSourceContext } from "./stages";

export const EXECUTION_GRAPH_BATCH_MAX_ITEMS = 24;

const SEGMENT_ID =
  /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

export type ExecutionGraphBatch = {
  index: number;
  sourceChunkIndex: number;
  startSegment: number;
  endSegment: number;
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
};

function chunkSegmentIds(chunk: ExecutionSourceChunk) {
  return new Set(
    Array.from(chunk.source.transcript.matchAll(SEGMENT_ID), (match) => match[1])
  );
}

function chooseChunkIndex(input: {
  segmentIds: string[];
  topicId: string | null;
  chunks: ExecutionSourceChunk[];
  segmentSets: Set<string>[];
  fallbackIndex: number;
}) {
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < input.chunks.length; index += 1) {
    const segmentMatches = input.segmentIds.filter((id) =>
      input.segmentSets[index].has(id)
    ).length;
    const topicMatches = input.topicId
      ? input.chunks[index].source.topics.some(
          (topic) => topic.id === input.topicId
        )
      : false;
    const score = segmentMatches * 10 + Number(topicMatches);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex === -1
    ? input.fallbackIndex % input.chunks.length
    : bestIndex;
}

function packChunkGraph(input: {
  commitments: CommitmentCandidate[];
  tasks: TaskCandidate[];
  allCommitments: Map<string, CommitmentCandidate>;
}) {
  const units: ExecutionGraph[] = [];
  const taskGroups = new Map<string, TaskCandidate[]>();
  const standaloneTasks: TaskCandidate[] = [];
  for (const task of input.tasks) {
    if (!task.commitment_ref) {
      standaloneTasks.push(task);
      continue;
    }
    const group = taskGroups.get(task.commitment_ref) ?? [];
    group.push(task);
    taskGroups.set(task.commitment_ref, group);
  }

  const includedCommitmentRefs = new Set<string>();
  for (const commitment of input.commitments) {
    const linkedTasks = taskGroups.get(commitment.client_ref) ?? [];
    includedCommitmentRefs.add(commitment.client_ref);
    if (linkedTasks.length === 0) {
      units.push({ commitments: [commitment], tasks: [] });
      continue;
    }
    for (
      let start = 0;
      start < linkedTasks.length;
      start += EXECUTION_GRAPH_BATCH_MAX_ITEMS - 1
    ) {
      units.push({
        commitments: [commitment],
        tasks: linkedTasks.slice(
          start,
          start + EXECUTION_GRAPH_BATCH_MAX_ITEMS - 1
        )
      });
    }
  }

  for (const [commitmentRef, tasks] of taskGroups) {
    if (includedCommitmentRefs.has(commitmentRef)) continue;
    const parent = input.allCommitments.get(commitmentRef);
    for (
      let start = 0;
      start < tasks.length;
      start += parent
        ? EXECUTION_GRAPH_BATCH_MAX_ITEMS - 1
        : EXECUTION_GRAPH_BATCH_MAX_ITEMS
    ) {
      units.push({
        commitments: parent ? [parent] : [],
        tasks: tasks.slice(
          start,
          start +
            (parent
              ? EXECUTION_GRAPH_BATCH_MAX_ITEMS - 1
              : EXECUTION_GRAPH_BATCH_MAX_ITEMS)
        )
      });
    }
  }
  for (
    let start = 0;
    start < standaloneTasks.length;
    start += EXECUTION_GRAPH_BATCH_MAX_ITEMS
  ) {
    units.push({
      commitments: [],
      tasks: standaloneTasks.slice(
        start,
        start + EXECUTION_GRAPH_BATCH_MAX_ITEMS
      )
    });
  }

  const packed: ExecutionGraph[] = [];
  let current: ExecutionGraph = { commitments: [], tasks: [] };
  for (const unit of units) {
    const unitSize = unit.commitments.length + unit.tasks.length;
    const currentSize = current.commitments.length + current.tasks.length;
    if (
      currentSize > 0 &&
      currentSize + unitSize > EXECUTION_GRAPH_BATCH_MAX_ITEMS
    ) {
      packed.push(current);
      current = { commitments: [], tasks: [] };
    }
    const existingRefs = new Set(
      current.commitments.map((commitment) => commitment.client_ref)
    );
    current.commitments.push(
      ...unit.commitments.filter(
        (commitment) => !existingRefs.has(commitment.client_ref)
      )
    );
    current.tasks.push(...unit.tasks);
  }
  if (current.commitments.length > 0 || current.tasks.length > 0) {
    packed.push(current);
  }
  return packed;
}

export function buildExecutionGraphBatches(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
  includeEmptySourceChunks?: boolean;
}): ExecutionGraphBatch[] {
  const chunks = splitExecutionSourceIntoChunks(input.source);
  const segmentSets = chunks.map(chunkSegmentIds);
  const commitmentChunk = new Map<string, number>();
  const commitmentsByChunk = chunks.map(() => [] as CommitmentCandidate[]);
  const tasksByChunk = chunks.map(() => [] as TaskCandidate[]);

  input.graph.commitments.forEach((commitment, index) => {
    const chunkIndex = chooseChunkIndex({
      segmentIds: commitment.source_segment_ids,
      topicId: commitment.topic_id,
      chunks,
      segmentSets,
      fallbackIndex: index
    });
    commitmentChunk.set(commitment.client_ref, chunkIndex);
    commitmentsByChunk[chunkIndex].push(commitment);
  });
  input.graph.tasks.forEach((task, index) => {
    const evidenceChunk = chooseChunkIndex({
      segmentIds: task.source_segment_ids,
      topicId: task.topic_id,
      chunks,
      segmentSets,
      fallbackIndex: index
    });
    const hasEvidence =
      task.source_segment_ids.some((id) =>
        segmentSets[evidenceChunk].has(id)
      ) ||
      Boolean(
        task.topic_id &&
          chunks[evidenceChunk].source.topics.some(
            (topic) => topic.id === task.topic_id
          )
      );
    const chunkIndex =
      !hasEvidence && task.commitment_ref
        ? commitmentChunk.get(task.commitment_ref) ?? evidenceChunk
        : evidenceChunk;
    tasksByChunk[chunkIndex].push(task);
  });

  const allCommitments = new Map(
    input.graph.commitments.map((commitment) => [
      commitment.client_ref,
      commitment
    ])
  );
  const batches: ExecutionGraphBatch[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    const packed = packChunkGraph({
      commitments: commitmentsByChunk[chunkIndex],
      tasks: tasksByChunk[chunkIndex],
      allCommitments
    });
    if (packed.length === 0 && input.includeEmptySourceChunks) {
      packed.push({ commitments: [], tasks: [] });
    }
    for (const graph of packed) {
      batches.push({
        index: batches.length,
        sourceChunkIndex: chunkIndex,
        startSegment: chunk.startSegment,
        endSegment: chunk.endSegment,
        source: chunk.source,
        graph
      });
    }
  });
  return batches;
}

