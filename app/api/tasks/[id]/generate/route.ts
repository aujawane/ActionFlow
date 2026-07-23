import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { generateTaskDeliverable } from "@/lib/task-deliverable-service";

/**
 * Vercel plan assumption: Pro. Compatibility wrapper around deliverable generation.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

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
        artifact: "artifact" in result ? result.artifact : undefined
      },
      { status: result.status }
    );
  }

  revalidatePath(`/tasks/${id}`);

  return NextResponse.json({
    artifact: result.artifact,
    task: result.task,
    reused: result.reused
  });
}
