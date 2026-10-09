import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedTask } from "@/lib/project-access";
import { applyTaskPatch } from "@/lib/task-mutations";
import { updateTaskSchema } from "@/lib/task-status";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const task = await getOwnedTask(id, auth.user.id);
  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }
  const parsed = updateTaskSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "Invalid task update.", details: parsed.success ? null : parsed.error.flatten() },
      { status: 400 }
    );
  }
  const result = await applyTaskPatch(id, parsed.data);
  if ("error" in result) {
    return NextResponse.json(
      { error: "Failed to update task.", details: result.details },
      { status: 500 }
    );
  }
  return NextResponse.json({ task: result.task });
}
