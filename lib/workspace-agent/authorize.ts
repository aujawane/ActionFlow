import { getOwnedCommitment, getOwnedProject, getOwnedTask } from "@/lib/project-access";
import type { MeetingCommitment, MeetingTask, Project } from "@/lib/types";

import type { WorkspaceScope } from "./scope";
import type { WorkspaceOperation } from "./schema";

export type AuthorizedTarget =
  | { kind: "commitment"; commitment: MeetingCommitment }
  | { kind: "task"; task: MeetingTask }
  | { kind: "project"; project: Project };

export type AuthorizeResult =
  | { ok: true; target: AuthorizedTarget }
  | { ok: false; reason: "not_found" | "outside_scope" };

export function targetRefFor(operation: WorkspaceOperation): { kind: "commitment" | "task" | "project"; id: string } {
  switch (operation.type) {
    case "update_commitment":
    case "complete_commitment":
    case "reopen_commitment":
    case "dismiss_commitment":
      return { kind: "commitment", id: operation.commitmentId };
    case "update_task":
    case "complete_task":
    case "reopen_task":
    case "dismiss_task":
    case "assign_task_owner":
      return { kind: "task", id: operation.taskId };
    case "update_project":
      return { kind: "project", id: operation.projectId };
  }
}

/** Conservative for Patch 1B: a scope only authorizes operations on itself and on entities that
 * are DIRECTLY, structurally part of its own chain (parent/child), never sibling traversal or
 * project-wide search by name. A meeting scope may reach any commitment/task in that meeting; a
 * commitment scope may reach itself and tasks that belong to it; a task scope may reach itself
 * and its own parent commitment; a project scope may reach any commitment/task that belongs to
 * that project. Broader cross-entity traversal (e.g. a commitment scope reaching a sibling
 * commitment in the same meeting) is intentionally not supported here -- see the Patch 1B report. */
function commitmentWithinScope(commitment: MeetingCommitment, scope: WorkspaceScope): boolean {
  switch (scope.type) {
    case "project":
      return scope.projectId !== null && commitment.project_id === scope.projectId;
    case "meeting":
      return commitment.meeting_id === scope.meetingId;
    case "commitment":
      return commitment.id === scope.commitmentId;
    case "task":
      return scope.commitmentId !== null && commitment.id === scope.commitmentId;
  }
}

function taskWithinScope(task: MeetingTask, scope: WorkspaceScope): boolean {
  switch (scope.type) {
    case "project":
      return scope.projectId !== null && task.project_id === scope.projectId;
    case "meeting":
      return task.meeting_id === scope.meetingId;
    case "commitment":
      return task.commitment_id === scope.commitmentId;
    case "task":
      return task.id === scope.taskId;
  }
}

function projectWithinScope(project: Project, scope: WorkspaceScope): boolean {
  // Only a project-scoped surface may target the project entity itself in Patch 1B -- a
  // meeting/commitment/task-scoped surface has no update_project operation to emit in the
  // first place (there is no legitimate "edit the whole project" action from inside one
  // meeting), so this is never reached from those scopes today, but stays explicit rather than
  // defaulting to true.
  return scope.type === "project" && project.id === scope.projectId;
}

/**
 * Resolves a WorkspaceOperation's target AND proves, independently of any earlier validation
 * pass, that (a) the authenticated user owns it and (b) it belongs to the caller's
 * server-derived scope. Ownership is re-checked here via the same getOwnedCommitment/
 * getOwnedTask/getOwnedProject primitives used everywhere else in the app -- never trusting a
 * model-emitted id by itself, and never reusing an ownership result computed earlier in the
 * request. getOwnedX already returns the same "not found" result whether the id doesn't exist
 * or belongs to another user, so a cross-user id can never be distinguished from a nonexistent
 * one by the caller.
 */
export async function resolveAndAuthorizeOperation(
  operation: WorkspaceOperation,
  scope: WorkspaceScope,
  userId: string
): Promise<AuthorizeResult> {
  const ref = targetRefFor(operation);

  if (ref.kind === "commitment") {
    const commitment = await getOwnedCommitment(ref.id, userId);
    if (!commitment) return { ok: false, reason: "not_found" };
    if (!commitmentWithinScope(commitment, scope)) return { ok: false, reason: "outside_scope" };
    return { ok: true, target: { kind: "commitment", commitment } };
  }

  if (ref.kind === "task") {
    const task = await getOwnedTask(ref.id, userId);
    if (!task) return { ok: false, reason: "not_found" };
    if (!taskWithinScope(task, scope)) return { ok: false, reason: "outside_scope" };
    return { ok: true, target: { kind: "task", task } };
  }

  const project = await getOwnedProject(ref.id, userId);
  if (!project) return { ok: false, reason: "not_found" };
  if (!projectWithinScope(project, scope)) return { ok: false, reason: "outside_scope" };
  return { ok: true, target: { kind: "project", project } };
}
