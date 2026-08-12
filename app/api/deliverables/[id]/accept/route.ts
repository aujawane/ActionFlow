import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedArtifact } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask, TaskArtifact } from "@/lib/types";

/**
 * "Accept Deliverable" -- the one intentional, explicit action that completes a task from its
 * generated output (see Phase 7). Never triggered implicitly by generation, copying, or editing.
 * Atomic via the accept_deliverable RPC: the artifact and its task are updated together or not
 * at all (see the migration).
 */
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
  if (owned.artifact.status === "failed") {
    return NextResponse.json(
      { error: "A failed generation attempt cannot be accepted." },
      { status: 400 }
    );
  }
  if (owned.artifact.accepted_at) {
    return NextResponse.json({ artifact: owned.artifact, task: owned.task });
  }

  const { data: artifact, error } = await supabaseAdmin.rpc("accept_deliverable", {
    p_artifact_id: id,
    p_actor_id: auth.user.id
  });
  if (error || !artifact) {
    return NextResponse.json(
      { error: "Failed to accept deliverable.", details: error?.message },
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
