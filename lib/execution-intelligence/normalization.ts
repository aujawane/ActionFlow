import { semanticTokenSimilarity } from "./graph";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";

const OWNERSHIP_PATTERN =
  /\b(?:own(?:s|ed|ing)?|ownership|take(?:s)?\s+(?:over\s+)?ownership|(?:assum(?:e|es|ed|ing)|take(?:s)?\s+on)\s+.+?\s+responsibilit(?:y|ies))\b/i;
const OUTCOME_ACTION_WORDS = new Set([
  "build",
  "complete",
  "create",
  "deliver",
  "develop",
  "fix",
  "implement",
  "launch",
  "prepare",
  "project",
  "review",
  "send",
  "ship",
  "initiative",
  "effort",
  "update"
]);

function normalizedWords(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function uniqueNames(values: Array<string | null | undefined>) {
  const names = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) names.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(names.values());
}

function hasSharedSegment(left: string[], right: string[]) {
  const ids = new Set(left);
  return right.some((id) => ids.has(id));
}

function ownershipContentWords(value: string, owners: string[]) {
  const ignored = new Set([
    "own",
    "owns",
    "owned",
    "owning",
    "ownership",
    "take",
    "takes",
    "over",
    "will",
    "the",
    "for",
    "to",
    "of",
    "that",
    "this",
    "it",
    ...owners.flatMap(normalizedWords)
  ]);
  return new Set(normalizedWords(value).filter((word) => !ignored.has(word)));
}

function coverage(superset: Set<string>, subset: Set<string>) {
  if (subset.size === 0) return 0;
  let shared = 0;
  for (const token of subset) {
    if (superset.has(token)) shared += 1;
  }
  return shared / subset.size;
}

function findBroaderCommitment(
  ownershipCommitment: CommitmentCandidate,
  commitments: CommitmentCandidate[]
) {
  const ownershipNames = uniqueNames([
    ownershipCommitment.owner,
    ...ownershipCommitment.owners
  ]);
  const ownershipWords = ownershipContentWords(
    ownershipCommitment.title,
    ownershipNames
  );

  return commitments
    .filter(
      (candidate) =>
        candidate.client_ref !== ownershipCommitment.client_ref &&
        !OWNERSHIP_PATTERN.test(candidate.title) &&
        !OWNERSHIP_PATTERN.test(candidate.source_quote)
    )
    .map((candidate) => {
      const parentWords = new Set(
        normalizedWords(candidate.title).filter(
          (word) => !OUTCOME_ACTION_WORDS.has(word)
        )
      );
      const titleCoverage = coverage(ownershipWords, parentWords);
      const evidenceRelated =
        hasSharedSegment(
          ownershipCommitment.source_segment_ids,
          candidate.source_segment_ids
        ) ||
        Boolean(
          ownershipCommitment.topic_id &&
            ownershipCommitment.topic_id === candidate.topic_id
        ) ||
        /\b(?:that|this|it)\b/i.test(ownershipCommitment.source_quote);
      return {
        candidate,
        score:
          titleCoverage +
          (evidenceRelated ? 0.2 : 0) -
          parentWords.size * 0.001,
        titleCoverage,
        evidenceRelated
      };
    })
    .filter(
      (item) =>
        item.titleCoverage >= 0.7 &&
        (item.evidenceRelated || item.titleCoverage === 1)
    )
    .sort((left, right) => right.score - left.score)[0]?.candidate;
}

function ownershipObject(title: string) {
  const patterns = [
    /\btake(?:s)?\s+(?:over\s+)?ownership\s+of\s+(.+)$/i,
    /\b(?:assum(?:e|es|ed|ing)|take(?:s)?\s+on)\s+(.+?)\s+responsibilit(?:y|ies)$/i,
    /\bown(?:s|ed|ing)?\s+(?:the\s+)?(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function convertOwnershipTask(task: TaskCandidate): TaskCandidate | null {
  if (!OWNERSHIP_PATTERN.test(task.title)) return task;
  const object = ownershipObject(task.title);
  if (!object) return null;
  const normalized = object.toLowerCase();
  let title: string | null = null;
  if (/\bqa\b/.test(normalized)) {
    title = "Run QA";
  } else if (
    /\b(?:backend|frontend|api|integration|feature|code|implementation)\b/.test(
      normalized
    )
  ) {
    title = `Implement ${object.replace(/^the\s+/i, "the ")}`;
  }
  if (!title) return null;
  return {
    ...task,
    title,
    inferred: true,
    evidence_source: "inferred"
  };
}

function stripOwnerAttribution(title: string, owners: string[]) {
  let result = title;
  for (const owner of [...owners].sort(
    (left, right) => right.length - left.length
  )) {
    const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\s+by\\s+${escaped}\\b`, "gi"), "");
  }
  return result.trim();
}

function mergeGroupTasks(
  graph: ExecutionGraph
): { tasks: TaskCandidate[]; mergedTasks: number } {
  const commitments = new Map(
    graph.commitments.map((commitment) => [commitment.client_ref, commitment])
  );
  const tasks: TaskCandidate[] = [];
  let mergedTasks = 0;

  for (const candidate of graph.tasks) {
    const duplicateIndex = tasks.findIndex((existing) => {
      if (existing.commitment_ref !== candidate.commitment_ref) return false;
      const evidenceMatches =
        hasSharedSegment(
          existing.source_segment_ids,
          candidate.source_segment_ids
        ) ||
        existing.source_quote.trim().toLowerCase() ===
          candidate.source_quote.trim().toLowerCase();
      if (!evidenceMatches) return false;
      const names = uniqueNames([
        existing.owner,
        ...existing.owners,
        candidate.owner,
        ...candidate.owners
      ]);
      const left = stripOwnerAttribution(existing.title, names);
      const right = stripOwnerAttribution(candidate.title, names);
      return semanticTokenSimilarity(left, right) >= 0.8;
    });

    if (duplicateIndex === -1) {
      tasks.push(candidate);
      continue;
    }

    const existing = tasks[duplicateIndex];
    const parent = existing.commitment_ref
      ? commitments.get(existing.commitment_ref)
      : undefined;
    const owners = uniqueNames([
      parent?.owner,
      ...(parent?.owners ?? []),
      existing.owner,
      ...existing.owners,
      candidate.owner,
      ...candidate.owners
    ]);
    const owner =
      owners.find(
        (name) => name.toLowerCase() === parent?.owner?.toLowerCase()
      ) ??
      [...owners].sort((left, right) => left.localeCompare(right))[0] ??
      null;
    tasks[duplicateIndex] = {
      ...existing,
      title: stripOwnerAttribution(existing.title, owners),
      owner,
      owners,
      source_segment_ids: Array.from(
        new Set([...existing.source_segment_ids, ...candidate.source_segment_ids])
      ),
      inferred: existing.inferred && candidate.inferred,
      evidence_source: existing.inferred
        ? candidate.evidence_source
        : existing.evidence_source,
      confidence: Math.max(existing.confidence, candidate.confidence)
    };
    mergedTasks += 1;
  }
  return { tasks, mergedTasks };
}

function eventCondition(commitment: CommitmentCandidate) {
  const sources = [
    commitment.due_date_text,
    commitment.title,
    commitment.description,
    commitment.source_quote
  ].filter((value): value is string => Boolean(value));
  for (const source of sources) {
    const condition =
      source.match(/\b(?:after|once|until|when)\s+[^,.!?]+/i)?.[0]?.trim() ??
      null;
    if (condition) return condition;
  }
  return null;
}

function approvalSubject(condition: string) {
  return (
    condition.match(
      /\b(?:once|when|until)\s+(.+?)\s+approv(?:es|ed)\b/i
    )?.[1]?.trim() ??
    condition.match(/\bafter\s+(.+?)\s+approval\b/i)?.[1]?.trim() ??
    null
  );
}

function normalizeConditions(graph: ExecutionGraph) {
  const tasks = [...graph.tasks];
  let blockerTasksAdded = 0;
  const existingRefs = new Set(tasks.map((task) => task.client_ref));

  for (const commitment of graph.commitments) {
    const condition = eventCondition(commitment);
    if (!condition) continue;
    const subject = approvalSubject(condition);
    const linkedIndexes = tasks.flatMap((task, index) =>
      task.commitment_ref === commitment.client_ref ? [index] : []
    );
    for (const index of linkedIndexes) {
      const task = tasks[index];
      const baseTitle = task.title
        .replace(/\s+\b(?:after|once|until|when|if)\b.*$/i, "")
        .trim();
      const title =
        !subject &&
        !/\b(?:after|once|until|when|if)\b/i.test(task.title)
          ? `${baseTitle || task.title} ${condition}`
          : baseTitle || task.title;
      tasks[index] = {
        ...task,
        title,
        due_date_text: task.due_date_text ?? condition
      };
    }

    if (!subject) continue;
    const blockerTitle = `Get ${subject} approval`;
    const hasBlocker = tasks.some(
      (task) =>
        task.commitment_ref === commitment.client_ref &&
        semanticTokenSimilarity(task.title, blockerTitle) >= 0.6
    );
    if (hasBlocker) continue;

    let clientRef = `${commitment.client_ref}_approval_blocker`;
    let suffix = 1;
    while (existingRefs.has(clientRef)) {
      clientRef = `${commitment.client_ref}_approval_blocker_${suffix}`;
      suffix += 1;
    }
    existingRefs.add(clientRef);
    tasks.push({
      client_ref: clientRef,
      commitment_ref: commitment.client_ref,
      topic_id: commitment.topic_id,
      title: blockerTitle,
      description: `Prerequisite for: ${commitment.title}`,
      owner: null,
      owners: [],
      due_date: null,
      due_date_text: condition,
      priority: commitment.priority,
      confidence: commitment.confidence,
      source_quote: commitment.source_quote,
      source_segment_ids: commitment.source_segment_ids,
      evidence_source: commitment.evidence_source,
      inferred: false,
      task_type: "unassigned_work",
      workspace_type: "follow_up",
      suggested_steps: [],
      execution_classification: commitment.execution_classification ?? "committed",
      consolidated_from_refs: []
    });
    blockerTasksAdded += 1;
  }
  return { tasks, blockerTasksAdded };
}

export function normalizeExecutionGraphQuality(graph: ExecutionGraph): {
  graph: ExecutionGraph;
  removedOwnershipCommitments: number;
  removedOwnershipTasks: number;
  mergedGroupTasks: number;
  blockerTasksAdded: number;
} {
  const commitmentAliases = new Map<string, string>();
  const commitments = graph.commitments.filter((commitment) => {
    if (
      !OWNERSHIP_PATTERN.test(commitment.title) &&
      !OWNERSHIP_PATTERN.test(commitment.source_quote)
    ) {
      return true;
    }
    const broader = findBroaderCommitment(commitment, graph.commitments);
    if (!broader) return true;
    commitmentAliases.set(commitment.client_ref, broader.client_ref);
    return false;
  });

  let removedOwnershipTasks = 0;
  const ownershipNormalizedTasks = graph.tasks.flatMap((task) => {
    const relinked = {
      ...task,
      commitment_ref: task.commitment_ref
        ? commitmentAliases.get(task.commitment_ref) ?? task.commitment_ref
        : null
    };
    const converted = convertOwnershipTask(relinked);
    if (!converted) {
      removedOwnershipTasks += 1;
      return [];
    }
    return [converted];
  });

  const grouped = mergeGroupTasks({
    commitments,
    tasks: ownershipNormalizedTasks
  });
  const conditioned = normalizeConditions({
    commitments,
    tasks: grouped.tasks
  });

  return {
    graph: { commitments, tasks: conditioned.tasks },
    removedOwnershipCommitments: commitmentAliases.size,
    removedOwnershipTasks,
    mergedGroupTasks: grouped.mergedTasks,
    blockerTasksAdded: conditioned.blockerTasksAdded
  };
}
