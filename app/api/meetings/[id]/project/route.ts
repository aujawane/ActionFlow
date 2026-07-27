import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const assignmentSchema = z
  .object({
    project_id: z.string().uuid().nullable().optional(),
    new_project: z
      .object({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2000).nullable().optional(),
        goal: z.string().trim().max(2000).nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine(
    (value) => !(value.project_id && value.new_project),
    "Choose an existing project or create a new one."
  );

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const parsed = assignmentSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid project assignment.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  let projectId = parsed.data.project_id ?? null;
  let createdProjectId: string | null = null;
  if (parsed.data.new_project) {
    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .insert({
        ...parsed.data.new_project,
        owner_id: auth.user.id,
        status: "planning"
      })
      .select("*")
      .single();
    if (error || !project) {
      return NextResponse.json(
        { error: "Failed to create project.", details: error?.message },
        { status: 500 }
      );
    }
    projectId = project.id;
    createdProjectId = project.id;
  } else if (projectId) {
    const { data: project } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("owner_id", auth.user.id)
      .maybeSingle();
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
  }

  const { error } = await supabaseAdmin.rpc("assign_meeting_project", {
    p_meeting_id: id,
    p_project_id: projectId
  });
  if (error) {
    if (createdProjectId) {
      await supabaseAdmin.from("projects").delete().eq("id", createdProjectId);
    }
    return NextResponse.json(
      { error: "Failed to assign project.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ project_id: projectId });
}
