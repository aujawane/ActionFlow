import { semanticTokenSimilarity } from "./graph";
import type { RawWorkItem, WorkItem } from "./work-item-schemas";

export type ScopedWorkItem = RawWorkItem & {
  topic_id: string | null;
  merge_conflict_classifications?: string[];
};

export type TopicWorkItemExtraction = {
  topicId: string | null;
  topicTitle: string;
  transcript: string;
  items: RawWorkItem[];
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}

function normalizedOwners(item: Pick<ScopedWorkItem, "owner" | "owners">) {
  return new Set(
    [item.owner, ...item.owners]
      .filter((owner): owner is string => Boolean(owner?.trim()))
      .map((owner) => owner.trim().toLowerCase())
  );
}

function ownersCompatible(left: ScopedWorkItem, right: ScopedWorkItem) {
  const a = normalizedOwners(left);
  const b = normalizedOwners(right);
  if (a.size === 0 || b.size === 0) return true;
  return Array.from(a).some((owner) => b.has(owner));
}

function sharesEvidence(left: ScopedWorkItem, right: ScopedWorkItem) {
  const ids = new Set(left.source_segment_ids);
  return right.source_segment_ids.some((id) => ids.has(id));
}

/** The same segment IDs and materially the same quote mean the same underlying utterance --
 * dedupe unconditionally, even if the two extraction passes disagreed on classification. */
function isExactEvidenceMatch(left: ScopedWorkItem, right: ScopedWorkItem) {
  return (
    sameIdSet(left.source_segment_ids, right.source_segment_ids) &&
    normalizeText(left.source_quote) === normalizeText(right.source_quote)
  );
}

function isNearDuplicateWorkItem(left: ScopedWorkItem, right: ScopedWorkItem) {
  if (left.classification !== right.classification) return false;
  if (left.status !== right.status) return false;
  const similarity = semanticTokenSimilarity(left.title, right.title);
  return (
    (similarity >= 0.82 || (sharesEvidence(left, right) && similarity >= 0.65)) &&
    ownersCompatible(left, right)
  );
}

function isDuplicateWorkItem(left: ScopedWorkItem, right: ScopedWorkItem) {
  return isExactEvidenceMatch(left, right) || isNearDuplicateWorkItem(left, right);
}

function mergeWorkItemPair(left: ScopedWorkItem, right: ScopedWorkItem): ScopedWorkItem {
  const preferred = (right.confidence ?? 0) > (left.confidence ?? 0) ? right : left;
  const other = preferred === left ? right : left;
  const owners = Array.from(
    new Set([
      ...preferred.owners,
      ...other.owners,
      ...(preferred.owner ? [preferred.owner] : []),
      ...(other.owner ? [other.owner] : [])
    ])
  );
  const conflictSeed = preferred.merge_conflict_classifications ?? [preferred.classification];
  const mergeConflictClassifications =
    preferred.classification !== other.classification
      ? Array.from(new Set([...conflictSeed, other.classification]))
      : preferred.merge_conflict_classifications;
  return {
    ...preferred,
    owner: preferred.owner ?? other.owner ?? owners[0] ?? null,
    owners,
    source_segment_ids: Array.from(
      new Set([...preferred.source_segment_ids, ...other.source_segment_ids])
    ),
    merge_conflict_classifications: mergeConflictClassifications
  };
}

/**
 * Deterministically merges topic-scoped work items into one meeting-wide, canonically-ref'd
 * ledger. Two mentions of the exact same evidence (same segment IDs, same quote) are always
 * merged even if the two extraction passes disagreed on classification -- the global correction
 * stage, which sees the whole ledger at once, has final say on classification; this function only
 * preserves both original values in `merge_conflict_classifications` for debugging. Two items that
 * are merely similar (not the same evidence) are only merged when their classification and status
 * already agree, so completed work never merges with open work and a proposal never merges with an
 * accepted action. Identity is always assigned here -- the model never owns a work item's ref.
 */
export function mergeTopicWorkItems(topics: TopicWorkItemExtraction[]): {
  items: WorkItem[];
  deduplicated: number;
} {
  const scoped: ScopedWorkItem[] = topics.flatMap((topic) =>
    topic.items.map((item) => ({ ...item, topic_id: topic.topicId }))
  );
  const merged: ScopedWorkItem[] = [];
  let deduplicated = 0;
  for (const item of scoped) {
    const duplicateIndex = merged.findIndex((candidate) =>
      isDuplicateWorkItem(candidate, item)
    );
    if (duplicateIndex === -1) {
      merged.push(item);
      continue;
    }
    merged[duplicateIndex] = mergeWorkItemPair(merged[duplicateIndex], item);
    deduplicated += 1;
  }
  return {
    items: merged.map((item, index) => ({ ...item, ref: `wi_${index + 1}` })),
    deduplicated
  };
}
