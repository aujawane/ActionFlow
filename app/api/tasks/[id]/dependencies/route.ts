import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const dependencySchema = z
  .object({ depends_on_task_ids: z.array(z.string().uuid()) })
  .strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedTask(id, auth.user.id))) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }
  const { data, error } = await supabaseAdmin
    .from("task_dependencies")
    .select("*")
    .eq("task_id", id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to load dependencies.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ dependencies: data ?? [] });
}

export async function PUT(
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
  const parsed = dependencySchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || parsed.data.depends_on_task_ids.includes(id)) {
    return NextResponse.json({ error: "Invalid dependencies." }, { status: 400 });
  }
  const ids = Array.from(new Set(parsed.data.depends_on_task_ids));
  if (ids.length > 0) {
    const dependencies = await Promise.all(
      ids.map((taskId) => getOwnedTask(taskId, auth.user.id))
    );
    if (
      dependencies.some(
        (dependency) =>
          !dependency ||
          dependency.project_id !== task.project_id ||
          dependency.commitment_id !== task.commitment_id
      )
    ) {
      return NextResponse.json(
        { error: "Dependencies must be tasks in the same milestone." },
        { status: 400 }
      );
    }
  }
  const { error } = await supabaseAdmin.rpc("replace_task_dependencies", {
    p_task_id: id,
    p_depends_on_task_ids: ids
  });
  if (error) {
    return NextResponse.json(
      { error: "Failed to save dependencies.", details: error.message },
      { status: 400 }
    );
  }

  // A human just made this task's dependency decision explicitly -- mark it so AI dependency
  // inference (lib/task-dependency-inference.ts) never overwrites it again, same mechanism as
  // every other Phase 6 manual correction (preserve_on_reanalysis + manual_override_fields).
  const { error: overrideError } = await supabaseAdmin
    .from("meeting_tasks")
    .update({
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        task.manual_override_fields,
        ["dependencies"]
      )
    })
    .eq("id", id);
  if (overrideError) {
    console.warn("[tasks/dependencies] Failed to record manual override", {
      task_id: id,
      error: overrideError.message
    });
  }

  return NextResponse.json({
    dependencies: ids.map((dependsOnTaskId) => ({
      task_id: id,
      depends_on_task_id: dependsOnTaskId
    }))
  });
}
