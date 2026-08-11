import {
  getTaskConsolidationAutoThreshold,
  getTaskConsolidationSuggestThreshold,
  getV4StageTimeoutMs,
  isTaskConsolidationEnabled
} from "@/lib/env";
import { semanticTokenSimilarity } from "./graph";
import { runTaskConsolidationModel, type TokenUsage } from "./work-item-model";
import { TASK_CONSOLIDATION_PROMPT } from "./work-item-prompts";
import type {
  ExecutionTree,
  TaskConsolidationProposal,
  TaskMergeProvenance,
  WorkItem
} from "./work-item-schemas";

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

// ============================================================
// Normalized completion signature (stability, not a new model call)
// ============================================================

/** A small, generic, domain-agnostic taxonomy of execution phases -- not tuned to any one
 * benchmark title. Verb-based, since a phase is what the task DOES, which is far more stable
 * across paraphrases of the same underlying transcript statement than the exact nouns used. */
export const COMPLETION_PHASES = [
  "setup_initiate",
  "test_evaluate",
  "feedback_adjust",
  "communicate_share",
  "deliver_release",
  "research_investigate",
  "contact_request"
] as const;
export type CompletionPhase = (typeof COMPLETION_PHASES)[number];

const PHASE_PATTERNS: Record<CompletionPhase, RegExp> = {
  setup_initiate:
    /\b(start(?:ed|ing|s)?|begin(?:ning|s)?|initial(?:ly|ize[sd]?)?|initiat(?:e|es|ed|ing)|set ?up|creat(?:e|es|ed|ing)|mak(?:e|es|ing)|establish(?:es|ed|ing)?|kick(?:ed|s)? off|manual(?:ly)?)\b/i,
  test_evaluate:
    /\b(test(?:s|ed|ing)?|evaluat(?:e|es|ed|ing)|verif(?:y|ies|ied|ying)|validat(?:e|es|ed|ing)|check(?:s|ed|ing)?|assess(?:es|ed|ing)?|observ(?:e|es|ed|ing)|inspect(?:s|ed|ing)?)\b/i,
  feedback_adjust:
    /\b(feedback|adjust(?:s|ed|ing)?|revis(?:e|es|ed|ing)|iterat(?:e|es|ed|ing)|refin(?:e|es|ed|ing)|improv(?:e|es|ed|ing))\b/i,
  communicate_share:
    /\b(open(?:s|ed|ing)?|shar(?:e|es|ed|ing)|notif(?:y|ies|ied|ying)|messag(?:e|es|ed|ing)|announc(?:e|es|ed|ing))\b/i,
  deliver_release:
    /\b(present(?:s|ed|ing)?|deliver(?:s|ed|ing)?|publish(?:es|ed|ing)?|releas(?:e|es|ed|ing)|launch(?:es|ed|ing)?|deploy(?:s|ed|ing)?|ship(?:s|ped|ping)?)\b/i,
  research_investigate:
    /\b(research(?:es|ed|ing)?|investigat(?:e|es|ed|ing)|explor(?:e|es|ed|ing)|look(?:s|ed|ing)? into|find(?:s)? out)\b/i,
  contact_request:
    /\b(contact(?:s|ed|ing)?|reach(?:es|ed|ing)? out|ask(?:s|ed|ing)?|request(?:s|ed|ing)?|follow(?:s|ed|ing)? up)\b/i
};

/** Confident classification requires exactly one bucket to match. A title matching zero or
 * several buckets (e.g. "...after testing is ready" hitting both test_evaluate and
 * feedback_adjust, or a proper noun like a product name incidentally containing a phase verb) is
 * deliberately left unclassified rather than guessed -- the phase gate below only ever blocks a
 * pair it is actually sure names two different execution phases; an ambiguous title never
 * triggers a false block, it just falls through to the existing lexical thresholds unaffected. */
function classifyPhase(item: WorkItem): CompletionPhase | null {
  const text = item.description ? `${item.title} ${item.description}` : item.title;
  const matches = COMPLETION_PHASES.filter((phase) => PHASE_PATTERNS[phase].test(text));
  return matches.length === 1 ? matches[0] : null;
}

const SIGNATURE_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "for",
  "on",
  "in",
  "with",
  "is",
  "are",
  "be",
  "using",
  "use",
  "used",
  "provide",
  "providing",
  "supplied",
  "supply"
]);

function signatureTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter((token) => token.length > 2 && !SIGNATURE_STOPWORDS.has(token))
    )
  ).sort();
}

export type CompletionSignature = {
  ref: string;
  owner_key: string | null;
  phase: CompletionPhase | null;
  content_tokens: string[];
  segment_ids: string[];
};

/**
 * The one deterministic, reusable summary of "what this task is actually about" that both
 * candidate shortlisting (relateTasks/buildClusters below) and the eval/debug trace read from --
 * never recomputed ad hoc in more than one place. Built entirely from fields already extracted
 * upstream; no model call, no new field on WorkItem itself.
 */
export function deriveCompletionSignature(item: WorkItem): CompletionSignature {
  const text = item.description ? `${item.title} ${item.description}` : item.title;
  return {
    ref: item.ref,
    owner_key: item.owner?.trim().toLowerCase() || null,
    phase: classifyPhase(item),
    content_tokens: signatureTokens(text),
    segment_ids: [...item.source_segment_ids]
  };
}

/** Full set equality -- the same evidence, not merely overlapping evidence. */
function sameIdSetExact(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

/** Any overlap at all -- used only as a similarity bonus signal, never for the "exact" gate. */
function sharesAnySegment(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return false;
  const set = new Set(left);
  return right.some((id) => set.has(id));
}

type ClusterRelation = "exact" | "candidate" | null;

/** Deterministic prefilter only. Semantic judgment (is this really the same completion event) is
 * always left to the model -- this only shortlists and only auto-decides byte-identical evidence. */
function tokenSetOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const token of a) if (setB.has(token)) intersection += 1;
  return intersection / Math.max(a.length, b.length);
}

/** Deterministic prefilter only. Semantic judgment (is this really the same completion event) is
 * always left to the model -- this only shortlists and only auto-decides byte-identical evidence.
 * Uses each task's normalized completion signature (deriveCompletionSignature above) rather than
 * raw title text alone -- signature comparison is deliberately less sensitive to which exact words
 * an upstream extraction/paraphrase run happened to use, which is what made candidate formation
 * (and therefore final task counts) vary run to run for otherwise-identical transcript content. */
function relateTasks(a: WorkItem, b: WorkItem): ClusterRelation {
  // Conflicts are checked first and always win -- identical evidence can never paper over a
  // genuine status/owner/date conflict (e.g. a duplicate extraction that also flipped one copy to
  // completed must never auto-merge just because the quote happens to match).
  const ownerA = normalizeText(a.owner);
  const ownerB = normalizeText(b.owner);
  const ownerConflict = ownerA && ownerB && ownerA !== ownerB;
  const statusConflict = a.status !== b.status;
  const dateConflict = a.due_date && b.due_date && a.due_date !== b.due_date;
  if (ownerConflict || statusConflict || dateConflict) return null;

  const sameSegments = sameIdSetExact(a.source_segment_ids, b.source_segment_ids);
  const sameQuote = normalizeText(a.source_quote) === normalizeText(b.source_quote);
  if (sameSegments && sameQuote) return "exact";

  const sigA = deriveCompletionSignature(a);
  const sigB = deriveCompletionSignature(b);

  // A confident, different phase classification on both sides is a hard block -- setup can never
  // shortlist against test/evaluate, evaluate against feedback, or either against communicate/
  // share, no matter how much surface vocabulary two titles happen to share. An unclassified side
  // (zero or multiple phase matches) never triggers this -- see classifyPhase.
  if (sigA.phase && sigB.phase && sigA.phase !== sigB.phase) return null;
  const samePhase = Boolean(sigA.phase && sigA.phase === sigB.phase);

  const similarity = semanticTokenSimilarity(a.title, b.title);
  const sharesEvidence = sharesAnySegment(a.source_segment_ids, b.source_segment_ids);
  if (similarity >= 0.55 || (sharesEvidence && similarity >= 0.35)) return "candidate";

  // Title-only overlap misses real duplicates whose titles are genuinely different paraphrases of
  // the same completion event ("make a Chatter session from the transcript" vs "manually start a
  // Chatter workflow" -- both about starting the same pilot, near-zero shared title vocabulary).
  // The normalized signature's stopword-filtered content tokens (title+description, generic
  // scaffolding words removed) carry a cleaner signal than raw combined text. This only widens the
  // SHORTLIST -- the model still makes the actual completion-equivalence call and may return more
  // than one proposal to correctly split a cluster back into distinct phases (see
  // TASK_CONSOLIDATION_PROMPT) -- so a wider net costs a little model attention, never a wrong
  // merge.
  const signatureOverlap = tokenSetOverlap(sigA.content_tokens, sigB.content_tokens);
  if (signatureOverlap >= 0.15) return "candidate";

  // Agreeing on a confidently-classified phase is itself a stable, wording-independent signal --
  // when both sides land in the same bucket, a smaller amount of remaining content overlap is
  // enough to justify a look, since the phase match already rules out the most common source of a
  // false shortlist (two tasks that just happen to share a few words but describe different work).
  if (samePhase && signatureOverlap > 0) return "candidate";

  return null;
}

type Cluster = { clusterRef: string; tasks: WorkItem[]; relation: "exact" | "candidate" };

/** First-match-wins clustering, same style as `mergeTopicWorkItems`: deterministic, order-stable,
 * never depends on the model to decide which tasks are even worth comparing. */
function buildClusters(tasks: WorkItem[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const task of tasks) {
    const existing = clusters.find((cluster) =>
      cluster.tasks.some((member) => relateTasks(member, task) !== null)
    );
    if (!existing) {
      // Vacuously "exact" until a second member proves otherwise; irrelevant for singletons
      // since they're filtered out below.
      clusters.push({ clusterRef: `cluster_${clusters.length + 1}`, tasks: [task], relation: "exact" });
      continue;
    }
    const isExactWithAll = existing.tasks.every((member) => relateTasks(member, task) === "exact");
    existing.tasks.push(task);
    if (!isExactWithAll) existing.relation = "candidate";
  }
  return clusters.filter((cluster) => cluster.tasks.length > 1);
}

// --- Cardinality-aware canonical selection (Fix 1) ---

type GroupBasis = ExecutionTree["commitments"][number]["group_basis"];

function minMembersFor(basis: GroupBasis): number {
  if (basis === "explicit_deliverable") return 1;
  if (basis === "multi_item_shared_purpose") return 2;
  return 0; // explicit_zero_task_outcome
}

type CardinalityContext = {
  /** ref -> the one commitment it is currently a child of (absent = standalone). */
  taskCommitmentRef: Map<string, string>;
  /** commitment ref -> its group_basis and current live member count. */
  commitmentInfo: Map<string, { basis: GroupBasis; count: number }>;
};

function buildCardinalityContext(commitments: ExecutionTree["commitments"]): CardinalityContext {
  const taskCommitmentRef = new Map<string, string>();
  const commitmentInfo = new Map<string, { basis: GroupBasis; count: number }>();
  for (const commitment of commitments) {
    commitmentInfo.set(commitment.ref, { basis: commitment.group_basis, count: commitment.tasks.length });
    for (const task of commitment.tasks) taskCommitmentRef.set(task.ref, commitment.ref);
  }
  return { taskCommitmentRef, commitmentInfo };
}

/** Would removing every ref in `removedRefs` (as merge losers) break any commitment's required
 * member count for its group_basis? Returns a human reason when yes, null when safe. */
function cardinalityRiskReason(removedRefs: string[], ctx: CardinalityContext): string | null {
  const impact = new Map<string, number>();
  for (const ref of removedRefs) {
    const commitmentRef = ctx.taskCommitmentRef.get(ref);
    if (!commitmentRef) continue; // not a child of anything -- never a cardinality risk
    impact.set(commitmentRef, (impact.get(commitmentRef) ?? 0) + 1);
  }
  for (const [commitmentRef, removedCount] of impact) {
    const info = ctx.commitmentInfo.get(commitmentRef);
    if (!info) continue;
    const remaining = info.count - removedCount;
    const minRequired = minMembersFor(info.basis);
    if (remaining < minRequired) {
      return `would leave commitment ${commitmentRef} (group_basis=${info.basis}) with ${remaining} member(s), below the required ${minRequired}`;
    }
  }
  return null;
}

function commitRemoval(removedRefs: string[], ctx: CardinalityContext) {
  for (const ref of removedRefs) {
    const commitmentRef = ctx.taskCommitmentRef.get(ref);
    if (commitmentRef) {
      const info = ctx.commitmentInfo.get(commitmentRef);
      if (info) info.count -= 1;
    }
    ctx.taskCommitmentRef.delete(ref);
  }
}

/**
 * Canonical-selection priority (Fix 1): an existing child task under a valid verified commitment
 * always outranks a standalone duplicate -- this overrides confidence, wording, evidence count,
 * extraction order, and ref ordering entirely. Only among two candidates of the same child-status
 * do the finer-grained tiebreakers (evidence strength, description presence, confidence, then a
 * stable ref sort) apply. Returns candidates ranked best-to-worst so the caller can fall back to
 * the next-best choice if the top choice turns out to be cardinality-unsafe.
 */
function rankCanonicalCandidates(tasks: WorkItem[], ctx: CardinalityContext): WorkItem[] {
  return [...tasks].sort((a, b) => {
    const aChild = ctx.taskCommitmentRef.has(a.ref) ? 1 : 0;
    const bChild = ctx.taskCommitmentRef.has(b.ref) ? 1 : 0;
    if (aChild !== bChild) return bChild - aChild;
    const aEvidence = a.source_segment_ids.length;
    const bEvidence = b.source_segment_ids.length;
    if (aEvidence !== bEvidence) return bEvidence - aEvidence;
    const aDesc = a.description?.trim() ? 1 : 0;
    const bDesc = b.description?.trim() ? 1 : 0;
    if (aDesc !== bDesc) return bDesc - aDesc;
    const aConfidence = a.confidence ?? 0;
    const bConfidence = b.confidence ?? 0;
    if (aConfidence !== bConfidence) return bConfidence - aConfidence;
    return a.ref.localeCompare(b.ref);
  });
}

/** Tries each ranked candidate as the survivor in priority order, returning the first choice whose
 * implied removal set is cardinality-safe. `null` means no direction is safe -- the caller must
 * reject the merge and keep every task separate, rather than leaning on the whole-tree fallback. */
function pickSafeCanonical(
  tasks: WorkItem[],
  ctx: CardinalityContext
): { ok: true; survivor: WorkItem; removedRefs: string[] } | { ok: false; reason: string } {
  let firstReason: string | null = null;
  for (const candidate of rankCanonicalCandidates(tasks, ctx)) {
    const removedRefs = tasks.filter((task) => task !== candidate).map((task) => task.ref);
    const risk = cardinalityRiskReason(removedRefs, ctx);
    if (!risk) return { ok: true, survivor: candidate, removedRefs };
    firstReason = firstReason ?? risk;
  }
  return { ok: false, reason: firstReason ?? "no safe merge direction found" };
}

/** `baseType` reflects how the match was found (byte-identical evidence vs. the model's semantic
 * judgment); it's overridden to `standalone_absorption` specifically when a commitment's child
 * survives and absorbs a non-child (standalone) duplicate, regardless of which way it was found. */
function mergeType(
  survivorRef: string,
  removedRefs: string[],
  ctx: CardinalityContext,
  baseType: "exact" | "semantic"
): TaskMergeProvenance["merge_type"] {
  const survivorWasChild = ctx.taskCommitmentRef.has(survivorRef);
  const absorbedAStandalone = removedRefs.some((ref) => !ctx.taskCommitmentRef.has(ref));
  return survivorWasChild && absorbedAStandalone ? "standalone_absorption" : baseType;
}

type MergeOutcome =
  | { ok: true; survivor: WorkItem; provenance: TaskMergeProvenance; removedRefs: string[] }
  | { ok: false; reason: string };

function mergeExactCluster(tasks: WorkItem[], ctx: CardinalityContext, generation: number): MergeOutcome {
  const picked = pickSafeCanonical(tasks, ctx);
  if (!picked.ok) return picked;
  const { survivor: preferred, removedRefs } = picked;
  return {
    ok: true,
    survivor: {
      ...preferred,
      owners: Array.from(new Set(tasks.flatMap((task) => task.owners))),
      source_segment_ids: Array.from(new Set(tasks.flatMap((task) => task.source_segment_ids)))
    },
    provenance: {
      merged_from_task_refs: removedRefs,
      merge_type: mergeType(preferred.ref, removedRefs, ctx, "exact"),
      merge_reason: "Identical source evidence (same segment IDs and quote).",
      merge_confidence: 1,
      consolidation_generation: generation,
      preserved_sequence_notes: []
    },
    removedRefs
  };
}

function applyProposal(
  proposal: TaskConsolidationProposal,
  tasksByRef: Map<string, WorkItem>,
  ctx: CardinalityContext,
  generation: number
): MergeOutcome | null {
  const tasks = proposal.task_refs.flatMap((ref) => {
    const task = tasksByRef.get(ref);
    return task ? [task] : [];
  });
  if (tasks.length < 2) return null;
  const picked = pickSafeCanonical(tasks, ctx);
  if (!picked.ok) return picked;
  const { survivor, removedRefs } = picked;
  if (proposal.disposition === "merge") {
    return {
      ok: true,
      survivor: {
        ...survivor,
        title: proposal.canonical_title?.trim() || survivor.title,
        description: proposal.canonical_description ?? survivor.description,
        owners: Array.from(new Set(tasks.flatMap((task) => task.owners))),
        source_segment_ids: Array.from(new Set(tasks.flatMap((task) => task.source_segment_ids)))
      },
      provenance: {
        merged_from_task_refs: removedRefs,
        merge_type: mergeType(survivor.ref, removedRefs, ctx, "semantic"),
        merge_reason: proposal.reason,
        merge_confidence: proposal.confidence,
        consolidation_generation: generation,
        preserved_sequence_notes: []
      },
      removedRefs
    };
  }
  // absorb_as_sequence_note: the non-survivors are dropped as their own tasks; their content is
  // preserved as a note on the survivor rather than as merged evidence.
  return {
    ok: true,
    survivor: { ...survivor },
    provenance: {
      merged_from_task_refs: removedRefs,
      merge_type: "standalone_absorption",
      merge_reason: proposal.reason,
      merge_confidence: proposal.confidence,
      consolidation_generation: generation,
      preserved_sequence_notes: proposal.preserved_sequence_note ? [proposal.preserved_sequence_note] : []
    },
    removedRefs
  };
}

export type ConsolidationDecision = {
  cluster_ref: string;
  task_refs: string[];
  disposition:
    | "merge"
    | "keep_separate"
    | "absorb_as_sequence_note"
    | "auto_merge_exact"
    | "rejected_cardinality_risk";
  reason: string;
  confidence: number;
  applied: boolean;
};

export type ConsolidationResult = {
  tasks: WorkItem[];
  provenanceByRef: Map<string, TaskMergeProvenance>;
  decisions: ConsolidationDecision[];
  suggestions: ConsolidationDecision[];
  modelLatencyMs: number;
  modelUsage: TokenUsage | null;
};

/**
 * Runs deterministic exact-duplicate merging plus model-assisted semantic consolidation over one
 * pool of tasks (either one commitment's children, or the cross-commitment standalone pool). Never
 * calls the model when there are no ambiguous clusters. Every merge -- exact or semantic -- is
 * checked against `ctx` (a cardinality context shared across the whole consolidation run) before
 * being applied; an unsafe merge is rejected and both tasks are kept, rather than ever relying on
 * the final whole-tree validation to catch it after the fact.
 */
async function consolidatePool(input: {
  meetingId: string;
  poolLabel: string;
  tasks: WorkItem[];
  ctx: CardinalityContext;
  generation: number;
  runModel: typeof runTaskConsolidationModel;
}): Promise<ConsolidationResult> {
  if (!isTaskConsolidationEnabled() || input.tasks.length < 2) {
    return {
      tasks: input.tasks,
      provenanceByRef: new Map(),
      decisions: [],
      suggestions: [],
      modelLatencyMs: 0,
      modelUsage: null
    };
  }
  const clusters = buildClusters(input.tasks);
  const removedRefs = new Set<string>();
  const survivorByRemovedRef = new Map<string, WorkItem>();
  const provenanceByRef = new Map<string, TaskMergeProvenance>();
  const decisions: ConsolidationDecision[] = [];
  const suggestions: ConsolidationDecision[] = [];
  let modelLatencyMs = 0;
  let modelUsage: TokenUsage | null = null;

  const exactClusters = clusters.filter((cluster) => cluster.relation === "exact");
  const candidateClusters = clusters.filter((cluster) => cluster.relation === "candidate");

  for (const cluster of exactClusters) {
    const merged = mergeExactCluster(cluster.tasks, input.ctx, 1);
    if (!merged.ok) {
      decisions.push({
        cluster_ref: cluster.clusterRef,
        task_refs: cluster.tasks.map((t) => t.ref),
        disposition: "rejected_cardinality_risk",
        reason: `Identical evidence, but no merge direction is safe: ${merged.reason}. Keeping all tasks separate.`,
        confidence: 1,
        applied: false
      });
      continue;
    }
    const { survivor, provenance, removedRefs: removed } = merged;
    for (const ref of removed) {
      removedRefs.add(ref);
      survivorByRemovedRef.set(ref, survivor);
    }
    commitRemoval(removed, input.ctx);
    provenanceByRef.set(survivor.ref, provenance);
    decisions.push({
      cluster_ref: cluster.clusterRef,
      task_refs: cluster.tasks.map((t) => t.ref),
      disposition: "auto_merge_exact",
      reason: provenance.merge_reason,
      confidence: 1,
      applied: true
    });
  }

  if (candidateClusters.length > 0) {
    // Mutable, updated after every applied proposal -- so a later proposal touching a ref that a
    // previous proposal already merged sees the merged state, and its target refs still resolve.
    const currentByRef = new Map(input.tasks.map((task) => [task.ref, task]));
    const result = await input.runModel({
      systemPrompt: TASK_CONSOLIDATION_PROMPT,
      timeoutMs: Math.max(getV4StageTimeoutMs("task_consolidation"), 60_000),
      context: {
        meeting_id: input.meetingId,
        pool: input.poolLabel,
        clusters: candidateClusters.map((cluster) => ({
          cluster_ref: cluster.clusterRef,
          tasks: cluster.tasks.map((task) => ({
            ref: task.ref,
            title: task.title,
            description: task.description,
            owner: task.owner,
            status: task.status,
            due_date: task.due_date,
            source_quote: task.source_quote,
            source_segment_ids: task.source_segment_ids
          }))
        }))
      }
    });
    modelLatencyMs += result.latencyMs;
    if (result.ok) {
      modelUsage = result.usage;
      const autoThreshold = getTaskConsolidationAutoThreshold();
      const suggestThreshold = getTaskConsolidationSuggestThreshold();
      for (const proposal of result.proposals) {
        if (proposal.disposition === "keep_separate") {
          decisions.push({
            cluster_ref: proposal.proposal_ref,
            task_refs: proposal.task_refs,
            disposition: "keep_separate",
            reason: proposal.reason,
            confidence: proposal.confidence,
            applied: false
          });
          continue;
        }
        const shouldApply = proposal.confidence >= autoThreshold;
        if (!shouldApply) {
          const record: ConsolidationDecision = {
            cluster_ref: proposal.proposal_ref,
            task_refs: proposal.task_refs,
            disposition: proposal.disposition,
            reason: proposal.reason,
            confidence: proposal.confidence,
            applied: false
          };
          if (proposal.confidence >= suggestThreshold) suggestions.push(record);
          decisions.push(record);
          continue;
        }
        const applied = applyProposal(proposal, currentByRef, input.ctx, 1);
        if (applied === null) continue;
        if (!applied.ok) {
          decisions.push({
            cluster_ref: proposal.proposal_ref,
            task_refs: proposal.task_refs,
            disposition: "rejected_cardinality_risk",
            reason: `Model proposed a ${proposal.disposition} that has no cardinality-safe direction (${applied.reason}); keeping tasks separate. Original reason: ${proposal.reason}`,
            confidence: proposal.confidence,
            applied: false
          });
          continue;
        }
        // A ref can be touched by more than one proposal (e.g. a 4-way merge, then a separate
        // sequence-note absorption onto the same survivor) -- accumulate provenance rather than
        // overwrite it, so the first proposal's merged_from_task_refs are never silently lost.
        const existingProvenance = provenanceByRef.get(applied.survivor.ref);
        const provenance: TaskMergeProvenance = existingProvenance
          ? {
              merged_from_task_refs: Array.from(
                new Set([...existingProvenance.merged_from_task_refs, ...applied.provenance.merged_from_task_refs])
              ),
              merge_type: applied.provenance.merge_type,
              merge_reason: [existingProvenance.merge_reason, applied.provenance.merge_reason]
                .filter(Boolean)
                .join(" "),
              merge_confidence: Math.min(existingProvenance.merge_confidence, applied.provenance.merge_confidence),
              consolidation_generation: 1,
              preserved_sequence_notes: Array.from(
                new Set([...existingProvenance.preserved_sequence_notes, ...applied.provenance.preserved_sequence_notes])
              )
            }
          : applied.provenance;
        provenanceByRef.set(applied.survivor.ref, provenance);
        currentByRef.set(applied.survivor.ref, applied.survivor);
        commitRemoval(applied.removedRefs, input.ctx);
        for (const removedRef of applied.removedRefs) {
          removedRefs.add(removedRef);
          survivorByRemovedRef.set(removedRef, applied.survivor);
          currentByRef.delete(removedRef);
        }
        decisions.push({
          cluster_ref: proposal.proposal_ref,
          task_refs: proposal.task_refs,
          disposition: proposal.disposition,
          reason: proposal.reason,
          confidence: proposal.confidence,
          applied: true
        });
      }
    }
  }

  // `survivorByRemovedRef` maps every removed ref to the (already-updated) merged survivor
  // object; seed a lookup from it, then walk the original list once, in original order, using the
  // updated object where one exists and the original task everywhere else.
  const updatedSurvivors = new Map<string, WorkItem>();
  for (const survivor of survivorByRemovedRef.values()) {
    updatedSurvivors.set(survivor.ref, survivor);
  }
  const finalTasks = input.tasks.flatMap((task) => {
    if (removedRefs.has(task.ref)) return [];
    return [updatedSurvivors.get(task.ref) ?? task];
  });

  return {
    tasks: finalTasks,
    provenanceByRef,
    decisions,
    suggestions,
    modelLatencyMs,
    modelUsage
  };
}

export type TreeConsolidationResult = {
  tree: ExecutionTree;
  provenanceByRef: Map<string, TaskMergeProvenance>;
  decisions: ConsolidationDecision[];
  suggestions: ConsolidationDecision[];
  modelLatencyMs: number;
  modelUsage: TokenUsage | null;
  /** Every input task's normalized completion signature (see deriveCompletionSignature), keyed by
   * ref, computed once up front -- diagnosable run-to-run variance (Part 10): pair this with
   * `decisions`/`suggestions` to see exactly why two tasks did or didn't shortlist together. */
  completionSignatures: Record<string, CompletionSignature>;
};

/**
 * Phase 5: consolidates fragmented child tasks within each commitment separately, then compares
 * remaining standalone tasks against every commitment's (already-consolidated) children so a
 * duplicate standalone task is absorbed into the matching child rather than left as a second copy.
 * A single cardinality context is threaded through both phases (Fix 1) so a merge can never reduce
 * a commitment below its group_basis's required member count -- an unsafe merge is rejected at the
 * candidate level, not caught after the fact by the whole-tree fallback.
 */
export async function consolidateExecutionTree(
  input: {
    meetingId: string;
    tree: ExecutionTree;
  },
  dependencies: { runModel?: typeof runTaskConsolidationModel } = {}
): Promise<TreeConsolidationResult> {
  const runModel = dependencies.runModel ?? runTaskConsolidationModel;
  const ctx = buildCardinalityContext(input.tree.commitments);
  const allProvenance = new Map<string, TaskMergeProvenance>();
  const allDecisions: ConsolidationDecision[] = [];
  const allSuggestions: ConsolidationDecision[] = [];
  let totalModelLatencyMs = 0;
  const usages: Array<TokenUsage | null> = [];

  // Sequential, not Promise.all: each commitment's pool only ever removes its own refs from the
  // shared `ctx`, but running them one at a time keeps the cardinality bookkeeping trivially easy
  // to reason about and keeps consolidation deterministic regardless of network timing.
  const consolidatedCommitments: ExecutionTree["commitments"] = [];
  for (const commitment of input.tree.commitments) {
    const result = await consolidatePool({
      meetingId: input.meetingId,
      poolLabel: `commitment:${commitment.ref}`,
      tasks: commitment.tasks,
      ctx,
      generation: 1,
      runModel
    });
    for (const [ref, provenance] of result.provenanceByRef) allProvenance.set(ref, provenance);
    allDecisions.push(...result.decisions);
    allSuggestions.push(...result.suggestions);
    totalModelLatencyMs += result.modelLatencyMs;
    usages.push(result.modelUsage);
    consolidatedCommitments.push({
      ...commitment,
      tasks: result.tasks,
      member_refs: result.tasks.map((task) => task.ref)
    });
  }

  // Child tasks are listed first purely for readability in traces; the actual child-wins behavior
  // comes from `rankCanonicalCandidates`/`ctx`, not from pool ordering.
  const crossPool = [
    ...consolidatedCommitments.flatMap((commitment) => commitment.tasks),
    ...input.tree.standalone_tasks
  ];
  const crossResult = await consolidatePool({
    meetingId: input.meetingId,
    poolLabel: "standalone-vs-child",
    tasks: crossPool,
    ctx,
    generation: 1,
    runModel
  });
  for (const [ref, provenance] of crossResult.provenanceByRef) allProvenance.set(ref, provenance);
  allDecisions.push(...crossResult.decisions);
  allSuggestions.push(...crossResult.suggestions);
  totalModelLatencyMs += crossResult.modelLatencyMs;
  usages.push(crossResult.modelUsage);

  const survivingRefs = new Set(crossResult.tasks.map((task) => task.ref));
  const survivorByRef = new Map(crossResult.tasks.map((task) => [task.ref, task]));
  const finalStandalone = input.tree.standalone_tasks.flatMap((task) => {
    if (!survivingRefs.has(task.ref)) return [];
    return [survivorByRef.get(task.ref) ?? task];
  });
  const finalCommitments = consolidatedCommitments.map((commitment) => {
    const tasks = commitment.tasks.flatMap((task) => {
      if (!survivingRefs.has(task.ref)) return [];
      return [survivorByRef.get(task.ref) ?? task];
    });
    return { ...commitment, tasks, member_refs: tasks.map((task) => task.ref) };
  });

  const presentUsages = usages.filter((usage): usage is TokenUsage => usage !== null);
  const modelUsage: TokenUsage | null =
    presentUsages.length === 0
      ? null
      : presentUsages.reduce(
          (total, usage) => ({
            input_tokens: (total.input_tokens ?? 0) + (usage.input_tokens ?? 0),
            output_tokens: (total.output_tokens ?? 0) + (usage.output_tokens ?? 0),
            total_tokens: (total.total_tokens ?? 0) + (usage.total_tokens ?? 0)
          }),
          { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        );

  const completionSignatures: Record<string, CompletionSignature> = {};
  for (const task of [...input.tree.commitments.flatMap((c) => c.tasks), ...input.tree.standalone_tasks]) {
    completionSignatures[task.ref] = deriveCompletionSignature(task);
  }

  return {
    tree: { commitments: finalCommitments, standalone_tasks: finalStandalone },
    provenanceByRef: allProvenance,
    decisions: allDecisions,
    suggestions: allSuggestions,
    modelLatencyMs: totalModelLatencyMs,
    modelUsage,
    completionSignatures
  };
}
