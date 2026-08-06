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

const MILESTONE_DOMAINS: Record<string, string[]> = {
  scope: [
    "scope",
    "architecture",
    "requirement",
    "technology",
    "stack",
    "wireframe",
    "specification"
  ],
  brand_content: [
    "brand",
    "content",
    "copy",
    "story",
    "image",
    "photo",
    "packaging",
    "faq"
  ],
  product_concept: [
    "product concept",
    "protein bar",
    "ingredient",
    "digestive",
    "consumer validation",
    "target consumer",
    "energy blend",
    "maca",
    "positioning"
  ],
  mvp: [
    "mvp",
    "first version",
    "frontend",
    "backend",
    "authentication",
    "login",
    "signup",
    "static site"
  ],
  ecommerce: [
    "ecommerce",
    "e-commerce",
    "commerce",
    "subscription",
    "checkout",
    "payment",
    "ordering",
    "catalog"
  ],
  launch: ["launch", "deploy", "deployment", "domain", "hosting", "production"],
  coordination: [
    "coordinate",
    "coordination",
    "communicate",
    "stakeholder",
    "schedule",
    "follow up",
    "follow-up"
  ]
};

const BROAD_OUTCOME_TERMS = [
  "deliver",
  "launch",
  "prepare",
  "finalize",
  "complete",
  "establish",
  "enable",
  "capabilities",
  "mvp",
  "first version",
  "scope",
  "architecture"
];

const NARROW_ACTION_TERMS = [
  "research",
  "evaluate",
  "choose",
  "confirm",
  "configure",
  "clarify",
  "define",
  "document",
  "draft",
  "write",
  "request",
  "send",
  "share",
  "email",
  "contact",
  "follow up",
  "select",
  "outline",
  "link",
  "plan",
  "integrate",
  "implement",
  "test",
  "validate",
  "review",
  "approve",
  "design",
  "create",
  "meet",
  "hold",
  "schedule",
  "export",
  "ask",
  "provide",
  "upload"
];

const NARROW_COMMITMENT_OPENING =
  /^(research|evaluate|select|document|design|send|share|email|contact|follow up|outline|configure|clarify|define|link|plan|choose|confirm|draft|create|implement|integrate|test|validate|review|meet|hold|schedule|export|ask|provide|upload)\b/i;

export type MilestoneConsolidationContext = {
  projectName?: string | null;
  projectGoal?: string | null;
};

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

function taskPhase(value: string) {
  const normalized = normalizeText(value);
  if (/\b(research|compile|explore|investigate)\b/.test(normalized)) return "research";
  if (/\b(compare|evaluate|assess)\b/.test(normalized)) return "compare";
  if (/\b(select|choose|decide)\b/.test(normalized)) return "select";
  if (/\b(design|wireframes?|layouts?|interface|mockups?)\b/.test(normalized)) {
    return "design";
  }
  if (
    /\b(implement|implementation|build|develop|execute|code|integrate)\b/.test(
      normalized
    )
  ) {
    return "implement";
  }
  if (/\b(test|qa|validate)\b/.test(normalized)) return "test";
  if (/\b(review|approve)\b/.test(normalized)) return "review";
  if (/\b(deploy|publish|launch|deliver)\b/.test(normalized)) return "deliver";
  return "other";
}

function taskSemanticDomain(value: string) {
  const normalized = normalizeText(value);
  if (/\bchatbot\b/.test(normalized)) return "chatbot";
  if (
    /\b(product|catalog)\b/.test(normalized) &&
    /\b(page|pages|catalog|detail|interface|layout|wireframe)\b/.test(normalized)
  ) {
    return "product_wireframes";
  }
  if (/\b(auth|authentication|login|signup)\b/.test(normalized)) return "auth";
  if (/\b(payment|checkout|order|ordering)\b/.test(normalized)) return "commerce";
  return null;
}

function milestoneDomains(value: string) {
  const normalized = normalizeText(value);
  return Object.entries(MILESTONE_DOMAINS)
    .filter(([, markers]) => markers.some((marker) => normalized.includes(marker)))
    .map(([domain]) => domain);
}

function milestoneBreadth(value: string) {
  const normalized = normalizeText(value);
  const broad = BROAD_OUTCOME_TERMS.filter((term) => normalized.includes(term)).length;
  const narrow = NARROW_ACTION_TERMS.filter((term) => normalized.includes(term)).length;
  const pluralOutcome = /\b(capabilities|infrastructure|operations|content|scope)\b/.test(
    normalized
  )
    ? 1
    : 0;
  return broad * 2 + pluralOutcome - narrow;
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
  const leftDomain = taskSemanticDomain(left.title);
  const rightDomain = taskSemanticDomain(right.title);
  const leftPhase = taskPhase(left.title);
  const rightPhase = taskPhase(right.title);
  if (
    leftDomain &&
    leftDomain === rightDomain &&
    leftPhase !== "other" &&
    rightPhase !== "other" &&
    leftPhase !== rightPhase
  ) {
    return false;
  }
  const sameSemanticPhase =
    leftDomain !== null &&
    leftDomain === rightDomain &&
    leftPhase === rightPhase;
  if (!sameSemanticPhase && hasDistinctPhaseConflict(left.title, right.title)) {
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
    sameSemanticPhase ||
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

function mergeIntoMilestone(
  milestone: CommitmentCandidate,
  narrower: CommitmentCandidate
): CommitmentCandidate {
  const merged = mergeCommitment(milestone, narrower);
  return {
    ...merged,
    client_ref: milestone.client_ref,
    title: milestone.title,
    description: milestone.description ?? narrower.description,
    owner: milestone.owner,
    owners: uniqueNames([
      milestone.owner,
      ...milestone.owners,
      narrower.owner,
      ...narrower.owners
    ]),
    type: milestone.type,
    completion_state: milestone.completion_state,
    consolidated_from_refs: Array.from(
      new Set([
        ...(milestone.consolidated_from_refs ?? []),
        ...(narrower.consolidated_from_refs ?? []),
        narrower.client_ref
      ])
    )
  };
}

function taskWorkspaceForTitle(title: string): TaskCandidate["workspace_type"] {
  const normalized = normalizeText(title);
  if (/\b(code|backend|frontend|authentication|login|signup|implement)\b/.test(normalized)) {
    return "coding";
  }
  if (/\b(design|wireframe|brand|image|layout)\b/.test(normalized)) return "design";
  if (/\b(email|send|follow up|follow-up|contact|request)\b/.test(normalized)) {
    return "follow_up";
  }
  if (/\b(write|draft|copy|content|document)\b/.test(normalized)) return "document";
  if (/\b(website|page|site)\b/.test(normalized)) return "website_change";
  if (/\b(plan|scope|architecture|choose|select)\b/.test(normalized)) return "planning";
  return "other";
}

function commitmentAsTask(
  commitment: CommitmentCandidate,
  parentRef: string | null
): TaskCandidate {
  return {
    client_ref: `milestone_task_${commitment.client_ref}`,
    commitment_ref: parentRef,
    topic_id: commitment.topic_id,
    title: commitment.title,
    description: commitment.description,
    owner: commitment.owner,
    owners: commitment.owners,
    due_date: commitment.due_date,
    due_date_text: commitment.due_date_text,
    priority: commitment.priority,
    confidence: commitment.confidence,
    source_quote: commitment.source_quote,
    source_segment_ids: commitment.source_segment_ids,
    evidence_source: commitment.evidence_source,
    conversation_event_ids: commitment.conversation_event_ids ?? [],
    inferred: false,
    task_type: "commitment",
    workspace_type: taskWorkspaceForTitle(commitment.title),
    suggested_steps: [],
    execution_classification: commitment.execution_classification,
    consolidated_from_refs: Array.from(
      new Set([
        ...(commitment.consolidated_from_refs ?? []),
        commitment.client_ref
      ])
    )
  };
}

function parentChildScore(
  parent: CommitmentCandidate,
  child: CommitmentCandidate,
  context: MilestoneConsolidationContext
) {
  if (
    (parent.execution_classification ?? "committed") !==
    (child.execution_classification ?? "committed")
  ) {
    return 0;
  }

  const parentBreadth = milestoneBreadth(parent.title);
  const childBreadth = milestoneBreadth(child.title);
  if (parentBreadth < 1 || parentBreadth <= childBreadth) return 0;

  const parentDomains = milestoneDomains(parent.title);
  const childDomains = milestoneDomains(child.title);
  const sharedDomain = parentDomains.some((domain) => childDomains.includes(domain));
  if (
    parentDomains.length > 0 &&
    childDomains.length > 0 &&
    !sharedDomain
  ) {
    return 0;
  }

  const titleSimilarity = semanticTokenSimilarity(parent.title, child.title);
  const objectSimilarity = semanticTokenSimilarity(
    actionObjectKey(parent.title),
    actionObjectKey(child.title)
  );
  const quoteSim = quoteSimilarity(parent.source_quote, child.source_quote);
  const sharedEvidence = sharesSourceSegment(
    parent.source_segment_ids,
    child.source_segment_ids
  );
  const sameTopic = Boolean(
    parent.topic_id && child.topic_id && parent.topic_id === child.topic_id
  );
  const objective = [context.projectName, context.projectGoal]
    .filter(Boolean)
    .join(" ");
  const objectiveSupport = objective
    ? Math.min(
        semanticTokenSimilarity(parent.title, objective),
        semanticTokenSimilarity(child.title, objective)
      )
    : 0;

  if (
    !sharedDomain &&
    !sameTopic &&
    !sharedEvidence &&
    titleSimilarity < 0.35 &&
    objectSimilarity < 0.4
  ) {
    return 0;
  }

  return (
    Math.max(titleSimilarity, objectSimilarity) * 0.3 +
    quoteSim * 0.1 +
    (sharedDomain ? 0.24 : 0) +
    (sameTopic ? 0.12 : 0) +
    (sharedEvidence ? 0.14 : 0) +
    Math.min(0.12, (parentBreadth - childBreadth) * 0.04) +
    objectiveSupport * 0.05
  );
}

function consolidateMilestoneHierarchy(
  input: CommitmentCandidate[],
  context: MilestoneConsolidationContext
) {
  const commitments = [...input];
  const aliases = new Map<string, string>();
  const convertedTasks: TaskCandidate[] = [];
  let convertedCommitments = 0;

  const parentOrder = commitments
    .map((commitment, index) => ({
      commitment,
      index,
      breadth: milestoneBreadth(commitment.title)
    }))
    .sort(
      (left, right) =>
        right.breadth - left.breadth ||
        left.commitment.client_ref.localeCompare(right.commitment.client_ref)
    );
  const absorbed = new Set<number>();

  for (const parentEntry of parentOrder) {
    if (absorbed.has(parentEntry.index) || parentEntry.breadth < 1) continue;
    let parent = commitments[parentEntry.index];

    const candidates = commitments
      .map((child, index) => ({
        child,
        index,
        score:
          index === parentEntry.index || absorbed.has(index)
            ? 0
            : parentChildScore(parent, child, context)
      }))
      .filter((entry) => entry.score >= 0.52)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.child.client_ref.localeCompare(right.child.client_ref)
      );

    for (const candidate of candidates) {
      if (absorbed.has(candidate.index)) continue;
      const child = commitments[candidate.index];
      aliases.set(child.client_ref, parent.client_ref);
      convertedTasks.push(commitmentAsTask(child, parent.client_ref));
      parent = mergeIntoMilestone(parent, child);
      commitments[parentEntry.index] = parent;
      absorbed.add(candidate.index);
      convertedCommitments += 1;
    }
  }

  // A global model can still leak action-level or non-execution candidates into
  // commitments. Preserve their evidence by demoting them to tasks instead of
  // retaining peer-level pseudo-milestones.
  for (let index = 0; index < commitments.length; index += 1) {
    if (absorbed.has(index)) continue;
    const commitment = commitments[index];
    const classification = commitment.execution_classification ?? "committed";
    const shouldDemote =
      classification !== "committed" ||
      NARROW_COMMITMENT_OPENING.test(commitment.title.trim());
    if (!shouldDemote) continue;

    const eligibleParents =
      classification === "committed"
        ? commitments
            .map((candidate, candidateIndex) => ({
              candidate,
              candidateIndex,
              score: parentChildScore(candidate, commitment, context)
            }))
            .filter(
              ({ candidate, candidateIndex }) =>
                candidateIndex !== index &&
                !absorbed.has(candidateIndex) &&
                (candidate.execution_classification ?? "committed") ===
                  "committed" &&
                !NARROW_COMMITMENT_OPENING.test(candidate.title.trim())
            )
        : [];
    const parent =
      eligibleParents
        .filter((candidate) => candidate.score >= 0.28)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.candidate.client_ref.localeCompare(
              right.candidate.client_ref
            )
        )[0]?.candidate ??
      (eligibleParents.length === 1 ? eligibleParents[0].candidate : undefined);

    aliases.set(commitment.client_ref, parent?.client_ref ?? "");
    convertedTasks.push(
      commitmentAsTask(commitment, parent?.client_ref ?? null)
    );
    if (parent) {
      const parentIndex = commitments.findIndex(
        (candidate) => candidate.client_ref === parent.client_ref
      );
      commitments[parentIndex] = mergeIntoMilestone(parent, commitment);
    }
    absorbed.add(index);
    convertedCommitments += 1;
  }

  return {
    commitments: commitments.filter((_, index) => !absorbed.has(index)),
    aliases,
    convertedTasks,
    convertedCommitments
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

export function consolidateExecutionGraph(
  graph: ExecutionGraph,
  context: MilestoneConsolidationContext = {}
): {
  graph: ExecutionGraph;
  mergedCommitments: number;
  convertedCommitments: number;
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

  const hierarchy = consolidateMilestoneHierarchy(commitments, context);
  for (const [source, target] of hierarchy.aliases) {
    commitmentAliases.set(source, target);
  }
  const milestoneCommitments = hierarchy.commitments;
  const commitmentByRef = new Map(
    milestoneCommitments.map((commitment) => [commitment.client_ref, commitment])
  );

  let rejectedRestatements = 0;
  let removedGenericInferred = 0;
  const relinkedTasks = [...normalized.tasks, ...hierarchy.convertedTasks].flatMap((task) => {
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
    graph: { commitments: milestoneCommitments, tasks: classifiedTasks },
    mergedCommitments,
    convertedCommitments: hierarchy.convertedCommitments,
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
/** @deprecated Legacy outcome clustering; bypassed by the active execution runtime. */
