import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    goal: z.string().trim().max(2000).nullable().optional(),
    status: z
      .enum(["planning", "active", "on_hold", "completed", "archived"])
      .optional()
  })
  .strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const project = await getOwnedProject(id, auth.user.id);
  return project
    ? NextResponse.json({ project })
    : NextResponse.json({ error: "Project not found." }, { status: 404 });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const parsed = updateProjectSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Invalid project update." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update(parsed.data)
    .eq("id", id)
    .eq("owner_id", auth.user.id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to update project.", details: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ project: data });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const { error } = await supabaseAdmin
    .from("projects")
    .delete()
    .eq("id", id)
    .eq("owner_id", auth.user.id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to delete project.", details: error.message },
      { status: 500 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
