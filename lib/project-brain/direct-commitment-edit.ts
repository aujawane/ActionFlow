import { applyCommitmentPatch } from "@/lib/commitment-mutations";
import { formatReadableDate } from "@/lib/format-date";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hasExplicitWorkspaceMutationIntent } from "@/lib/workspace-agent/intent-gate";
import type { MeetingCommitment } from "@/lib/types";

import { normalizeOperationsForApply } from "./operations";
import type { ProjectChangeOperation } from "./schemas";

/**
 * V1 direct-execution fast path for Parfait Brain: explicit, low-risk EDITS to an EXISTING
 * commitment's own fields. Deliberately narrow -- everything else (create_milestone,
 * merge_milestones, archive_milestone/defer_milestone, any task operation, person-identity
 * corrections, requirements/decisions/constraints) still goes through the existing
 * pending_review -> "Approve & apply" proposal flow unchanged. See the module doc on
 * isDirectCommitmentEditEligible for exactly where that line is drawn.
 *
 * This never writes to meeting_commitments itself: every write goes through
 * applyCommitmentPatch (lib/commitment-mutations.ts), the same canonical path the direct
 * commitment-management UI (components/commitment-correction-menu.tsx) uses, so there is still
 * exactly one commitment lifecycle implementation. In particular this means status/
 * completion_state normalization is NOT reimplemented here -- applyCommitmentPatch's
 * deriveCommitmentLifecyclePatch already does that.
 */

type UpdateMilestoneOperation = Extract<ProjectChangeOperation, { type: "update_milestone" }>;

/** Only update_milestone (after normalizeOperationsForApply folds rename_milestone into it) is
 * eligible for direct execution. Anything else in the batch -- even one archive_milestone or
 * update_task alongside several innocuous update_milestones -- sends the WHOLE batch through the
 * existing review flow rather than partially auto-applying some operations and proposing the
 * rest, which would be confusing and harder to reason about than "simple edits execute, anything
 * more complex gets reviewed." */
export function isDirectCommitmentEditEligible(
  operations: ProjectChangeOperation[]
): operations is UpdateMilestoneOperation[] {
  return (
    operations.length > 0 &&
    operations.every((operation) => operation.type === "update_milestone")
  );
}

/**
 * Thin re-export of the now-shared, generalized gate (lib/workspace-agent/intent-gate.ts) --
 * promoted from this file's own original copy once the generalized version was verified
 * byte-for-byte behavior compatible (same block/positive patterns; the shared version's wider
 * verb list only adds create/add/delete/remove/accept, none of which change the outcome for any
 * phrasing this module's existing tests already cover). Kept under its original name here so
 * the Project Brain route's existing import is untouched -- this patch does not change Project
 * Brain's user-visible behavior, only where the gate's implementation lives. */
export const hasExplicitCommitmentMutationIntent = hasExplicitWorkspaceMutationIntent;

/** Normalizes a raw proposal's operations and reports whether the result is direct-edit
 * eligible, so callers don't have to remember to normalize first. */
export function prepareDirectCommitmentEdits(operations: ProjectChangeOperation[]) {
  const normalized = normalizeOperationsForApply(operations);
  return {
    normalized,
    eligible: isDirectCommitmentEditEligible(normalized)
  };
}

type MergedEdit = {
  commitmentId: string;
  changes: Record<string, unknown>;
};

/** "Make Kevin the owner and move the due date to Friday" should be one commitment update, not
 * two separate writes -- the model may also emit it as two update_milestone operations against
 * the same commitment, since a single edit per fact is a reasonable thing for it to produce.
 * Groups by commitmentId (first-seen order preserved for the confirmation message) and
 * shallow-merges `changes`, with a later operation's value for a field winning over an earlier
 * one's. */
export function mergeDirectCommitmentEdits(operations: UpdateMilestoneOperation[]): MergedEdit[] {
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const operation of operations) {
    if (!byId.has(operation.milestoneId)) {
      order.push(operation.milestoneId);
      byId.set(operation.milestoneId, {});
    }
    Object.assign(byId.get(operation.milestoneId)!, operation.changes);
  }
  return order.map((commitmentId) => ({ commitmentId, changes: byId.get(commitmentId)! }));
}

export type AppliedCommitmentEdit = {
  commitmentId: string;
  before: MeetingCommitment;
  after: MeetingCommitment;
  changes: Record<string, unknown>;
};

export type DirectCommitmentEditResult =
  | { ok: true; applied: AppliedCommitmentEdit[] }
  | { ok: false; reason: "not_found" | "persistence_failed"; message: string };

/**
 * Executes an already-validated batch of commitment edits. Callers MUST have already run
 * validateProposalTargets (confirms every milestoneId belongs to this project's current-
 * generation context) and validateAndCanonicalizeOperationOwners (resolves any requested owner
 * name to an exact existing project person) from lib/project-brain/operations.ts -- this
 * function additionally re-proves ownership itself via getOwnedCommitment immediately before
 * each write (never executing a commitmentId solely because it appeared in a prior validation
 * pass or because the model emitted it), matching the same re-validate-against-fresh-state
 * discipline the commitment-correction apply route and Patch A's direct UI controls both use.
 */
export async function executeDirectCommitmentEdits(input: {
  operations: UpdateMilestoneOperation[];
  userId: string;
  projectId: string;
  userMessageId: string | null;
}): Promise<DirectCommitmentEditResult> {
  const merged = mergeDirectCommitmentEdits(input.operations);
  const applied: AppliedCommitmentEdit[] = [];

  for (const edit of merged) {
    const before = await getOwnedCommitment(edit.commitmentId, input.userId);
    if (!before) {
      return {
        ok: false,
        reason: "not_found",
        message: "That commitment could not be found."
      };
    }
    const result = await applyCommitmentPatch(edit.commitmentId, edit.changes);
    if ("error" in result) {
      return { ok: false, reason: "persistence_failed", message: result.error };
    }
    applied.push({
      commitmentId: edit.commitmentId,
      before,
      after: result.commitment,
      changes: edit.changes
    });
  }

  // One project_change_events row per edited commitment, actor_type "assistant" -- the user
  // asked for this, but the execution actor performing the write is the assistant, never "user"
  // (see migration 20260818231713_production_launch_alignment.sql's actor_type check
  // constraint). event_type/entity_type mirror the vocabulary apply_project_change_proposal
  // already writes for update_milestone ("milestone" entity_type) so this table stays one
  // consistent audit log regardless of which path produced the row.
  for (const edit of applied) {
    await supabaseAdmin.from("project_change_events").insert({
      project_id: input.projectId,
      proposal_id: null,
      actor_type: "assistant",
      actor_id: input.userId,
      event_type: "update_milestone",
      entity_type: "milestone",
      entity_id: edit.commitmentId,
      before_state: edit.before,
      after_state: edit.after,
      source_type: "project_chat",
      source_id: input.userMessageId
    });
  }

  // Keeps execution_graph_version meaningful as an optimistic-concurrency token: a proposal
  // created before this direct edit (base_graph_version captured then) must look stale once
  // the project changed underneath it, exactly as it would if the change had instead come
  // through apply_project_change_proposal, which increments this same counter. No new RPC/
  // migration for this -- a plain read-then-write is an acceptable, non-atomic increment for a
  // single authenticated user editing their own project's commitments; the window for a
  // concurrent writer to the same project's version counter is negligible here.
  if (applied.length > 0) {
    const { data: project } = await supabaseAdmin
      .from("projects")
      .select("execution_graph_version")
      .eq("id", input.projectId)
      .maybeSingle();
    if (project) {
      await supabaseAdmin
        .from("projects")
        .update({ execution_graph_version: (project.execution_graph_version ?? 0) + 1 })
        .eq("id", input.projectId);
    }
  }

  return { ok: true, applied };
}

function fieldClause(field: string, changes: Record<string, unknown>): string | null {
  switch (field) {
    case "title":
      return `renamed it to "${changes.title}"`;
    case "description":
      return "updated the description";
    case "owner":
      return changes.owner ? `made ${changes.owner} the owner` : "unassigned the owner";
    case "due_date": {
      const formatted = formatReadableDate(changes.due_date as string | null);
      return formatted ? `moved the due date to ${formatted}` : "cleared the due date";
    }
    case "priority":
      return `set the priority to ${changes.priority}`;
    case "status":
      // Handled by completionClause below instead, so status doesn't also produce a generic
      // "set the status to completed" clause alongside "marked it complete".
      return null;
    default:
      return null;
  }
}

function completionClause(before: MeetingCommitment, after: MeetingCommitment): string | null {
  if (before.status === after.status) return null;
  if (after.status === "completed") return "marked it complete";
  if (before.status === "completed" || before.status === "dismissed") return "reopened it";
  if (after.status === "dismissed") return null; // delete/dismiss is Patch A's UI, not this path
  return `set the status to ${after.status.replace("_", " ")}`;
}

/** Builds the "Done -- ..." confirmation the user sees in chat. Never includes a commitment ID,
 * raw field names, or JSON -- see the ACCEPTANCE VS COMPLETION / CHAT RESPONSE requirements this
 * was written against. */
export function buildDirectEditConfirmationMessage(applied: AppliedCommitmentEdit[]): string {
  const perCommitment = applied.map((edit) => {
    const fieldClauses = Object.keys(edit.changes)
      .map((field) => fieldClause(field, edit.changes))
      .filter((clause): clause is string => Boolean(clause));
    const statusClause = completionClause(edit.before, edit.after);
    const clauses = [...fieldClauses, ...(statusClause ? [statusClause] : [])];
    return { title: edit.after.title, clauses };
  });

  if (perCommitment.length === 1 && perCommitment[0].clauses.length > 0) {
    const { title, clauses } = perCommitment[0];
    return `Done — I ${joinClauses(clauses)} for "${title}".`;
  }

  const summaries = perCommitment
    .filter((commitment) => commitment.clauses.length > 0)
    .map((commitment) => `${joinClauses(commitment.clauses)} for "${commitment.title}"`);
  return `Done — I ${joinClauses(summaries)}.`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) return "made no changes";
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}
