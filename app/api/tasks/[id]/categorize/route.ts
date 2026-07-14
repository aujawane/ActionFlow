import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { ensureTaskIsCategorized } from "@/lib/task-deliverable-service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OpenAI API key is not configured." }, { status: 500 });
  }

  const { id } = await context.params;
  const result = await ensureTaskIsCategorized(id, auth.user.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, details: "details" in result ? result.details : undefined },
      { status: result.status }
    );
  }

  revalidatePath(`/tasks/${id}`);
  revalidatePath(`/meetings/${result.task.meeting_id}`);

  return NextResponse.json({
    task: result.task,
    categorization: result.metadata
  });
}
