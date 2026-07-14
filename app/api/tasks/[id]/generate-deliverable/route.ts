import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { generateTaskDeliverable } from "@/lib/task-deliverable-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OpenAI API key is not configured." }, { status: 500 });
  }

  const { id } = await context.params;
  const url = new URL(request.url);
  const regenerate = url.searchParams.get("regenerate") === "true";

  const result = await generateTaskDeliverable({
    taskId: id,
    userId: auth.user.id,
    regenerate
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        details: result.details,
        task: "task" in result ? result.task : undefined,
        artifact: "artifact" in result ? result.artifact : undefined,
        categorization: "metadata" in result ? result.metadata : undefined
      },
      { status: result.status }
    );
  }

  revalidatePath(`/tasks/${id}`);
  revalidatePath(`/meetings/${result.task.meeting_id}`);

  return NextResponse.json({
    task: result.task,
    artifact: result.artifact,
    categorization: result.metadata,
    reused: result.reused
  });
}
