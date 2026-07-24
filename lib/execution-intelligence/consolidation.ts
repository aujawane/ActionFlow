import { semanticTokenSimilarity } from "./graph";
import type {
  CommitmentCandidate,
  ExecutionClassification,
  ExecutionGraph,
  TaskCandidate
} from "./schemas";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "initial",
  "focusing",
  "focus",
  "inclusion",
  "straightforward",
  "clean",
  "layout"
]);

const GENERIC_INFERRED_PATTERNS = [
  /\bresearch\b/i,
  /\bplan(?:ning)?\b/i,
  /\bdesign\b/i,
  /\bqa\b/i,
  /\btest(?:ing)?\b/i,
  /\bapprov(?:e|al)\b/i,
  /\bdeploy(?:ment)?\b/i,
  /\bdocument(?:ation)?\b/i,
  /\bstakeholder\b/i,
  /\breview\b/i
];

const DISTINCT_PHASE_MARKERS = [
  "wireframe",
  "static",
  "ecommerce",
  "e-commerce",
  "backend",
  "frontend",
  "auth",
  "login",
  "signup",
  "integrate",
  "integration",
  "test",
  "deploy",
  "content",
  "copy",
  "faq",
  "chatbot"
];

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ACTION_SYNONYMS: Record<string, string> = {
  create: "make",
  creating: "make",
  design: "make",
  designing: "make",
  draft: "make",
  drafting: "make",
  build: "make",
  building: "make",
  develop: "make",
  developing: "make",
  implement: "make",
  implementing: "make",
  write: "make",
  writing: "make",
  prepare: "make",
  preparing: "make"
};

function contentTokens(value: string) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map((token) => ACTION_SYNONYMS[token] ?? token);
}

function actionObjectKey(value: string) {
  return contentTokens(value).join(" ");
}

function uniqueNames(values: Array<string | null | undefined>) {
  const names = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) names.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(names.values());
}

function ownersCompatible(
  left: { owner: string | null; owners: string[] },
  right: { owner: string | null; owners: string[] }
) {
  const leftOwners = new Set(
    uniqueNames([left.owner, ...left.owners]).map((name) => name.toLowerCase())
  );
  const rightOwners = new Set(
    uniqueNames([right.owner, ...right.owners]).map((name) => name.toLowerCase())
  );
  if (leftOwners.size === 0 || rightOwners.size === 0) return true;
  return Array.from(leftOwners).some((owner) => rightOwners.has(owner));
}

function sharesSourceSegment(left: string[], right: string[]) {
  const ids = new Set(left);
  return right.some((id) => ids.has(id));
}

function quoteSimilarity(left: string, right: string) {
  return semanticTokenSimilarity(left, right);
}

function strongerEvidence(
  left: CommitmentCandidate | TaskCandidate,
  right: CommitmentCandidate | TaskCandidate
) {
  const rank = (item: CommitmentCandidate | TaskCandidate) => {
    let score = item.confidence;
    if ("inferred" in item && item.inferred) score -= 0.2;
    if (item.evidence_source === "transcript") score += 0.05;
    score += Math.min(0.1, item.source_segment_ids.length * 0.02);
    score += Math.min(0.05, item.source_quote.length / 500);
    return score;
  };
  return rank(left) >= rank(right) ? left : right;
}

function classificationRank(value: ExecutionClassification) {
  switch (value) {
    case "committed":
      return 4;
    case "proposed":
      return 3;
    case "requirement":
      return 2;
    case "future_consideration":
      return 1;
  }
}

function preferClassification(
  left: ExecutionClassification | undefined,
  right: ExecutionClassification | undefined
): ExecutionClassification {
  return classificationRank(left ?? "committed") >=
    classificationRank(right ?? "committed")
    ? left ?? "committed"
    : right ?? "committed";
}

function withDefaults(graph: ExecutionGraph): ExecutionGraph {
  return {
    commitments: graph.commitments.map((commitment) => ({
      ...commitment,
      execution_classification: commitment.execution_classification ?? "committed",
      consolidated_from_refs: commitment.consolidated_from_refs ?? []
    })),
    tasks: graph.tasks.map((task) => ({
      ...task,
      execution_classification: task.execution_classification ?? "committed",
      consolidated_from_refs: task.consolidated_from_refs ?? []
    }))
  };
}

function commitmentNearDuplicate(
  left: CommitmentCandidate,
  right: CommitmentCandidate
) {
  const titleSimilarity = semanticTokenSimilarity(left.title, right.title);
  const objectSimilarity = semanticTokenSimilarity(
    actionObjectKey(left.title),
    actionObjectKey(right.title)
  );
  const sharedEvidence = sharesSourceSegment(
    left.source_segment_ids,
    right.source_segment_ids
  );
  const quoteSim = quoteSimilarity(left.source_quote, right.source_quote);
  return (
    ((titleSimilarity >= 0.68 || objectSimilarity >= 0.75) &&
      (ownersCompatible(left, right) || sharedEvidence || quoteSim >= 0.55)) ||
    (sharedEvidence && titleSimilarity >= 0.5) ||
    (objectSimilarity >= 0.85 && left.topic_id && left.topic_id === right.topic_id)
  );
}

function hasDistinctPhaseConflict(left: string, right: string) {
  const leftMarkers = DISTINCT_PHASE_MARKERS.filter((marker) =>
    normalizeText(left).includes(marker)
  );
  const rightMarkers = DISTINCT_PHASE_MARKERS.filter((marker) =>
    normalizeText(right).includes(marker)
  );
  if (leftMarkers.length === 0 || rightMarkers.length === 0) return false;
  const shared = leftMarkers.filter((marker) => rightMarkers.includes(marker));
  // Same phase markers can merge; disjoint phase markers should stay separate.
  return shared.length === 0;
}

function taskNearDuplicate(left: TaskCandidate, right: TaskCandidate) {
  if (
    left.commitment_ref &&
    right.commitment_ref &&
    left.commitment_ref !== right.commitment_ref
  ) {
    return false;
  }
  if (hasDistinctPhaseConflict(left.title, right.title)) {
    return false;
  }
  const titleSimilarity = semanticTokenSimilarity(left.title, right.title);
  const objectSimilarity = semanticTokenSimilarity(
    actionObjectKey(left.title),
    actionObjectKey(right.title)
  );
  const sharedEvidence = sharesSourceSegment(
    left.source_segment_ids,
    right.source_segment_ids
  );
  const quoteSim = quoteSimilarity(left.source_quote, right.source_quote);
  return (
    titleSimilarity >= 0.78 ||
    objectSimilarity >= 0.78 ||
    (sharedEvidence && titleSimilarity >= 0.6) ||
    (quoteSim >= 0.7 && objectSimilarity >= 0.65) ||
    (objectSimilarity >= 0.72 &&
      (!left.commitment_ref || left.commitment_ref === right.commitment_ref))
  );
}

function mergeCommitment(
  existing: CommitmentCandidate,
  candidate: CommitmentCandidate
): CommitmentCandidate {
  const preferred = strongerEvidence(existing, candidate) as CommitmentCandidate;
  const other = preferred.client_ref === existing.client_ref ? candidate : existing;
  const owners = uniqueNames([
    preferred.owner,
    ...preferred.owners,
    other.owner,
    ...other.owners
  ]);
  const explicitOwner =
    (!("inferred" in preferred) && preferred.owner) ||
    preferred.owner ||
    other.owner ||
    owners[0] ||
    null;
  return {
    ...preferred,
    description: preferred.description ?? other.description,
    owner: explicitOwner,
    owners,
    due_date: preferred.due_date ?? other.due_date,
    due_date_text: preferred.due_date_text ?? other.due_date_text,
    confidence: Math.max(preferred.confidence, other.confidence),
    source_segment_ids: Array.from(
      new Set([...preferred.source_segment_ids, ...other.source_segment_ids])
    ),
    source_quote:
      preferred.source_quote.length >= other.source_quote.length
        ? preferred.source_quote
        : other.source_quote,
    execution_classification: preferClassification(
      preferred.execution_classification,
      other.execution_classification
    ),
    consolidated_from_refs: Array.from(
      new Set([
        ...(preferred.consolidated_from_refs ?? []),
        ...(other.consolidated_from_refs ?? []),
        other.client_ref
      ])
    )
  };
}

function mergeTask(existing: TaskCandidate, candidate: TaskCandidate): TaskCandidate {
  const preferred = (
    existing.inferred === candidate.inferred
      ? strongerEvidence(existing, candidate)
      : existing.inferred
        ? candidate
        : existing
  ) as TaskCandidate;
  const other = preferred.client_ref === existing.client_ref ? candidate : existing;
  const owners = uniqueNames([
    preferred.owner,
    ...preferred.owners,
    other.owner,
    ...other.owners
  ]);
  return {
    ...preferred,
    description: preferred.description ?? other.description,
    owner: preferred.owner ?? other.owner ?? owners[0] ?? null,
    owners,
    due_date: preferred.due_date ?? other.due_date,
    due_date_text: preferred.due_date_text ?? other.due_date_text,
    confidence: Math.max(preferred.confidence, other.confidence),
    source_segment_ids: Array.from(
      new Set([...preferred.source_segment_ids, ...other.source_segment_ids])
    ),
    source_quote:
      preferred.source_quote.length >= other.source_quote.length
        ? preferred.source_quote
        : other.source_quote,
    inferred: preferred.inferred && other.inferred,
    evidence_source: preferred.inferred ? other.evidence_source : preferred.evidence_source,
    suggested_steps: Array.from(
      new Set([...preferred.suggested_steps, ...other.suggested_steps])
    ),
    execution_classification: preferClassification(
      preferred.execution_classification,
      other.execution_classification
    ),
    consolidated_from_refs: Array.from(
      new Set([
        ...(preferred.consolidated_from_refs ?? []),
        ...(other.consolidated_from_refs ?? []),
        other.client_ref
      ])
    )
  };
}

function isRestatementOfCommitment(
  task: TaskCandidate,
  commitment: CommitmentCandidate
) {
  const titleSimilarity = semanticTokenSimilarity(task.title, commitment.title);
  const objectSimilarity = semanticTokenSimilarity(
    actionObjectKey(task.title),
    actionObjectKey(commitment.title)
  );
  const taskTokens = new Set(contentTokens(task.title));
  const commitmentTokens = new Set(contentTokens(commitment.title));
  let shared = 0;
  for (const token of taskTokens) {
    if (commitmentTokens.has(token)) shared += 1;
  }
  const coverage =
    taskTokens.size === 0 ? 0 : shared / Math.max(taskTokens.size, commitmentTokens.size);
  return (
    titleSimilarity >= 0.86 ||
    objectSimilarity >= 0.9 ||
    (coverage >= 0.85 && titleSimilarity >= 0.7)
  );
}

function isUnsupportedGenericInferred(task: TaskCandidate) {
  if (!task.inferred) return false;
  return GENERIC_INFERRED_PATTERNS.some((pattern) => pattern.test(task.title));
}

export function consolidateExecutionGraph(graph: ExecutionGraph): {
  graph: ExecutionGraph;
  mergedCommitments: number;
  mergedTasks: number;
  rejectedRestatements: number;
  removedGenericInferred: number;
} {
  const normalized = withDefaults(graph);

  const commitments: CommitmentCandidate[] = [];
  const commitmentAliases = new Map<string, string>();
  let mergedCommitments = 0;

  for (const candidate of normalized.commitments) {
    const duplicateIndex = commitments.findIndex((existing) =>
      commitmentNearDuplicate(existing, candidate)
    );
    if (duplicateIndex === -1) {
      commitments.push(candidate);
      continue;
    }
    const surviving = mergeCommitment(commitments[duplicateIndex], candidate);
    commitmentAliases.set(candidate.client_ref, surviving.client_ref);
    commitmentAliases.set(commitments[duplicateIndex].client_ref, surviving.client_ref);
    commitments[duplicateIndex] = surviving;
    mergedCommitments += 1;
  }

  const commitmentByRef = new Map(
    commitments.map((commitment) => [commitment.client_ref, commitment])
  );

  let rejectedRestatements = 0;
  let removedGenericInferred = 0;
  const relinkedTasks = normalized.tasks.flatMap((task) => {
    const commitmentRef = task.commitment_ref
      ? commitmentAliases.get(task.commitment_ref) ?? task.commitment_ref
      : null;
    const linked = {
      ...task,
      commitment_ref:
        commitmentRef && commitmentByRef.has(commitmentRef) ? commitmentRef : null
    };

    if (linked.commitment_ref) {
      const parent = commitmentByRef.get(linked.commitment_ref);
      if (parent && isRestatementOfCommitment(linked, parent)) {
        rejectedRestatements += 1;
        return [];
      }
    }

    if (isUnsupportedGenericInferred(linked)) {
      removedGenericInferred += 1;
      return [];
    }

    return [linked];
  });

  const tasks: TaskCandidate[] = [];
  let mergedTasks = 0;
  for (const candidate of relinkedTasks) {
    const duplicateIndex = tasks.findIndex((existing) =>
      taskNearDuplicate(existing, candidate)
    );
    if (duplicateIndex === -1) {
      tasks.push(candidate);
      continue;
    }
    tasks[duplicateIndex] = mergeTask(tasks[duplicateIndex], candidate);
    mergedTasks += 1;
  }

  const classifiedTasks = tasks.map((task) => {
    if (!task.commitment_ref) return task;
    const parent = commitmentByRef.get(task.commitment_ref);
    if (!parent || parent.execution_classification === "committed") return task;
    if (task.execution_classification === "committed") {
      return {
        ...task,
        execution_classification: parent.execution_classification
      };
    }
    return task;
  });

  return {
    graph: { commitments, tasks: classifiedTasks },
    mergedCommitments,
    mergedTasks,
    rejectedRestatements,
    removedGenericInferred
  };
}

export function isCommittedClassification(
  value: ExecutionClassification | null | undefined
) {
  return !value || value === "committed";
}
