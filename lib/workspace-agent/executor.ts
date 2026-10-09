import { applyCommitmentPatch } from "@/lib/commitment-mutations";
import { applyProjectPatch } from "@/lib/project-mutations";
import { applyTaskPatch } from "@/lib/task-mutations";
import type { MeetingCommitment, MeetingTask, Project } from "@/lib/types";

import { recordWorkspaceAuditEvent, type WorkspaceAuditSourceType } from "./audit";
import { resolveAndAuthorizeOperation, targetRefFor, type AuthorizedTarget } from "./authorize";
import { buildWorkspaceConfirmationMessage } from "./confirmation";
import { hasExplicitWorkspaceMutationIntent } from "./intent-gate";
import type { WorkspaceScope } from "./scope";
import type { WorkspaceOperation } from "./schema";

/**
 * The one place a Parfait chat surface's resolved operations become real database writes.
 * Generalizes lib/project-brain/direct-commitment-edit.ts's executeDirectCommitmentEdits to all
 * three entity kinds. No chat route calls this yet in Patch 1B -- see the patch report for the
 * migration plan.
 *
 * Hard invariants enforced here, not negotiable by any caller:
 *   - every write goes through applyCommitmentPatch / applyTaskPatch / applyProjectPatch --
 *     never a raw `.from("meeting_commitments"|"meeting_tasks").update(...)` in this file;
 *   - execution requires BOTH an operation list AND explicit mutation intent on the actual
 *     user message (hasExplicitWorkspaceMutationIntent) -- a well-formed operation with no
 *     explicit request behind it never executes;
 *   - every target is re-resolved and re-authorized against the scope and the authenticated
 *     user immediately before its write, never trusting a model-emitted id or an earlier pass;
 *   - a failed mutation is reported as failed, never silently dropped or reported as applied.
 */

export type TouchedEntity =
  | { kind: "commitment"; id: string; meetingId: string }
  | { kind: "task"; id: string; commitmentId: string | null; meetingId: string }
  | { kind: "project"; id: string };

export type AppliedWorkspaceOperation = {
  /** The last operation in this entity's group to contribute a field -- kept for traceability;
   * `changes` below is already the fully merged patch actually written. */
  operation: WorkspaceOperation;
  kind: "commitment" | "task" | "project";
  id: string;
  /** Full pre/post row state, for audit and confirmation-building. Callers deciding what to
   * forward to a browser client should select specific fields rather than passing this through
   * wholesale -- it includes internal bookkeeping columns (manual_override_fields, etc). */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changes: Record<string, unknown>;
};

export type FailedWorkspaceOperation = {
  operation: WorkspaceOperation;
  reason: "not_found" | "outside_scope" | "persistence_failed";
  message: string;
};

export type WorkspaceExecutionResult = {
  /** True iff explicit mutation intent was present and at least one operation group was
   * attempted -- false means the caller should fall back to its existing non-direct behavior
   * (answer/clarification/proposal) rather than treat this as "nothing to do." */
  executed: boolean;
  appliedOperations: AppliedWorkspaceOperation[];
  failedOperations: FailedWorkspaceOperation[];
  touchedEntities: TouchedEntity[];
  confirmation: string | null;
};

function emptyResult(): WorkspaceExecutionResult {
  return { executed: false, appliedOperations: [], failedOperations: [], touchedEntities: [], confirmation: null };
}

function patchFieldsFor(operation: WorkspaceOperation): Record<string, unknown> {
  switch (operation.type) {
    case "update_commitment":
      return operation.changes;
    case "complete_commitment":
      return { status: "completed" };
    case "reopen_commitment":
      return { status: "pending" };
    case "dismiss_commitment":
      return { status: "dismissed" };
    case "update_task":
      return operation.changes;
    case "complete_task":
      return { status: "completed" };
    case "reopen_task":
      return { status: "pending" };
    case "dismiss_task":
      return { status: "dismissed" };
    case "assign_task_owner":
      return { owner: operation.owner };
    case "update_project":
      return operation.changes;
  }
}

type OperationGroup = {
  kind: "commitment" | "task" | "project";
  id: string;
  changes: Record<string, unknown>;
  operations: WorkspaceOperation[];
};

/** "Make Kevin the owner and move the due date to Friday" should be one write, not two, even if
 * the agent emitted it as two operations against the same entity -- groups by (kind, id),
 * preserving first-seen order, merging `changes` shallowly (a later operation's value for a
 * field wins over an earlier one's). */
function groupOperations(operations: WorkspaceOperation[]): OperationGroup[] {
  const order: string[] = [];
  const groups = new Map<string, OperationGroup>();
  for (const operation of operations) {
    const ref = targetRefFor(operation);
    const key = `${ref.kind}:${ref.id}`;
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, { kind: ref.kind, id: ref.id, changes: {}, operations: [] });
    }
    const group = groups.get(key)!;
    Object.assign(group.changes, patchFieldsFor(operation));
    group.operations.push(operation);
  }
  return order.map((key) => groups.get(key)!);
}

function beforeStateOf(target: AuthorizedTarget): Record<string, unknown> {
  if (target.kind === "commitment") return target.commitment as unknown as Record<string, unknown>;
  if (target.kind === "task") return target.task as unknown as Record<string, unknown>;
  return target.project as unknown as Record<string, unknown>;
}

type MutationOutcome =
  | { kind: "commitment"; entity: MeetingCommitment }
  | { kind: "task"; entity: MeetingTask }
  | { kind: "project"; entity: Project }
  | { error: string };

async function applyCanonicalMutation(
  kind: "commitment" | "task" | "project",
  id: string,
  changes: Record<string, unknown>
): Promise<MutationOutcome> {
  if (kind === "commitment") {
    const result = await applyCommitmentPatch(id, changes);
    return "error" in result ? { error: result.error } : { kind: "commitment", entity: result.commitment };
  }
  if (kind === "task") {
    const result = await applyTaskPatch(id, changes);
    return "error" in result ? { error: result.error } : { kind: "task", entity: result.task };
  }
  const result = await applyProjectPatch(id, changes);
  return "error" in result ? { error: result.error } : { kind: "project", entity: result.project };
}

function scopeIdsFor(outcome: Exclude<MutationOutcome, { error: string }>): {
  projectId: string | null;
  meetingId: string | null;
} {
  if (outcome.kind === "commitment") {
    return { projectId: outcome.entity.project_id ?? null, meetingId: outcome.entity.meeting_id };
  }
  if (outcome.kind === "task") {
    return { projectId: outcome.entity.project_id ?? null, meetingId: outcome.entity.meeting_id };
  }
  return { projectId: outcome.entity.id, meetingId: null };
}

function titleOf(kind: "commitment" | "task" | "project", state: Record<string, unknown>): string {
  if (kind === "task") return String(state.task ?? "Task");
  if (kind === "project") return String(state.name ?? "Project");
  return String(state.title ?? "Commitment");
}

export async function executeWorkspaceOperations(input: {
  operations: WorkspaceOperation[];
  scope: WorkspaceScope;
  userId: string;
  source: WorkspaceAuditSourceType;
  sourceId: string | null;
  userMessage: string;
}): Promise<WorkspaceExecutionResult> {
  if (input.operations.length === 0) return emptyResult();
  if (!hasExplicitWorkspaceMutationIntent(input.userMessage)) return emptyResult();

  const groups = groupOperations(input.operations);
  const appliedOperations: AppliedWorkspaceOperation[] = [];
  const failedOperations: FailedWorkspaceOperation[] = [];

  for (const group of groups) {
    // Every operation in a group targets the identical (kind, id) under the identical scope, so
    // one authorization check covers the whole group -- but it is still a FRESH check, re-run
    // per group, never reused from an earlier request or a different group.
    const authResult = await resolveAndAuthorizeOperation(group.operations[0], input.scope, input.userId);
    if (!authResult.ok) {
      const message =
        authResult.reason === "not_found"
          ? "That item could not be found."
          : "That item is outside the current scope.";
      for (const operation of group.operations) {
        failedOperations.push({ operation, reason: authResult.reason, message });
      }
      continue;
    }

    const before = beforeStateOf(authResult.target);
    const outcome = await applyCanonicalMutation(group.kind, group.id, group.changes);
    if ("error" in outcome) {
      for (const operation of group.operations) {
        failedOperations.push({ operation, reason: "persistence_failed", message: outcome.error });
      }
      continue;
    }

    const after = outcome.entity as unknown as Record<string, unknown>;
    appliedOperations.push({
      operation: group.operations[group.operations.length - 1],
      kind: group.kind,
      id: group.id,
      before,
      after,
      changes: group.changes
    });

    const { projectId, meetingId } = scopeIdsFor(outcome);
    await recordWorkspaceAuditEvent({
      actorId: input.userId,
      projectId,
      meetingId,
      entityType: group.kind,
      entityId: group.id,
      eventType: group.operations[0].type,
      beforeState: before,
      afterState: after,
      sourceType: input.source,
      sourceId: input.sourceId
    });
  }

  const touchedEntities: TouchedEntity[] = appliedOperations.map((item) => {
    if (item.kind === "commitment") {
      return { kind: "commitment", id: item.id, meetingId: item.after.meeting_id as string };
    }
    if (item.kind === "task") {
      return {
        kind: "task",
        id: item.id,
        commitmentId: (item.after.commitment_id as string | null) ?? null,
        meetingId: item.after.meeting_id as string
      };
    }
    return { kind: "project", id: item.id };
  });

  const confirmation =
    appliedOperations.length > 0
      ? buildWorkspaceConfirmationMessage(
          appliedOperations.map((item) => ({
            kind: item.kind,
            title: titleOf(item.kind, item.after),
            before: item.before,
            after: item.after,
            changes: item.changes
          }))
        )
      : null;

  return { executed: true, appliedOperations, failedOperations, touchedEntities, confirmation };
}
