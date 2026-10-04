import { reviewProjectVocabularyTerm } from "@/lib/project-vocabulary-review";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; termId: string }> }
) {
  const { id, termId } = await context.params;
  const body = await request.json().catch(() => null);
  return reviewProjectVocabularyTerm({ projectId: id, termId, body });
}
