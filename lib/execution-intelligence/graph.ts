import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";
import type { ExecutionSourceContext } from "./stages";

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string) {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 2));
}

export function semanticTokenSimilarity(left: string, right: string) {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function ownerNames(owner: string | null, owners: string[]) {
  return new Set(
    [owner, ...owners]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeText)
  );
}

function ownersCompatible(
  left: { owner: string | null; owners: string[] },
  right: { owner: string | null; owners: string[] }
) {
  const leftOwners = ownerNames(left.owner, left.owners);
  const rightOwners = ownerNames(right.owner, right.owners);
  if (leftOwners.size === 0 || rightOwners.size === 0) return true;
  return Array.from(leftOwners).some((owner) => rightOwners.has(owner));
}

function sharesSourceSegment(left: string[], right: string[]) {
  const leftIds = new Set(left);
  return right.some((id) => leftIds.has(id));
}

function commitmentDuplicate(
  left: CommitmentCandidate,
  right: CommitmentCandidate
) {
  const similarity = semanticTokenSimilarity(left.title, right.title);
  const sharedEvidence = sharesSourceSegment(
    left.source_segment_ids,
    right.source_segment_ids
  );
  return (
    (similarity >= 0.72 || (sharedEvidence && similarity >= 0.5)) &&
    (ownersCompatible(left, right) || sharedEvidence)
  );
}

function taskDuplicate(left: TaskCandidate, right: TaskCandidate) {
  const similarity = semanticTokenSimilarity(left.title, right.title);
  const sharedEvidence = sharesSourceSegment(
    left.source_segment_ids,
    right.source_segment_ids
  );
  return (
    (similarity >= 0.82 || (sharedEvidence && similarity >= 0.65)) &&
    (!left.commitment_ref ||
      !right.commitment_ref ||
      left.commitment_ref === right.commitment_ref) &&
    (ownersCompatible(left, right) || sharedEvidence)
  );
}

function mergedOwners(
  left: { owner: string | null; owners: string[] },
  right: { owner: string | null; owners: string[] }
) {
  const names = new Map<string, string>();
  for (const value of [
    left.owner,
    ...left.owners,
    right.owner,
    ...right.owners
  ]) {
    const trimmed = value?.trim();
    if (trimmed) names.set(normalizeText(trimmed), trimmed);
  }
  return Array.from(names.values());
}

function mergeCommitment(
  existing: CommitmentCandidate,
  candidate: CommitmentCandidate
): CommitmentCandidate {
  const owners = mergedOwners(existing, candidate);
  return {
    ...existing,
    description: existing.description ?? candidate.description,
    owner: existing.owner ?? candidate.owner ?? owners[0] ?? null,
    owners,
    due_date: existing.due_date ?? candidate.due_date,
    due_date_text: existing.due_date_text ?? candidate.due_date_text,
    confidence: Math.max(existing.confidence, candidate.confidence),
    source_segment_ids: Array.from(
      new Set([...existing.source_segment_ids, ...candidate.source_segment_ids])
    ),
    execution_classification:
      existing.execution_classification ??
      candidate.execution_classification ??
      "committed",
    consolidated_from_refs: Array.from(
      new Set([
        ...(existing.consolidated_from_refs ?? []),
        ...(candidate.consolidated_from_refs ?? []),
        candidate.client_ref
      ])
    )
  };
}

function mergeTask(
  existing: TaskCandidate,
  candidate: TaskCandidate
): TaskCandidate {
  const owners = mergedOwners(existing, candidate);
  return {
    ...existing,
    description: existing.description ?? candidate.description,
    owner: existing.owner ?? candidate.owner ?? owners[0] ?? null,
    owners,
    due_date: existing.due_date ?? candidate.due_date,
    due_date_text: existing.due_date_text ?? candidate.due_date_text,
    confidence: Math.max(existing.confidence, candidate.confidence),
    source_segment_ids: Array.from(
      new Set([...existing.source_segment_ids, ...candidate.source_segment_ids])
    ),
    inferred: existing.inferred && candidate.inferred,
    suggested_steps: Array.from(
      new Set([...existing.suggested_steps, ...candidate.suggested_steps])
    ),
    execution_classification:
      existing.execution_classification ??
      candidate.execution_classification ??
      "committed",
    consolidated_from_refs: Array.from(
      new Set([
        ...(existing.consolidated_from_refs ?? []),
        ...(candidate.consolidated_from_refs ?? []),
        candidate.client_ref
      ])
    )
  };
}

export function mergeAndDeduplicateGraphs(
  ...graphs: ExecutionGraph[]
): { graph: ExecutionGraph; deduplicatedCommitments: number; deduplicatedTasks: number } {
  const commitments: CommitmentCandidate[] = [];
  const commitmentRefAliases = new Map<string, string>();
  let deduplicatedCommitments = 0;

  for (const candidate of graphs.flatMap((graph) => graph.commitments)) {
    const duplicateIndex = commitments.findIndex((existing) =>
      commitmentDuplicate(existing, candidate)
    );
    if (duplicateIndex === -1) {
      commitments.push(candidate);
      continue;
    }
    const existing = commitments[duplicateIndex];
    commitments[duplicateIndex] = mergeCommitment(existing, candidate);
    commitmentRefAliases.set(candidate.client_ref, existing.client_ref);
    commitmentRefAliases.set(existing.client_ref, existing.client_ref);
    deduplicatedCommitments += 1;
  }

  const tasks: TaskCandidate[] = [];
  let deduplicatedTasks = 0;
  for (const rawTask of graphs.flatMap((graph) => graph.tasks)) {
    const task = {
      ...rawTask,
      commitment_ref: rawTask.commitment_ref
        ? commitmentRefAliases.get(rawTask.commitment_ref) ?? rawTask.commitment_ref
        : null
    };
    const duplicateIndex = tasks.findIndex((existing) => taskDuplicate(existing, task));
    if (duplicateIndex === -1) {
      tasks.push(task);
      continue;
    }
    tasks[duplicateIndex] = mergeTask(tasks[duplicateIndex], task);
    deduplicatedTasks += 1;
  }

  const validCommitmentRefs = new Set(commitments.map((item) => item.client_ref));
  return {
    graph: {
      commitments,
      tasks: tasks.map((task) => ({
        ...task,
        commitment_ref:
          task.commitment_ref && validCommitmentRefs.has(task.commitment_ref)
            ? task.commitment_ref
            : null
      }))
    },
    deduplicatedCommitments,
    deduplicatedTasks
  };
}

function isQuoteGrounded(quote: string, source: string) {
  const normalizedQuote = normalizeText(quote);
  const normalizedSource = normalizeText(source);
  return (
    normalizedQuote.length > 0 &&
    (normalizedSource.includes(normalizedQuote) ||
      semanticTokenSimilarity(normalizedQuote, normalizedSource) >= 0.7)
  );
}

export function enforceExecutionGraphGrounding(input: {
  graph: ExecutionGraph;
  source: ExecutionSourceContext;
}) {
  const validTopicIds = new Set(input.source.topics.map((topic) => topic.id));
  const segmentIdMatches = Array.from(
    input.source.transcript.matchAll(
      /\[([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/gi
    ),
    (match) => match[1]
  );
  const validSegmentIds = new Set(segmentIdMatches);
  const summaryCorpus = input.source.topics
    .map((topic) => `${topic.title} ${topic.summary ?? ""}`)
    .join("\n");
  const insightCorpus = input.source.insights.map((insight) => insight.content).join("\n");

  function grounded(
    item: CommitmentCandidate | TaskCandidate
  ) {
    const validIds = item.source_segment_ids.filter((id) => validSegmentIds.has(id));
    const corpus =
      item.evidence_source === "insight"
        ? insightCorpus
        : item.evidence_source === "topic_summary"
          ? summaryCorpus
          : input.source.transcript;
    const quoteGrounded =
      item.evidence_source === "inferred" ||
      isQuoteGrounded(item.source_quote, corpus);
    return {
      item: {
        ...item,
        topic_id:
          item.topic_id && validTopicIds.has(item.topic_id) ? item.topic_id : null,
        source_segment_ids: validIds
      },
      grounded:
        quoteGrounded &&
        (item.evidence_source !== "transcript" || validIds.length > 0)
    };
  }

  const commitments = input.graph.commitments
    .map(grounded)
    .filter((result) => result.grounded)
    .map((result) => result.item as CommitmentCandidate);
  const validRefs = new Set(commitments.map((item) => item.client_ref));
  const tasks = input.graph.tasks
    .map(grounded)
    .filter((result) => result.grounded)
    .map((result) => result.item as TaskCandidate)
    .map((task) => ({
      ...task,
      commitment_ref:
        task.commitment_ref && validRefs.has(task.commitment_ref)
          ? task.commitment_ref
          : null
    }));

  return {
    graph: { commitments, tasks },
    rejectedCommitments: input.graph.commitments.length - commitments.length,
    rejectedTasks: input.graph.tasks.length - tasks.length
  };
}
