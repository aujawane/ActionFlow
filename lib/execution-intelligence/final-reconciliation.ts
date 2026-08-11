import { semanticTokenSimilarity } from "./graph";
import type { ExecutionTree, WorkItem } from "./work-item-schemas";

/**
 * Phase 5.5: deterministic final graph reconciliation. Runs once, after task consolidation and
 * before the final integrity check, on the fully-assembled tree. This is a safety net, not a
 * replacement for grouping/verification's semantic containment judgment (which stays a model
 * call -- true "is B a component of A" reasoning across arbitrary titles isn't something a
 * lexical check can safely make; see work-item-prompts.ts's CONTAINMENT CHECK). What this module
 * *can* safely catch without a model call:
 *   - a standalone task that is really just a reworded restatement of a surviving commitment's
 *     own outcome or one of its child tasks (reuses the same token-overlap signal task
 *     consolidation already uses for candidate clustering, from ./graph, not from
 *     task-consolidation.ts itself -- no change to consolidation);
 *   - a commitment description that asserts scope (email hosting/migration/mailbox/DNS work) with
 *     no grounding anywhere in that commitment's own member/criteria evidence.
 * Everything else this stabilization pass targets (completed-in-meeting, communication-process,
 * owner-evidence repair) is a semantic transcript judgment and is handled upstream, in the global
 * scope/role reconciliation pass (work-item-prompts.ts's GLOBAL_WORK_ITEM_CORRECTION_PROMPT) --
 * by the time an item reaches this stage, isExecutionEligible has already kept it out of the tree
 * if reconciliation classified it correctly.
 */

const DUPLICATE_STANDALONE_THRESHOLD = 0.5;

const UNSUPPORTED_SCOPE_PATTERNS: RegExp[] = [
  /email hosting/i,
  /mail (server|hosting)/i,
  /migrat(e|ion)[^.]*email/i,
  /email[^.]*migrat(e|ion)/i,
  /\bmailbox(es)?\b/i,
  /\bmx records?\b/i,
  /dns[^.]*mail/i,
  /email (service|provider) (setup|configuration)/i,
  /provision(ing)?[^.]*email/i,
  /configure[^.]*mail (server|hosting)/i
];

export type StandaloneDisposition = "keep_standalone" | "duplicate_commitment" | "duplicate_child";

export type StandaloneReconciliationDecision = {
  task_ref: string;
  disposition: StandaloneDisposition;
  reason: string;
  matched_ref: string | null;
  removed_source_quote: string | null;
  removed_source_segment_ids: string[];
};

export type CommitmentReconciliationDecision = {
  commitment_ref: string;
  disposition: "kept" | "description_stripped" | "deadline_clause_stripped";
  reason: string;
};

export type OwnershipReconciliationDecision = {
  commitment_ref: string;
  disposition: "kept" | "repaired";
  previous_owner: string | null;
  resolved_owner: string | null;
  reason: string;
};

export type AcceptanceCriteriaConsolidationDecision = {
  commitment_ref: string;
  disposition: "kept" | "merged";
  canonical_ref: string;
  canonical_title: string;
  merged_from_refs: string[];
  reason: string;
};

export type FinalReconciliationResult = {
  tree: ExecutionTree;
  commitmentDecisions: CommitmentReconciliationDecision[];
  standaloneDecisions: StandaloneReconciliationDecision[];
  ownershipDecisions: OwnershipReconciliationDecision[];
  acceptanceCriteriaDecisions: AcceptanceCriteriaConsolidationDecision[];
  dateDecisions: CommitmentReconciliationDecision[];
};

function groundedEvidenceText(commitment: ExecutionTree["commitments"][number]): string {
  const parts: string[] = [];
  for (const task of commitment.tasks) {
    parts.push(task.title, task.description ?? "", task.source_quote);
  }
  for (const criterion of commitment.acceptance_criteria) {
    parts.push(criterion.title, criterion.description ?? "", criterion.source_quote);
  }
  if (commitment.explicit_outcome_evidence?.source_quote) {
    parts.push(commitment.explicit_outcome_evidence.source_quote);
  }
  return parts.join(" \n ");
}

/** Strips (never rejects the whole commitment for) a description that asserts scope no member or
 * criterion actually grounds -- the same "clear rather than discard" posture execution-tree.ts's
 * sanitizeNarrowDescription already uses for narrow descriptions. */
function reconcileCommitmentDescriptions(
  commitments: ExecutionTree["commitments"]
): { commitments: ExecutionTree["commitments"]; decisions: CommitmentReconciliationDecision[] } {
  const decisions: CommitmentReconciliationDecision[] = [];
  const reconciled = commitments.map((commitment) => {
    if (!commitment.description) {
      decisions.push({ commitment_ref: commitment.ref, disposition: "kept", reason: "No description to validate." });
      return commitment;
    }
    const grounded = groundedEvidenceText(commitment);
    const ungroundedMatch = UNSUPPORTED_SCOPE_PATTERNS.find(
      (pattern) => pattern.test(commitment.description!) && !pattern.test(grounded)
    );
    if (ungroundedMatch) {
      decisions.push({
        commitment_ref: commitment.ref,
        disposition: "description_stripped",
        reason: `Description asserted scope (matching ${ungroundedMatch}) with no grounding in any member/criterion evidence; cleared rather than left misleading.`
      });
      return { ...commitment, description: null };
    }
    decisions.push({ commitment_ref: commitment.ref, disposition: "kept", reason: "Description is grounded in member/criteria evidence." });
    return commitment;
  });
  return { commitments: reconciled, decisions };
}

/** Finds the best-matching child task (across all commitments) and the best-matching commitment
 * title for a standalone task, using the same token-overlap signal task consolidation uses for
 * candidate clustering (imported from ./graph, not from task-consolidation.ts). */
function reconcileStandaloneDuplicates(
  tree: ExecutionTree
): { commitments: ExecutionTree["commitments"]; standaloneTasks: ExecutionTree["standalone_tasks"]; decisions: StandaloneReconciliationDecision[] } {
  const decisions: StandaloneReconciliationDecision[] = [];
  const commitments = tree.commitments.map((commitment) => ({ ...commitment, tasks: [...commitment.tasks] }));
  const survivingStandalone: ExecutionTree["standalone_tasks"] = [];

  for (const standalone of tree.standalone_tasks) {
    let bestChildScore = 0;
    let bestChildRef: { commitmentIndex: number; taskIndex: number } | null = null;
    let bestCommitmentScore = 0;
    let bestCommitmentRef: string | null = null;

    commitments.forEach((commitment, commitmentIndex) => {
      const titleScore = semanticTokenSimilarity(standalone.title, commitment.title);
      if (titleScore > bestCommitmentScore) {
        bestCommitmentScore = titleScore;
        bestCommitmentRef = commitment.ref;
      }
      commitment.tasks.forEach((task, taskIndex) => {
        const score = semanticTokenSimilarity(standalone.title, task.title);
        if (score > bestChildScore) {
          bestChildScore = score;
          bestChildRef = { commitmentIndex, taskIndex };
        }
      });
    });

    if (bestChildRef !== null && bestChildScore >= DUPLICATE_STANDALONE_THRESHOLD && bestChildScore >= bestCommitmentScore) {
      const { commitmentIndex, taskIndex } = bestChildRef as { commitmentIndex: number; taskIndex: number };
      const matchedTask = commitments[commitmentIndex].tasks[taskIndex];
      commitments[commitmentIndex].tasks[taskIndex] = {
        ...matchedTask,
        source_segment_ids: Array.from(new Set([...matchedTask.source_segment_ids, ...standalone.source_segment_ids]))
      };
      decisions.push({
        task_ref: standalone.ref,
        disposition: "duplicate_child",
        reason: `Restates child task "${matchedTask.title}" (${matchedTask.ref}, similarity ${bestChildScore.toFixed(2)}); absorbed rather than left as a second completion event.`,
        matched_ref: matchedTask.ref,
        removed_source_quote: standalone.source_quote,
        removed_source_segment_ids: standalone.source_segment_ids
      });
      continue;
    }

    if (bestCommitmentRef !== null && bestCommitmentScore >= DUPLICATE_STANDALONE_THRESHOLD) {
      decisions.push({
        task_ref: standalone.ref,
        disposition: "duplicate_commitment",
        reason: `Restates commitment "${commitments.find((c) => c.ref === bestCommitmentRef)?.title}" (${bestCommitmentRef}, similarity ${bestCommitmentScore.toFixed(2)}); absorbed rather than left as a second completion event.`,
        matched_ref: bestCommitmentRef,
        removed_source_quote: standalone.source_quote,
        removed_source_segment_ids: standalone.source_segment_ids
      });
      continue;
    }

    decisions.push({
      task_ref: standalone.ref,
      disposition: "keep_standalone",
      reason: "No matching commitment or child task found; not a duplicate.",
      matched_ref: null,
      removed_source_quote: null,
      removed_source_segment_ids: []
    });
    survivingStandalone.push(standalone);
  }

  return { commitments, standaloneTasks: survivingStandalone, decisions };
}

// ============================================================
// Primary owner repair (accountable owner != union of contributors)
// ============================================================

const GENERIC_OWNER_VALUES = new Set([
  "team",
  "the team",
  "everyone",
  "all",
  "group",
  "shared",
  "unassigned"
]);

/** A name that smuggles more than one person into a single `owner` string (e.g. a model
 * that answers "who owns this" with "Aditya and Jamileh" instead of picking one). */
const MULTI_NAME_SEPARATOR_PATTERN = /,| and | & | \/ /i;

function isGenericOrAmbiguousOwner(owner: string | null, knownSingleOwners: Set<string>): boolean {
  const trimmed = owner?.trim();
  if (!trimmed) return true;
  if (GENERIC_OWNER_VALUES.has(trimmed.toLowerCase())) return true;
  if (MULTI_NAME_SEPARATOR_PATTERN.test(trimmed) && !knownSingleOwners.has(trimmed)) return true;
  return false;
}

/**
 * Ranked, deterministic repair for a missing/generic/multi-name commitment owner. Never runs when
 * the existing owner is already a single, explicit name -- that is preserved as-is regardless of
 * how many people have child tasks (see the module doc: "commitment primary owner != union of
 * child-task owners"). Ranking, cheapest-and-most-reliable signal first:
 *   1. the member task whose own title most closely restates the commitment's outcome (the
 *      strongest available proxy, without a model call, for "explicitly promised to deliver/
 *      present/ship this outcome" -- a commitment's title is typically drawn from exactly that
 *      task);
 *   2. among ties, whichever of those candidates also shares the commitment's own due_date
 *      (direct deadline ownership);
 *   3. only if no member task's title relates to the commitment at all, fall back to whoever owns
 *      the most member tasks -- explicitly the lowest-ranked, "supporting contributor" signal.
 */
function resolvePrimaryOwner(
  commitment: ExecutionTree["commitments"][number]
): { owner: string | null; reason: string; repaired: boolean } {
  const memberOwnerNames = new Set(
    commitment.tasks.map((task) => task.owner?.trim()).filter((owner): owner is string => Boolean(owner))
  );

  if (!isGenericOrAmbiguousOwner(commitment.owner, memberOwnerNames)) {
    return { owner: commitment.owner, reason: commitment.primary_owner_reason, repaired: false };
  }

  let best: { owner: string; score: number; task: WorkItem } | null = null;
  for (const task of commitment.tasks) {
    const owner = task.owner?.trim();
    if (!owner) continue;
    const titleSimilarity = semanticTokenSimilarity(commitment.title, task.title);
    const sharesDueDate = Boolean(commitment.due_date) && task.due_date === commitment.due_date;
    const score = titleSimilarity * 10 + (sharesDueDate ? 1 : 0);
    if (titleSimilarity <= 0) continue;
    if (!best || score > best.score) best = { owner, score, task };
  }
  if (best) {
    return {
      owner: best.owner,
      repaired: true,
      reason: `Repaired ambiguous/shared owner "${commitment.owner ?? "null"}": "${best.task.title}" (${best.task.ref}) most directly restates the commitment's own outcome${best.task.due_date && best.task.due_date === commitment.due_date ? " and shares its due date" : ""}, so its owner is the accountable owner.`
    };
  }

  const counts = new Map<string, number>();
  for (const task of commitment.tasks) {
    const owner = task.owner?.trim();
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  const [top] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (top) {
    return {
      owner: top[0],
      repaired: true,
      reason: `Repaired ambiguous/shared owner "${commitment.owner ?? "null"}": no member task title restated the commitment's outcome, so fell back to the contributor owning the most member tasks (${top[0]}); this is a supporting-contributor fallback, not evidence of shared accountability.`
    };
  }

  return {
    owner: null,
    repaired: true,
    reason: `Ambiguous/shared owner "${commitment.owner ?? "null"}" could not be repaired: no member task carries an owner to attribute accountability to.`
  };
}

function reconcileCommitmentOwnership(
  commitments: ExecutionTree["commitments"]
): { commitments: ExecutionTree["commitments"]; decisions: OwnershipReconciliationDecision[] } {
  const decisions: OwnershipReconciliationDecision[] = [];
  const reconciled = commitments.map((commitment) => {
    const resolved = resolvePrimaryOwner(commitment);
    decisions.push({
      commitment_ref: commitment.ref,
      disposition: resolved.repaired ? "repaired" : "kept",
      previous_owner: commitment.owner,
      resolved_owner: resolved.owner,
      reason: resolved.reason
    });
    if (!resolved.repaired) return commitment;
    return { ...commitment, owner: resolved.owner, primary_owner_reason: resolved.reason };
  });
  return { commitments: reconciled, decisions };
}

// ============================================================
// Acceptance-criteria consolidation (no model call)
// ============================================================

/** Generic acceptance-criterion scaffolding words that appear regardless of topic ("include a
 * section explaining...", "add a page about...") and would otherwise dilute token-overlap ratios
 * with boilerplate rather than topical content. Deliberately narrower/different from graph.ts's
 * general-purpose semanticTokenSimilarity -- criteria are short, templated phrases where this
 * scaffolding vocabulary dominates unless stripped, which general task/commitment titles don't
 * suffer from to the same degree. */
const CRITERION_STOPWORDS = new Set([
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
  "include",
  "including",
  "includes",
  "add",
  "adding",
  "added",
  "have",
  "has",
  "having",
  "use",
  "using",
  "used",
  "website",
  "site",
  "page",
  "pages",
  "section",
  "sections",
  "content",
  "relevant",
  "requirement",
  "requirements",
  "information",
  "product",
  "provide",
  "providing"
]);

function criterionTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((token) => token.length > 2 && !CRITERION_STOPWORDS.has(token))
  );
}

function criterionText(item: WorkItem): string {
  return item.description ? `${item.title} ${item.description}` : item.title;
}

const CRITERION_MERGE_THRESHOLD = 0.2;

/** "If criterion A were satisfied, would criterion B also substantially be satisfied?" -- proxied
 * deterministically as: after stripping generic scaffolding vocabulary, do the two criteria still
 * share meaningful topical content? Deliberately conservative (see CRITERION_MERGE_THRESHOLD):
 * over-merging distinct criteria is worse than leaving a near-duplicate unmerged. */
function criteriaEquivalent(a: WorkItem, b: WorkItem): boolean {
  const ta = criterionTokens(criterionText(a));
  const tb = criterionTokens(criterionText(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  return intersection / Math.max(ta.size, tb.size) >= CRITERION_MERGE_THRESHOLD;
}

/** "Strongest wording" = richest existing text (title + description length) among the cluster,
 * not a synthesized new phrase -- deterministic, no model call. Ties broken by ref for stability. */
function strongestCriterion(items: WorkItem[]): WorkItem {
  return [...items].sort((a, b) => {
    const lengthA = a.title.length + (a.description?.length ?? 0);
    const lengthB = b.title.length + (b.description?.length ?? 0);
    if (lengthA !== lengthB) return lengthB - lengthA;
    return a.ref.localeCompare(b.ref);
  })[0];
}

/** First-match-wins clustering, same deterministic/order-stable style as task-consolidation's
 * buildClusters -- never depends on a model to decide which criteria are even worth comparing. */
function clusterCriteria(criteria: WorkItem[]): WorkItem[][] {
  const clusters: WorkItem[][] = [];
  for (const criterion of criteria) {
    const existing = clusters.find((cluster) =>
      cluster.some((member) => criteriaEquivalent(member, criterion))
    );
    if (existing) existing.push(criterion);
    else clusters.push([criterion]);
  }
  return clusters;
}

function consolidateAcceptanceCriteria(
  commitments: ExecutionTree["commitments"]
): { commitments: ExecutionTree["commitments"]; decisions: AcceptanceCriteriaConsolidationDecision[] } {
  const decisions: AcceptanceCriteriaConsolidationDecision[] = [];
  const reconciled = commitments.map((commitment) => {
    if (commitment.acceptance_criteria.length < 2) return commitment;
    const clusters = clusterCriteria(commitment.acceptance_criteria);
    const mergedCriteria: WorkItem[] = [];
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        decisions.push({
          commitment_ref: commitment.ref,
          disposition: "kept",
          canonical_ref: cluster[0].ref,
          canonical_title: cluster[0].title,
          merged_from_refs: [],
          reason: "No other acceptance criterion on this commitment is substantially equivalent."
        });
        mergedCriteria.push(cluster[0]);
        continue;
      }
      const canonical = strongestCriterion(cluster);
      const others = cluster.filter((item) => item.ref !== canonical.ref);
      const mergedSegmentIds = Array.from(
        new Set(cluster.flatMap((item) => item.source_segment_ids))
      );
      const merged: WorkItem = { ...canonical, source_segment_ids: mergedSegmentIds };
      decisions.push({
        commitment_ref: commitment.ref,
        disposition: "merged",
        canonical_ref: canonical.ref,
        canonical_title: canonical.title,
        merged_from_refs: others.map((item) => item.ref),
        reason: `Merged ${cluster.length} substantially-equivalent acceptance criteria (${cluster
          .map((item) => `"${item.title}"`)
          .join(", ")}) into one canonical criterion, retaining the strongest wording and the union of source evidence.`
      });
      mergedCriteria.push(merged);
    }
    return {
      ...commitment,
      acceptance_criteria: mergedCriteria,
      acceptance_criteria_refs: mergedCriteria.map((item) => item.ref)
    };
  });
  return { commitments: reconciled, decisions };
}

// ============================================================
// Contextual date cleanup (a secondary date must never read as the commitment deadline)
// ============================================================

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};
const MONTH_NAME_PATTERN = Object.keys(MONTH_INDEX).join("|");
const MONTH_DATE_PATTERN = new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, "gi");
const DEADLINE_FRAMING_PATTERN = /\b(deadline|due(?:\s+date)?|needed by|must be (done|ready|delivered) by)\b/i;

function splitClauses(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).filter((clause) => clause.trim().length > 0);
}

/** True when `clause` states a month/day date that conflicts with the commitment's already-
 * resolved due_date, in the same clause as deadline-framing language ("deadline", "due", "needed
 * by") -- i.e. a secondary/contextual date being misphrased as if it were the commitment's own
 * deadline. A date mentioned for any other reason, or one that matches due_date, is left alone. */
function clauseConflictsWithDueDate(clause: string, dueDateIso: string): boolean {
  if (!DEADLINE_FRAMING_PATTERN.test(clause)) return false;
  const dueYear = dueDateIso.slice(0, 4);
  const dueMonth = Number(dueDateIso.slice(5, 7));
  const dueDay = Number(dueDateIso.slice(8, 10));
  const matches = clause.matchAll(MONTH_DATE_PATTERN);
  for (const match of matches) {
    const monthIndex = MONTH_INDEX[match[1].toLowerCase()];
    const day = Number(match[2]);
    if (monthIndex + 1 !== dueMonth || day !== dueDay) {
      void dueYear; // same-year assumption is documented above; nothing further to compare
      return true;
    }
  }
  return false;
}

/** Strips (never rejects the whole commitment for) a description clause that phrases a secondary,
 * non-matching date as if it were the commitment's own deadline once due_date is already resolved
 * -- same "clear rather than leave misleading" posture as reconcileCommitmentDescriptions. */
function reconcileCommitmentDates(
  commitments: ExecutionTree["commitments"]
): { commitments: ExecutionTree["commitments"]; decisions: CommitmentReconciliationDecision[] } {
  const decisions: CommitmentReconciliationDecision[] = [];
  const reconciled = commitments.map((commitment) => {
    if (!commitment.description || !commitment.due_date) {
      decisions.push({
        commitment_ref: commitment.ref,
        disposition: "kept",
        reason: "No description or no resolved due_date to validate a conflicting deadline against."
      });
      return commitment;
    }
    const clauses = splitClauses(commitment.description);
    const conflicting = clauses.filter((clause) => clauseConflictsWithDueDate(clause, commitment.due_date!));
    if (conflicting.length === 0) {
      decisions.push({
        commitment_ref: commitment.ref,
        disposition: "kept",
        reason: "Description contains no date phrased as a deadline that conflicts with the resolved due_date."
      });
      return commitment;
    }
    const survivingClauses = clauses.filter((clause) => !conflicting.includes(clause));
    const newDescription = survivingClauses.join(" ").trim() || null;
    decisions.push({
      commitment_ref: commitment.ref,
      disposition: "deadline_clause_stripped",
      reason: `Description phrased a secondary date as the commitment's own deadline, conflicting with the resolved due_date (${commitment.due_date}); stripped clause(s): ${conflicting.map((clause) => `"${clause.trim()}"`).join(", ")}.`
    });
    return { ...commitment, description: newDescription };
  });
  return { commitments: reconciled, decisions };
}

export function reconcileFinalGraph(input: { tree: ExecutionTree }): FinalReconciliationResult {
  const { commitments: dedupedCommitments, standaloneTasks, decisions: standaloneDecisions } =
    reconcileStandaloneDuplicates(input.tree);
  const { commitments: criteriaConsolidated, decisions: acceptanceCriteriaDecisions } =
    consolidateAcceptanceCriteria(dedupedCommitments);
  const { commitments: ownershipRepaired, decisions: ownershipDecisions } =
    reconcileCommitmentOwnership(criteriaConsolidated);
  const { commitments: descriptionCleaned, decisions: commitmentDecisions } =
    reconcileCommitmentDescriptions(ownershipRepaired);
  const { commitments: finalCommitments, decisions: dateDecisions } =
    reconcileCommitmentDates(descriptionCleaned);

  return {
    tree: { commitments: finalCommitments, standalone_tasks: standaloneTasks },
    commitmentDecisions,
    standaloneDecisions,
    ownershipDecisions,
    acceptanceCriteriaDecisions,
    dateDecisions
  };
}
