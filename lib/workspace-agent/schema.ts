import { z } from "zod";

/**
 * V1 shared operation vocabulary for every Parfait chat surface. Deliberately narrow: only
 * operations with an existing, canonical, already-safe persistence path are included here --
 * see the Patch 1B report for the full list of what was deliberately deferred (create_commitment,
 * create_task, move_task, requirements/decisions/constraints, project participants, dependency
 * add/remove, artifact acceptance) and why. Nothing in this file invents new persistence; every
 * operation below maps directly onto applyCommitmentPatch, applyTaskPatch, or applyProjectPatch.
 *
 * Acceptance (TaskArtifact.accepted_at/accepted_by) is structurally excluded: no operation type
 * or `changes` field anywhere in this schema can touch those columns or the task_artifacts
 * table. "Mark complete" only ever reaches commitment/task status; it can never mean "accept."
 */

const priority = z.enum(["low", "medium", "high"]);
const commitmentStatus = z.enum(["pending", "in_progress", "completed", "dismissed", "blocked"]);
const taskStatus = z.enum(["pending", "in_progress", "completed", "dismissed", "blocked"]);
const projectStatus = z.enum(["planning", "active", "on_hold", "completed", "archived"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

/** Mirrors applyCommitmentPatch's supported field set, minus completion_state -- completion
 * state is always canonical/derived (see deriveCommitmentLifecyclePatch in
 * lib/commitment-mutations.ts), never freely model-written. Use complete_commitment/
 * reopen_commitment/dismiss_commitment for lifecycle transitions instead of setting `status`
 * here directly, though `status` is still accepted for parity with the direct-UI status select. */
const commitmentChanges = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    owner: z.string().trim().max(160).nullable().optional(),
    due_date: isoDate.nullable().optional(),
    priority: priority.optional(),
    status: commitmentStatus.optional()
  })
  .strict();

/** Mirrors the fields every current task-mutation caller (the general PATCH route, Task Chat)
 * actually validates for a general field edit. task_type/suggested_steps/rationale/
 * supporting_context are Task-Chat-specific authored-content fields with no analogue in the
 * other chat surfaces' vocabulary -- deliberately left out of the shared schema; applyTaskPatch
 * has no allowlist of its own, so adding them later is a schema change only, never a persistence
 * change. */
const taskChanges = z
  .object({
    task: z.string().trim().min(1).max(500).optional(),
    workspace_summary: z.string().trim().max(4000).nullable().optional(),
    owner: z.string().trim().max(160).nullable().optional(),
    due_date: isoDate.nullable().optional(),
    priority: priority.optional(),
    status: taskStatus.optional()
  })
  .strict();

/** Mirrors updateProjectSchema in app/api/projects/[id]/route.ts exactly. */
const projectChanges = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    goal: z.string().trim().max(2000).nullable().optional(),
    status: projectStatus.optional()
  })
  .strict();

export const workspaceOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update_commitment"), commitmentId: uuid, changes: commitmentChanges }).strict(),
  z.object({ type: z.literal("complete_commitment"), commitmentId: uuid }).strict(),
  z.object({ type: z.literal("reopen_commitment"), commitmentId: uuid }).strict(),
  z.object({ type: z.literal("dismiss_commitment"), commitmentId: uuid }).strict(),

  z.object({ type: z.literal("update_task"), taskId: uuid, changes: taskChanges }).strict(),
  z.object({ type: z.literal("complete_task"), taskId: uuid }).strict(),
  z.object({ type: z.literal("reopen_task"), taskId: uuid }).strict(),
  z.object({ type: z.literal("dismiss_task"), taskId: uuid }).strict(),
  z.object({
    type: z.literal("assign_task_owner"),
    taskId: uuid,
    owner: z.string().trim().max(160).nullable()
  }).strict(),

  z.object({ type: z.literal("update_project"), projectId: uuid, changes: projectChanges }).strict()
]);

export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export type CommitmentChanges = z.infer<typeof commitmentChanges>;
export type TaskChanges = z.infer<typeof taskChanges>;
export type ProjectChanges = z.infer<typeof projectChanges>;
