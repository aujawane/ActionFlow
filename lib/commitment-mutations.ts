import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment } from "@/lib/types";

/** The one write path for editing a commitment's fields -- extracted from
 * app/api/commitments/[id]/route.ts so the AI correction assistant's apply endpoint reuses the
 * exact same update (manual_override_fields/preserve_on_reanalysis marking, lead_owner_name ->
 * owner mirroring) instead of hand-copying it a second time. A single Supabase `.update()` call
 * on one row is already atomic across every field in `patch` -- a multi-field correction (owner +
 * due date + priority in one proposal) needs no RPC/migration to apply as one transaction. */
export async function applyCommitmentPatch(
  commitmentId: string,
  patch: Record<string, unknown>
): Promise<{ commitment: MeetingCommitment } | { error: string; details?: string }> {
  if (Object.keys(patch).length === 0) {
    return { error: "No changes to apply." };
  }

  const { data: commitment, error: fetchError } = await supabaseAdmin
    .from("meeting_commitments")
    .select("manual_override_fields")
    .eq("id", commitmentId)
    .maybeSingle();
  if (fetchError || !commitment) {
    return { error: "Commitment not found.", details: fetchError?.message };
  }

  const update: Record<string, unknown> = { ...patch };
  if ("lead_owner_name" in update) {
    update.owner = update.lead_owner_name;
  }
  if (update.completion_state === "completed" && !update.status) {
    update.status = "completed";
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_commitments")
    .update({
      ...update,
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        commitment.manual_override_fields,
        Object.keys(update)
      )
    })
    .eq("id", commitmentId)
    .select("*")
    .single();
  if (error || !data) {
    return { error: "Failed to update commitment.", details: error?.message };
  }
  return { commitment: data as MeetingCommitment };
}
