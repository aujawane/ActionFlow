import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

async function findOwnedArtifact(artifactId: string, userId: string) {
  const { data: artifact, error } = await supabaseAdmin
    .from("meeting_artifacts")
    .select("id, meeting_id")
    .eq("id", artifactId)
    .single();
  if (error || !artifact) return null;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", artifact.meeting_id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();
  return meeting ? artifact : null;
}

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

  const artifact = await findOwnedArtifact(artifactId, auth.user.id);
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  const { data: updatedArtifact, error } = await supabaseAdmin
    .from("meeting_artifacts")
    .update({ title, content, status: "edited" })
    .eq("id", artifactId)
    .select("*")
    .single();
  if (error || !updatedArtifact) {
    return NextResponse.json(
      { error: "Failed to update artifact.", details: error?.message },
      { status: 500 }
    );
  }

  revalidatePath(`/meetings/${artifact.meeting_id}`);
  return NextResponse.json({ artifact: updatedArtifact });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ artifactId: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { artifactId } = await context.params;
  const artifact = await findOwnedArtifact(artifactId, auth.user.id);
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("meeting_artifacts")
    .delete()
    .eq("id", artifactId);
  if (error) {
    return NextResponse.json(
      { error: "Failed to delete artifact.", details: error.message },
      { status: 500 }
    );
  }

  revalidatePath(`/meetings/${artifact.meeting_id}`);
  return NextResponse.json({ ok: true });
}
