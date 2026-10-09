import { formatReadableDate } from "@/lib/format-date";

import type { WorkspaceAuditEntityType } from "./audit";

/**
 * Generalized from lib/project-brain/direct-commitment-edit.ts's
 * buildDirectEditConfirmationMessage to also describe task and project edits. Deterministic --
 * no second LLM call just to phrase a confirmation. Never includes a UUID, raw field name, JSON,
 * or internal operation type; see the CHAT RESPONSE / UI requirements this was written against.
 */
export type ConfirmedEntityChange = {
  kind: WorkspaceAuditEntityType;
  title: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changes: Record<string, unknown>;
};

function titleField(kind: WorkspaceAuditEntityType): string {
  if (kind === "task") return "task";
  if (kind === "project") return "name";
  return "title";
}

function ownerField(kind: WorkspaceAuditEntityType): string | null {
  return kind === "project" ? null : "owner";
}

function fieldClause(kind: WorkspaceAuditEntityType, field: string, changes: Record<string, unknown>): string | null {
  if (field === titleField(kind)) {
    return `renamed it to "${changes[field]}"`;
  }
  if (field === "description") return "updated the description";
  if (field === ownerField(kind)) {
    return changes[field] ? `made ${changes[field]} the owner` : "unassigned the owner";
  }
  if (field === "due_date") {
    const formatted = formatReadableDate(changes.due_date as string | null);
    return formatted ? `moved the due date to ${formatted}` : "cleared the due date";
  }
  if (field === "priority") return `set the priority to ${changes.priority}`;
  if (field === "goal") return "updated the goal";
  if (field === "status") {
    // Commitments/tasks get the completion-aware phrasing below instead, so status doesn't
    // also produce a generic "set the status to completed" clause alongside "marked it
    // complete". Projects have their own status enum (planning/active/on_hold/completed/
    // archived) with no equivalent completion/reopen framing -- always generic here.
    return kind === "project" ? `set the status to ${String(changes.status).replace("_", " ")}` : null;
  }
  return null;
}

function completionClause(
  kind: WorkspaceAuditEntityType,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string | null {
  if (kind === "project") return null;
  const beforeStatus = before.status as string | undefined;
  const afterStatus = after.status as string | undefined;
  if (beforeStatus === afterStatus) return null;
  if (afterStatus === "completed") return "marked it complete";
  if (beforeStatus === "completed" || beforeStatus === "dismissed") return "reopened it";
  if (afterStatus === "dismissed") return "dismissed it";
  return `set the status to ${String(afterStatus).replace("_", " ")}`;
}

export function buildWorkspaceConfirmationMessage(applied: ConfirmedEntityChange[]): string {
  const perEntity = applied.map((entity) => {
    const fieldClauses = Object.keys(entity.changes)
      .map((field) => fieldClause(entity.kind, field, entity.changes))
      .filter((clause): clause is string => Boolean(clause));
    const statusClause = completionClause(entity.kind, entity.before, entity.after);
    const clauses = [...fieldClauses, ...(statusClause ? [statusClause] : [])];
    return { title: entity.title, clauses };
  });

  if (perEntity.length === 1 && perEntity[0].clauses.length > 0) {
    const { title, clauses } = perEntity[0];
    return `Done — I ${joinClauses(clauses)} for "${title}".`;
  }

  const summaries = perEntity
    .filter((entity) => entity.clauses.length > 0)
    .map((entity) => `${joinClauses(entity.clauses)} for "${entity.title}"`);
  return `Done — I ${joinClauses(summaries)}.`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) return "made no changes";
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}
