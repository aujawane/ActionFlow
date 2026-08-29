import { z } from "zod";

import type { MeetingTaskStatus } from "@/lib/types";

/** Every state the Task Workspace's status dropdown exposes, in display order. The dropdown is
 * the single lifecycle control -- including "dismissed" -- because dismissal here is a deliberate
 * human decision about an already-persisted task (see the status mutation route), not the
 * extraction-rejection/report flow in components/task-correction-menu.tsx. Both surfaces reach
 * the same "dismissed" value; they just represent different reasons a human might choose it. */
export const TASK_WORKSPACE_STATUS_OPTIONS: MeetingTaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "dismissed"
];

/** User-friendly labels for the status dropdown -- kept separate from lib/status-badge.ts's
 * formatStatusLabel (which just replaces underscores) so this control's exact display copy is
 * "Completed"/"In Progress"/etc. without depending on a formatting side effect. */
export const TASK_STATUS_LABELS: Record<MeetingTaskStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "✓ Completed",
  blocked: "Blocked",
  dismissed: "Dismissed"
};

/**
 * Server-derived completed_at side effect of a status change. Never client-supplied -- the API
 * route calls this itself rather than trusting a completed_at value in the request body, so a
 * caller can't set an arbitrary completion timestamp. Returns {} when the patch doesn't touch
 * status at all, so completed_at is left untouched by unrelated updates (e.g. an owner change).
 */
export function deriveCompletedAtPatch(
  status: MeetingTaskStatus | undefined,
  now: () => string = () => new Date().toISOString()
): { completed_at: string | null } | Record<string, never> {
  if (status === undefined) return {};
  return { completed_at: status === "completed" ? now() : null };
}

/**
 * Strict allowlist for PATCH /api/tasks/[id] -- lives here (not inline in the route) so it's
 * directly importable by tests without exporting a non-handler name from a route.ts file, which
 * Next.js's App Router does not allow. `status` is validated against the exact, existing
 * MeetingTaskStatus enum; nothing else about this schema changes for the status dropdown feature.
 */
export const updateTaskSchema = z
  .object({
    task: z.string().trim().min(1).max(500).optional(),
    workspace_summary: z.string().trim().max(4000).nullable().optional(),
    owner: z.string().trim().max(160).nullable().optional(),
    owners: z.array(z.string().trim().min(1).max(160)).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    due_date_text: z.string().trim().max(300).nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    status: z
      .enum(["pending", "in_progress", "completed", "dismissed", "blocked"])
      .optional(),
    position: z.number().int().min(0).optional()
  })
  .strict();
