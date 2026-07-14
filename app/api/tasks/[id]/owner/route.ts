import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { owner?: unknown } | null;
  const owner =
    typeof body?.owner === "string" && body.owner.trim() && body.owner.trim() !== "Unassigned"
      ? body.owner.trim()
      : null;

  const { data: task, error: taskError } = await supabaseAdmin
    .from("meeting_tasks")
    .select("id, meeting_id")
    .eq("id", id)
    .single();

  if (taskError || !task) {
    return NextResponse.json(
      { error: "Task not found.", details: taskError?.message },
      { status: 404 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", task.meeting_id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  const { data: updatedTask, error: updateError } = await supabaseAdmin
    .from("meeting_tasks")
    .update({ owner })
    .eq("id", id)
    .select(
      "id, meeting_id, topic_id, task, owner, task_type, priority, suggested_steps, source_quote, confidence, status, due_date, workspace_type, workspace_summary, rationale, supporting_context, created_at"
    )
    .single();

  if (updateError || !updatedTask) {
    return NextResponse.json(
      { error: "Failed to update task owner.", details: updateError?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ task: updatedTask });
}
