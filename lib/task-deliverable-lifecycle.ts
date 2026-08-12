import type { TaskArtifact } from "@/lib/types";

/** Display-level lifecycle state, derived rather than stored -- `status` on task_artifacts
 * tracks *how* a version's content was produced (generated | edited | failed); acceptance is a
 * separate, orthogonal fact recorded via accepted_at. This collapses both into the three states
 * the product actually talks about (see Phase 7 lifecycle: GENERATING is a transient client-side
 * state, never persisted). */
export type DeliverableLifecycleState = "draft" | "accepted" | "failed";

export function getDeliverableLifecycleState(
  artifact: Pick<TaskArtifact, "status" | "accepted_at">
): DeliverableLifecycleState {
  if (artifact.status === "failed") return "failed";
  if (artifact.accepted_at) return "accepted";
  return "draft";
}

export function isAcceptedDeliverable(
  artifact: Pick<TaskArtifact, "accepted_at">
): boolean {
  return Boolean(artifact.accepted_at);
}

export type DeliverableGroup = {
  deliverableType: string;
  /** Latest non-failed version -- what the product treats as "the deliverable" for this type. */
  current: TaskArtifact | null;
  /** Set when the single most recent attempt (by version) failed and is newer than `current`,
   * so a transient "last regeneration failed" notice can be shown without losing the last good
   * version underneath it. */
  latestFailed: TaskArtifact | null;
  /** All versions for this type, newest first, including `current` -- the version-history list. */
  history: TaskArtifact[];
};

/** Groups a task's artifacts by deliverable_type (each type is its own deliverable lineage;
 * versions within a type come from generation, regeneration, edits, and restores). Rows with a
 * null/missing deliverable_type are grouped under "" so nothing is silently dropped. */
export function groupDeliverablesByType(artifacts: TaskArtifact[]): DeliverableGroup[] {
  const byType = new Map<string, TaskArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifact.deliverable_type ?? "";
    byType.set(key, [...(byType.get(key) ?? []), artifact]);
  }

  const groups: DeliverableGroup[] = [];
  for (const [deliverableType, items] of byType.entries()) {
    const history = [...items].sort((a, b) => b.version - a.version);
    const current = history.find((item) => item.status !== "failed") ?? null;
    const latestFailed =
      history[0] && history[0].status === "failed" && history[0].id !== current?.id
        ? history[0]
        : null;
    groups.push({ deliverableType, current, latestFailed, history });
  }

  // Most recently active deliverable lineage first (by its newest row's created_at).
  return groups.sort((a, b) => {
    const aTime = a.history[0]?.created_at ?? "";
    const bTime = b.history[0]?.created_at ?? "";
    return bTime.localeCompare(aTime);
  });
}

export function findDeliverableGroup(
  artifacts: TaskArtifact[],
  deliverableType: string | null | undefined
): DeliverableGroup | null {
  return groupDeliverablesByType(artifacts).find(
    (group) => group.deliverableType === (deliverableType ?? "")
  ) ?? null;
}

/**
 * THE canonical task-completion invariant (see Phase 7 multi-deliverable audit):
 *
 *   A task is considered completed by the deliverable lifecycle when AT LEAST ONE CURRENT
 *   deliverable for that task is accepted.
 *
 * "Current" = the latest non-failed version per (task_id, deliverable_type) -- see
 * groupDeliverablesByType. A version that was accepted but has since been superseded by a
 * newer draft no longer counts: it's historical, not current. Different deliverable types are
 * independent, so accepting/reopening one never affects whether another type's current version
 * still satisfies this rule.
 *
 * This is deliberately the single place this check is expressed in TypeScript. The
 * task_has_accepted_current_deliverable SQL function (see the Phase 7.1 migration) implements
 * the identical rule for the actual database writes (accept/reopen/create_deliverable_version)
 * -- this TS version exists for client-side preview/tests, not as a second source of truth the
 * server trusts.
 */
export function taskHasAcceptedCurrentDeliverable(artifacts: TaskArtifact[]): boolean {
  return groupDeliverablesByType(artifacts).some(
    (group) => group.current !== null && isAcceptedDeliverable(group.current)
  );
}
