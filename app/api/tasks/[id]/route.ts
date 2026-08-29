import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveCompletedAtPatch, updateTaskSchema } from "@/lib/task-status";

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
  const parsed = updateTaskSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "Invalid task update.", details: parsed.success ? null : parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update({
      ...parsed.data,
      ...deriveCompletedAtPatch(parsed.data.status),
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        task.manual_override_fields,
        Object.keys(parsed.data)
      )
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
  return NextResponse.json({ task: data });
}
