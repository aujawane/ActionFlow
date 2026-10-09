import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Project } from "@/lib/types";

/** The one write path for editing a project's fields -- mirrors lib/commitment-mutations.ts's
 * applyCommitmentPatch and lib/task-mutations.ts's applyTaskPatch: no field allowlist or
 * authorization check inside it (the caller validates/authorizes before calling, exactly like
 * the other two), just the write itself. Projects have no manual_override_fields/
 * preserve_on_reanalysis concept (those are execution-graph-extraction concerns specific to
 * commitments/tasks), so this function is intentionally the simplest of the three. */
export async function applyProjectPatch(
  projectId: string,
  patch: Record<string, unknown>
): Promise<{ project: Project } | { error: string; details?: string }> {
  if (Object.keys(patch).length === 0) {
    return { error: "No changes to apply." };
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .select("*")
    .single();
  if (error || !data) {
    return { error: "Failed to update project.", details: error?.message };
  }
  return { project: data as Project };
}
