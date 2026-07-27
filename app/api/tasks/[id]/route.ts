import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const updateTaskSchema = z
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
