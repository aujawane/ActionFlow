import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CommitmentCompletionState, CommitmentStatus, MeetingCommitment } from "@/lib/types";

/** status <-> completion_state are two parallel lifecycle enums on the same row (see
 * lib/types.ts) that must never drift apart. Callers that only know one of the two values --
 * e.g. the "Correct with Parfait" field-corrector, which can only ever propose `status` -- used
 * to leave the other one stale (a commitment corrected to status="completed" could keep
 * completion_state="open" forever). These maps derive the missing value from whichever one a
 * caller actually sent, so every mutation path stays internally consistent without every caller
 * having to remember to send both. Mirrors the archive_milestone mapping already established in
 * the apply_project_change_proposal RPC (status "dismissed" <-> completion_state "cancelled").*/
const STATUS_TO_COMPLETION_STATE: Record<CommitmentStatus, CommitmentCompletionState> = {
  pending: "open",
  in_progress: "in_progress",
  blocked: "blocked",
  completed: "completed",
  dismissed: "cancelled"
};
const COMPLETION_STATE_TO_STATUS: Record<CommitmentCompletionState, CommitmentStatus> = {
  open: "pending",
  in_progress: "in_progress",
  blocked: "blocked",
  completed: "completed",
  cancelled: "dismissed"
};

/** Pure derivation step, extracted from applyCommitmentPatch so it's directly unit-testable
 * (mirrors lib/task-status.ts's deriveCompletedAtPatch, which the same split was done for).
 * Only fills in whichever of status/completion_state the caller left out -- never overrides a
 * value the caller explicitly sent for both. */
export function deriveCommitmentLifecyclePatch(
  patch: Record<string, unknown>
): { completion_state: CommitmentCompletionState } | { status: CommitmentStatus } | Record<string, never> {
  if (typeof patch.status === "string" && !("completion_state" in patch)) {
    return { completion_state: STATUS_TO_COMPLETION_STATE[patch.status as CommitmentStatus] };
  }
  if (typeof patch.completion_state === "string" && !("status" in patch)) {
    return { status: COMPLETION_STATE_TO_STATUS[patch.completion_state as CommitmentCompletionState] };
  }
  return {};
}

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

  const update: Record<string, unknown> = { ...patch, ...deriveCommitmentLifecyclePatch(patch) };
  if ("lead_owner_name" in update) {
    update.owner = update.lead_owner_name;
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
