import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { logCorrectionEvent } from "@/lib/execution-corrections";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const bodySchema = z
  .object({
    execution_classification: z.enum(["committed", "future_consideration"])
  })
  .strict();

/**
 * Moves a task to Future Scope ("future_consideration") or promotes it back to active
 * ("committed"). Only these two values are ever written here -- "proposed"/"requirement" are
 * AI-only extraction nuances a manual correction has no reason to choose between (see Phase 6
 * correction audit).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const task = await getOwnedTask(id, auth.user.id);
  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const next = parsed.data.execution_classification;

  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update({
      execution_classification: next,
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(task.manual_override_fields, [
        "execution_classification"
      ])
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to update task.", details: error?.message },
      { status: 500 }
    );
  }

  await logCorrectionEvent(supabaseAdmin, {
    projectId: task.project_id,
    actorId: auth.user.id,
    eventType: next === "committed" ? "task_promoted_active" : "task_moved_future_scope",
    entityType: "task",
    entityId: task.id,
    beforeState: { execution_classification: task.execution_classification ?? "committed" },
    afterState: { execution_classification: next }
  });

  return NextResponse.json({ task: data });
}
