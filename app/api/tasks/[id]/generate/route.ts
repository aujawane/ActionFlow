import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  generateTaskArtifactDraft,
  getArtifactTypeForTask,
  getTaskWorkspaceContext
} from "@/lib/task-workspace";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OpenAI API key is not configured." }, { status: 500 });
  }

  const { id } = await context.params;
  const workspaceContext = await getTaskWorkspaceContext(id, auth.user.id);
  if (!workspaceContext.ok) {
    return NextResponse.json(
      { error: workspaceContext.error, details: workspaceContext.details },
      { status: workspaceContext.status }
    );
  }

  const artifactType = getArtifactTypeForTask(workspaceContext.context.task);
  const generation = await generateTaskArtifactDraft(workspaceContext.context);

  if (!generation.ok) {
    return NextResponse.json(
      { error: generation.error, details: generation.details },
      { status: 502 }
    );
  }

  const { data: latestArtifact, error: latestArtifactError } = await supabaseAdmin
    .from("task_artifacts")
    .select("version")
    .eq("task_id", id)
    .eq("artifact_type", artifactType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestArtifactError) {
    return NextResponse.json(
      { error: "Failed to determine artifact version.", details: latestArtifactError.message },
      { status: 500 }
    );
  }

  const version =
    typeof latestArtifact?.version === "number" ? latestArtifact.version + 1 : 1;

  const { data: artifact, error: insertError } = await supabaseAdmin
    .from("task_artifacts")
    .insert({
      task_id: id,
      artifact_type: artifactType,
      title: generation.artifact.title,
      content: generation.artifact.content,
      version
    })
    .select("*")
    .single();

  if (insertError || !artifact) {
    return NextResponse.json(
      { error: "Failed to save generated artifact.", details: insertError?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ artifact });
}
