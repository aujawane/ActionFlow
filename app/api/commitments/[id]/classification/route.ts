import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { canDemoteCommitmentToFutureScope, logCorrectionEvent } from "@/lib/execution-corrections";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask } from "@/lib/types";

const bodySchema = z
  .object({
    execution_classification: z.enum(["committed", "future_consideration"])
  })
  .strict();

/**
 * Moves a commitment to Future Scope or promotes it back to active. Demotion is only allowed
 * when the commitment has no active child tasks -- otherwise those tasks would be stranded
 * under a no-longer-active parent (see Phase 6 correction audit, item 4). Promotion has no such
 * restriction: it can only add work back to the active set, never orphan anything.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const next = parsed.data.execution_classification;

  if (next === "future_consideration") {
    const { data: childTasks } = await supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("commitment_id", id);
    if (!canDemoteCommitmentToFutureScope(commitment, (childTasks ?? []) as MeetingTask[])) {
      return NextResponse.json(
        {
          error:
            "This commitment still has active child tasks. Move or reclassify them first, then move the commitment to Future Scope."
        },
        { status: 409 }
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_commitments")
    .update({
      execution_classification: next,
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(commitment.manual_override_fields, [
        "execution_classification"
      ])
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to update commitment.", details: error?.message },
      { status: 500 }
    );
  }

  await logCorrectionEvent(supabaseAdmin, {
    projectId: commitment.project_id,
    actorId: auth.user.id,
    eventType: next === "committed" ? "commitment_promoted_active" : "commitment_moved_future_scope",
    entityType: "commitment",
    entityId: commitment.id,
    beforeState: { execution_classification: commitment.execution_classification ?? "committed" },
    afterState: { execution_classification: next }
  });

  return NextResponse.json({ commitment: data });
}
