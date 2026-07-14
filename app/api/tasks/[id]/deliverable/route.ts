import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { loadLatestDeliverableArtifact } from "@/lib/task-deliverable-service";
import { getTaskWorkspaceContext } from "@/lib/task-workspace";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const workspaceContext = await getTaskWorkspaceContext(id, auth.user.id);
  if (!workspaceContext.ok) {
    return NextResponse.json(
      { error: workspaceContext.error, details: workspaceContext.details },
      { status: workspaceContext.status }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    content?: unknown;
    title?: unknown;
    artifactId?: unknown;
  } | null;

  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "Deliverable content is required." }, { status: 400 });
  }

  let artifactId =
    typeof body?.artifactId === "string" ? body.artifactId.trim() : null;
  if (!artifactId) {
    const latest = await loadLatestDeliverableArtifact(id);
    artifactId = latest.artifact?.id ?? null;
  }

  if (!artifactId) {
    return NextResponse.json({ error: "No deliverable found to update." }, { status: 404 });
  }

  const { data: artifact, error: updateError } = await supabaseAdmin
    .from("task_artifacts")
    .update({
      content,
      ...(title ? { title } : {}),
      status: "edited"
    })
    .eq("id", artifactId)
    .eq("task_id", id)
    .select("*")
    .single();

  if (updateError || !artifact) {
    return NextResponse.json(
      { error: "Failed to save deliverable edits.", details: updateError?.message },
      { status: 500 }
    );
  }

  revalidatePath(`/tasks/${id}`);
  revalidatePath(`/meetings/${workspaceContext.context.task.meeting_id}`);

  return NextResponse.json({
    task: workspaceContext.context.task,
    artifact
  });
}
