import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedArtifact } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask, TaskArtifact } from "@/lib/types";

/** Reverses acceptance -- "Reopen / Mark as Draft" (see Phase 7). Reopens the task only if it is
 * still 'completed' (a task the user separately completed some other way after accepting isn't
 * clobbered). */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const owned = await getOwnedArtifact(id, auth.user.id);
  if (!owned) {
    return NextResponse.json({ error: "Deliverable not found." }, { status: 404 });
  }
  if (!owned.artifact.accepted_at) {
    return NextResponse.json({ artifact: owned.artifact, task: owned.task });
  }

  const { data: artifact, error } = await supabaseAdmin.rpc("reopen_deliverable", {
    p_artifact_id: id
  });
  if (error || !artifact) {
    return NextResponse.json(
      { error: "Failed to reopen deliverable.", details: error?.message },
      { status: 500 }
    );
  }

  const { data: task } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", (artifact as TaskArtifact).task_id)
    .single();

  revalidatePath(`/deliverables/${id}`);
  revalidatePath(`/tasks/${owned.task.id}`);
  if (owned.task.commitment_id) revalidatePath(`/commitments/${owned.task.commitment_id}`);
  revalidatePath(`/meetings/${owned.task.meeting_id}`);
  if (owned.task.project_id) revalidatePath(`/projects/${owned.task.project_id}`);

  return NextResponse.json({ artifact, task: (task as MeetingTask | null) ?? owned.task });
}
