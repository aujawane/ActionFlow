import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { loadLatestDeliverableArtifact } from "@/lib/task-deliverable-service";
import { getTaskWorkspaceContext } from "@/lib/task-workspace";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { TaskArtifact } from "@/lib/types";

/**
 * Saves an edit to a deliverable. Per the Phase 7 audit, editing previously overwrote the
 * target row in place -- the one place in this system that silently discarded a version. This
 * now goes through create_deliverable_version (the same RPC generation/regeneration use), so an
 * edit always produces a new "edited" version and nothing is ever lost. If the version being
 * edited was accepted, the RPC also reopens the task -- see the migration for why.
 */
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

  let artifactId = typeof body?.artifactId === "string" ? body.artifactId.trim() : null;
  let sourceArtifact: TaskArtifact | null = null;
  if (artifactId) {
    const { data } = await supabaseAdmin
      .from("task_artifacts")
      .select("*")
      .eq("id", artifactId)
      .eq("task_id", id)
      .maybeSingle();
    sourceArtifact = (data as TaskArtifact | null) ?? null;
  } else {
    const latest = await loadLatestDeliverableArtifact(id);
    sourceArtifact = latest.artifact;
    artifactId = sourceArtifact?.id ?? null;
  }

  if (!sourceArtifact) {
    return NextResponse.json({ error: "No deliverable found to update." }, { status: 404 });
  }

  const { data: artifact, error: rpcError } = await supabaseAdmin.rpc(
    "create_deliverable_version",
    {
      p_task_id: id,
      p_deliverable_type: sourceArtifact.deliverable_type ?? sourceArtifact.artifact_type,
      p_artifact_type: sourceArtifact.artifact_type,
      p_title: title || sourceArtifact.title,
      p_content: content,
      p_status: "edited",
      p_metadata: { edited_from_version: sourceArtifact.version }
    }
  );

  if (rpcError || !artifact) {
    return NextResponse.json(
      { error: "Failed to save deliverable edits.", details: rpcError?.message },
      { status: 500 }
    );
  }

  revalidatePath(`/tasks/${id}`);
  revalidatePath(`/deliverables/${(artifact as TaskArtifact).id}`);
  revalidatePath(`/meetings/${workspaceContext.context.task.meeting_id}`);

  // A reopened task (see the RPC) isn't reflected in workspaceContext.context.task, which was
  // fetched before this write -- re-read it so the response's task state is current.
  const { data: refreshedTask } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", id)
    .single();

  return NextResponse.json({
    task: refreshedTask ?? workspaceContext.context.task,
    artifact
  });
}
