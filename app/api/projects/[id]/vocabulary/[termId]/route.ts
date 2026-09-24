import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ProjectVocabularyTerm } from "@/lib/types";

// Only a review decision -- "suggested" is deliberately not an accepted target here. There is no
// path back into "suggested" (re-suggesting is upsertVocabularySuggestions's job, not this route's),
// and this endpoint is the review step, not a general-purpose field editor.
const reviewVocabularyTermSchema = z
  .object({
    status: z.enum(["approved", "rejected"])
  })
  .strict();

export type UpdateSuggestedVocabularyTerm = (input: {
  termId: string;
  projectId: string;
  status: "approved" | "rejected";
}) => Promise<{ data: ProjectVocabularyTerm | null; error: { message: string } | null }>;

export type ReviewVocabularyTermDependencies = {
  requireApiUser: typeof requireApiUser;
  getOwnedProject: typeof getOwnedProject;
  updateSuggestedTerm: UpdateSuggestedVocabularyTerm;
};

// The project_id and status filters here are both authorization/state-transition guards enforced
// atomically by Postgres in a single query -- not a separate read-then-write. This means: (a) a
// term belonging to another project can never be affected, even if its id is guessed, and (b) a
// term that isn't currently "suggested" (already reviewed, or a manually added term that was never
// suggested in the first place) is left untouched rather than silently re-reviewed.
const updateSuggestedTermInSupabase: UpdateSuggestedVocabularyTerm = async ({
  termId,
  projectId,
  status
}) => {
  const { data, error } = await supabaseAdmin
    .from("project_vocabulary")
    .update({ status })
    .eq("id", termId)
    .eq("project_id", projectId)
    .eq("status", "suggested")
    .select("*")
    .maybeSingle();
  return { data: data as ProjectVocabularyTerm | null, error };
};

const defaultDependencies: ReviewVocabularyTermDependencies = {
  requireApiUser,
  getOwnedProject,
  updateSuggestedTerm: updateSuggestedTermInSupabase
};

/**
 * The human half of the project-vocabulary approval loop: an AI-discovered term sits as
 * status="suggested" (see lib/project-vocabulary.ts's upsertVocabularySuggestions) until a project
 * owner explicitly approves or rejects it here. Only once approved does
 * getApprovedProjectVocabulary (and therefore both the deterministic alias pass and the
 * normalization prompt context) ever see it on a future meeting.
 *
 * Factored out from the PATCH handler below so tests can inject fakes for auth/db access --
 * mirrors the existing createResponse-override pattern used for model calls elsewhere in this repo
 * (e.g. lib/execution-intelligence/work-item-model.ts's `createResponse` parameter) rather than
 * inventing a new testing convention. Production always uses `defaultDependencies`; the
 * authorization order and every response shape/status code are unchanged from a plain inline
 * implementation -- this only adds a seam, not new behavior.
 */
export async function reviewProjectVocabularyTerm(
  input: { projectId: string; termId: string; body: unknown },
  deps: ReviewVocabularyTermDependencies = defaultDependencies
): Promise<Response> {
  const auth = await deps.requireApiUser();
  if (auth.response) return auth.response;

  if (!(await deps.getOwnedProject(input.projectId, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const parsed = reviewVocabularyTermSchema.safeParse(input.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A vocabulary review must set status to \"approved\" or \"rejected\"." },
      { status: 400 }
    );
  }

  const { data, error } = await deps.updateSuggestedTerm({
    termId: input.termId,
    projectId: input.projectId,
    status: parsed.data.status
  });

  if (error) {
    return NextResponse.json(
      { error: "Failed to update vocabulary term.", details: error.message },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: "This suggestion no longer exists or has already been reviewed." },
      { status: 409 }
    );
  }

  return NextResponse.json({ term: data });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; termId: string }> }
) {
  const { id, termId } = await context.params;
  const body = await request.json().catch(() => null);
  return reviewProjectVocabularyTerm({ projectId: id, termId, body });
}
