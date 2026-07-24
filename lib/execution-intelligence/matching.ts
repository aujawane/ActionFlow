import type { MeetingCommitment, MeetingTask } from "@/lib/types";

import { semanticTokenSimilarity } from "./graph";
import type { CommitmentCandidate, ExecutionGraph, TaskCandidate } from "./schemas";

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function segmentOverlap(left: string[], right: string[]) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  return shared / Math.max(a.size, b.size);
}

function candidateScore(input: {
  candidateTitle: string;
  existingTitle: string;
  candidateQuote: string;
  existingQuote: string | null;
  candidateSegmentIds: string[];
  existingSegmentIds: unknown;
}) {
  const title = semanticTokenSimilarity(input.candidateTitle, input.existingTitle);
  const quote = input.existingQuote
    ? semanticTokenSimilarity(input.candidateQuote, input.existingQuote)
    : 0;
  const segments = segmentOverlap(
    input.candidateSegmentIds,
    stringArray(input.existingSegmentIds)
  );
  if (title < 0.45 && segments === 0 && quote < 0.7) return 0;
  return title * 0.55 + quote * 0.15 + segments * 0.3;
}

function greedyMatch<C, E extends { id: string }>(
  candidates: C[],
  existing: E[],
  score: (candidate: C, row: E) => number,
  threshold: number
) {
  const possible = candidates.flatMap((candidate, candidateIndex) =>
    existing.map((row) => ({
      candidateIndex,
      existingId: row.id,
      score: score(candidate, row)
    }))
  );
  possible.sort((left, right) => right.score - left.score);

  const usedCandidates = new Set<number>();
  const usedExisting = new Set<string>();
  const matches = new Map<number, string>();
  for (const item of possible) {
    if (item.score < threshold) break;
    if (
      usedCandidates.has(item.candidateIndex) ||
      usedExisting.has(item.existingId)
    ) {
      continue;
    }
    usedCandidates.add(item.candidateIndex);
    usedExisting.add(item.existingId);
    matches.set(item.candidateIndex, item.existingId);
  }
  return matches;
}

function commitmentScore(
  candidate: CommitmentCandidate,
  existing: MeetingCommitment
) {
  return candidateScore({
    candidateTitle: candidate.title,
    existingTitle: existing.title,
    candidateQuote: candidate.source_quote,
    existingQuote: existing.source_quote,
    candidateSegmentIds: candidate.source_segment_ids,
    existingSegmentIds: existing.source_segment_ids
  });
}

function taskScore(candidate: TaskCandidate, existing: MeetingTask) {
  return candidateScore({
    candidateTitle: candidate.title,
    existingTitle: existing.task,
    candidateQuote: candidate.source_quote,
    existingQuote: existing.source_quote,
    candidateSegmentIds: candidate.source_segment_ids,
    existingSegmentIds: existing.source_segment_ids
  });
}

export function matchExecutionGraphRows(input: {
  graph: ExecutionGraph;
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  return {
    commitments: greedyMatch(
      input.graph.commitments,
      input.commitments,
      commitmentScore,
      0.62
    ),
    tasks: greedyMatch(input.graph.tasks, input.tasks, taskScore, 0.68)
  };
}
