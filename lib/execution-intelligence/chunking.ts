import type { ExecutionSourceContext } from "./stages";

export const EXECUTION_CHUNK_TARGET_SEGMENTS = 40;
export const EXECUTION_CHUNK_MIN_SEGMENTS = 40;
export const EXECUTION_CHUNK_MAX_SEGMENTS = 50;
export const EXECUTION_CHUNK_OVERLAP_SEGMENTS = 5;
export const EXECUTION_CHUNK_CONCURRENCY = 2;

const SEGMENT_PREFIX =
  /^\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

export type ExecutionSourceChunk = {
  index: number;
  startSegment: number;
  endSegment: number;
  source: ExecutionSourceContext;
};

function transcriptLines(transcript: string) {
  return transcript
    .split("\n")
    .map((line) => {
      const id = line.match(SEGMENT_PREFIX)?.[1] ?? null;
      return { id, line };
    })
    .filter(
      (item): item is { id: string; line: string } =>
        Boolean(item.id && item.line.trim())
    );
}

function topicBoundaryIndexes(
  source: ExecutionSourceContext,
  segmentIndexById: Map<string, number>
) {
  const boundaries = new Set<number>();
  for (const topic of source.topics) {
    if (!Array.isArray(topic.segment_ids)) continue;
    const indexes = topic.segment_ids.flatMap((value) => {
      if (typeof value !== "string") return [];
      const index = segmentIndexById.get(value);
      return index === undefined ? [] : [index];
    });
    if (indexes.length > 0) boundaries.add(Math.max(...indexes) + 1);
  }
  return Array.from(boundaries).sort((left, right) => left - right);
}

function chooseChunkEnd(input: {
  start: number;
  total: number;
  boundaries: number[];
}) {
  const target = Math.min(
    input.start + EXECUTION_CHUNK_TARGET_SEGMENTS,
    input.total
  );
  if (target === input.total) return input.total;
  const minimum = Math.min(
    input.start + EXECUTION_CHUNK_MIN_SEGMENTS,
    input.total
  );
  const maximum = Math.min(
    input.start + EXECUTION_CHUNK_MAX_SEGMENTS,
    input.total
  );
  const preferred = input.boundaries
    .filter((boundary) => boundary >= minimum && boundary <= maximum)
    .sort(
      (left, right) =>
        Math.abs(left - target) - Math.abs(right - target) || left - right
    )[0];
  return preferred ?? target;
}

export function splitExecutionSourceIntoChunks(
  source: ExecutionSourceContext
): ExecutionSourceChunk[] {
  const segments = transcriptLines(source.transcript);
  if (segments.length === 0) {
    return [
      {
        index: 0,
        startSegment: 1,
        endSegment: source.transcriptSegmentCount ?? 0,
        source
      }
    ];
  }
  if (segments.length <= EXECUTION_CHUNK_MAX_SEGMENTS) {
    return [
      {
        index: 0,
        startSegment: 1,
        endSegment: segments.length,
        source: { ...source, transcriptSegmentCount: segments.length }
      }
    ];
  }

  const segmentIndexById = new Map(
    segments.map((segment, index) => [segment.id, index])
  );
  const boundaries = topicBoundaryIndexes(source, segmentIndexById);
  const chunks: ExecutionSourceChunk[] = [];
  let start = 0;
  while (start < segments.length) {
    const end = chooseChunkEnd({
      start,
      total: segments.length,
      boundaries
    });
    const selected = segments.slice(start, end);
    const selectedIds = new Set(selected.map((segment) => segment.id));
    const topics = source.topics.filter((topic) => {
      if (!Array.isArray(topic.segment_ids)) return true;
      const ids = topic.segment_ids.filter(
        (value): value is string => typeof value === "string"
      );
      return ids.length === 0 || ids.some((value) => selectedIds.has(value));
    });
    const topicIds = new Set(topics.map((topic) => topic.id));
    const insights = source.insights.filter(
      (insight) =>
        insight.topic_id === null || topicIds.has(insight.topic_id ?? "")
    );
    chunks.push({
      index: chunks.length,
      startSegment: start + 1,
      endSegment: end,
      source: {
        ...source,
        transcript: selected.map((segment) => segment.line).join("\n"),
        transcriptSegmentCount: selected.length,
        topics,
        insights
      }
    });
    if (end >= segments.length) break;
    start = Math.max(start + 1, end - EXECUTION_CHUNK_OVERLAP_SEGMENTS);
  }
  return chunks;
}

