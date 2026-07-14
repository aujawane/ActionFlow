import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ artifactId: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { artifactId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    content?: unknown;
  } | null;

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";

  if (!title || !content) {
    return NextResponse.json(
      { error: "Artifact title and content are required." },
      { status: 400 }
    );
  }

  const { data: artifact, error: artifactError } = await supabaseAdmin
    .from("task_artifacts")
    .select("id, task_id")
    .eq("id", artifactId)
    .single();

  if (artifactError || !artifact) {
    return NextResponse.json(
      { error: "Artifact not found.", details: artifactError?.message },
      { status: 404 }
    );
  }

  const { data: task, error: taskError } = await supabaseAdmin
    .from("meeting_tasks")
    .select("id, meeting_id")
    .eq("id", artifact.task_id)
    .single();

  if (taskError || !task) {
    return NextResponse.json(
      { error: "Artifact not found.", details: taskError?.message },
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
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  const { data: updatedArtifact, error: updateError } = await supabaseAdmin
    .from("task_artifacts")
    .update({ title, content, status: "edited" })
    .eq("id", artifactId)
    .select("*")
    .single();

  if (updateError || !updatedArtifact) {
    return NextResponse.json(
      { error: "Failed to update artifact.", details: updateError?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ artifact: updatedArtifact });
}
