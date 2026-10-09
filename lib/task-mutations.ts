import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveCompletedAtPatch } from "@/lib/task-status";
import type { MeetingTask, MeetingTaskStatus } from "@/lib/types";

/** The one write path for editing a task's fields -- mirrors lib/commitment-mutations.ts's
 * applyCommitmentPatch exactly (same fetch-manual_override_fields-then-update shape, same
 * caller-validates-before-calling contract: this function does not enforce any field allowlist
 * itself, since its two callers intentionally allow different field sets -- PATCH /api/tasks/[id]
 * validates against the strict updateTaskSchema allowlist, while Task Chat validates against its
 * own wider sanitizeTaskChatPatch allowlist (task_type/suggested_steps/rationale/
 * supporting_context, none of which updateTaskSchema permits). Authorization (getOwnedTask) also
 * happens in the caller, not here, matching applyCommitmentPatch's contract. completed_at is
 * ALWAYS derived here via deriveCompletedAtPatch, from patch.status alone -- never
 * client-supplied, and never computed a second way by any caller. */
export async function applyTaskPatch(
  taskId: string,
  patch: Record<string, unknown>
): Promise<{ task: MeetingTask } | { error: string; details?: string }> {
  if (Object.keys(patch).length === 0) {
    return { error: "No changes to apply." };
  }

  const { data: task, error: fetchError } = await supabaseAdmin
    .from("meeting_tasks")
    .select("manual_override_fields")
    .eq("id", taskId)
    .maybeSingle();
  if (fetchError || !task) {
    return { error: "Task not found.", details: fetchError?.message };
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update({
      ...patch,
      ...deriveCompletedAtPatch(patch.status as MeetingTaskStatus | undefined),
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        task.manual_override_fields,
        Object.keys(patch)
      )
    })
    .eq("id", taskId)
    .select("*")
    .single();
  if (error || !data) {
    return { error: "Failed to update task.", details: error?.message };
  }
  return { task: data as MeetingTask };
}
