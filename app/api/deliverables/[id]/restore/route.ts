import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedArtifact } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { TaskArtifact } from "@/lib/types";

/**
 * "Restore this version" (see Phase 7 version history). Never deletes or rewrites history --
 * copies the target version's content into a brand new current version via the same
 * create_deliverable_version RPC used by generation/regeneration/edits, tagged with which
 * version it was restored from.
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
    return NextResponse.json({ error: "Deliverable version not found." }, { status: 404 });
  }
  if (owned.artifact.status === "failed") {
    return NextResponse.json(
      { error: "A failed generation attempt cannot be restored." },
      { status: 400 }
    );
  }

  const { data: artifact, error } = await supabaseAdmin.rpc("create_deliverable_version", {
    p_task_id: owned.task.id,
    p_deliverable_type: owned.artifact.deliverable_type ?? owned.artifact.artifact_type,
    p_artifact_type: owned.artifact.artifact_type,
    p_title: owned.artifact.title,
    p_content: owned.artifact.content,
    p_status: "edited",
    p_metadata: { restored_from_version: owned.artifact.version }
  });
  if (error || !artifact) {
    return NextResponse.json(
      { error: "Failed to restore this version.", details: error?.message },
      { status: 500 }
    );
  }

  revalidatePath(`/deliverables/${(artifact as TaskArtifact).id}`);
  revalidatePath(`/tasks/${owned.task.id}`);

  return NextResponse.json({ artifact });
}
