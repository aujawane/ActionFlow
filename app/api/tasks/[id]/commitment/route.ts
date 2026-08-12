import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { isEligibleMoveDestination, logCorrectionEvent } from "@/lib/execution-corrections";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedCommitment, getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const bodySchema = z
  .object({
    commitment_id: z.string().uuid().nullable()
  })
  .strict();

/**
 * Moves a task between commitments, or detaches it to standalone (commitment_id: null). Both
 * are the same underlying field change -- see Phase 6 correction audit -- and both are fully
 * reversible: a standalone task can later be attached, and a moved task can be moved again.
 */
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const nextCommitmentId = parsed.data.commitment_id;

  if (nextCommitmentId) {
    const destination = await getOwnedCommitment(nextCommitmentId, auth.user.id);
    if (!destination) {
      return NextResponse.json({ error: "Destination commitment not found." }, { status: 404 });
    }

    const { data: destinationMeeting } = await supabaseAdmin
      .from("meetings")
      .select("execution_graph_generation")
      .eq("id", destination.meeting_id)
      .maybeSingle();

    const eligible = isEligibleMoveDestination({
      task,
      destination,
      destinationMeetingGeneration: destinationMeeting?.execution_graph_generation ?? null
    });
    if (!eligible) {
      return NextResponse.json(
        {
          error:
            "That commitment is not a valid destination. It may be dismissed, from a different project, or from a stale analysis."
        },
        { status: 400 }
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update({
      commitment_id: nextCommitmentId,
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(task.manual_override_fields, [
        "commitment_id"
      ])
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to move task.", details: error?.message },
      { status: 500 }
    );
  }

  await logCorrectionEvent(supabaseAdmin, {
    projectId: task.project_id,
    actorId: auth.user.id,
    eventType: nextCommitmentId ? "task_moved_commitment" : "task_made_standalone",
    entityType: "task",
    entityId: task.id,
    beforeState: { commitment_id: task.commitment_id ?? null },
    afterState: { commitment_id: nextCommitmentId }
  });

  return NextResponse.json({ task: data });
}
