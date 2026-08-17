import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { applyCommitmentPatch } from "@/lib/commitment-mutations";
import { commitmentCorrectionChangeSchema } from "@/lib/commitment-correction/schema";
import { validateCommitmentCorrectionChanges } from "@/lib/commitment-correction/validate";
import { loadMeetingParticipantOptions } from "@/lib/meeting-participants";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const bodySchema = z
  .object({
    changes: z.array(commitmentCorrectionChangeSchema).min(1).max(10),
    // The user message that produced this proposal -- recorded for audit purposes only, never
    // used to decide what gets applied (see validate.ts: only `changes`, re-validated against
    // fresh server state, drives the mutation).
    sourceMessage: z.string().trim().max(2000).optional()
  })
  .strict();

/**
 * Applies a "Correct with Parfait" proposal: re-validates every proposed change against the
 * commitment's REAL current state and the meeting's REAL participant list (never trusting the
 * client-echoed proposal just because it round-tripped through the UI -- see
 * lib/commitment-correction/validate.ts), applies the resulting patch through the same canonical
 * commitment mutation used everywhere else (lib/commitment-mutations.ts, so
 * manual_override_fields/preserve_on_reanalysis are set identically to every other Phase 6
 * correction), then records an audit entry on the commitment's existing comment thread. The audit
 * entry is best-effort: if it fails after the mutation already succeeded, the response says so
 * explicitly rather than silently omitting it or claiming full success.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid proposed changes." }, { status: 400 });
  }

  const participantOptions = await loadMeetingParticipantOptions(commitment.meeting_id);

  const validated = validateCommitmentCorrectionChanges(parsed.data.changes, {
    commitment,
    participantOptions
  });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const result = await applyCommitmentPatch(commitment.id, validated.patch);
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error, details: result.details },
      { status: result.error === "Commitment not found." ? 404 : 500 }
    );
  }

  const fieldList = validated.summaries.map((summary) => summary.field).join(", ");
  const message = parsed.data.sourceMessage
    ? `Corrected with Parfait (${fieldList}) -- "${parsed.data.sourceMessage}"`
    : `Corrected with Parfait (${fieldList})`;

  const { error: auditError } = await supabaseAdmin.from("commitment_comments").insert({
    commitment_id: id,
    user_id: auth.user.id,
    role: "system",
    message,
    metadata: {
      kind: "ai_correction",
      user_message: parsed.data.sourceMessage ?? null,
      changes: validated.summaries
    }
  });

  return NextResponse.json({
    commitment: result.commitment,
    applied: validated.summaries,
    auditWarning: auditError ? "The correction was applied, but the audit note could not be saved." : null
  });
}
