import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).nullable().optional(),
    goal: z.string().trim().max(2000).nullable().optional(),
    status: z
      .enum(["planning", "active", "on_hold", "completed", "archived"])
      .default("planning")
  })
  .strict();

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("*")
    .eq("owner_id", auth.user.id)
    .order("updated_at", { ascending: false });
  if (error) {
    return NextResponse.json(
      { error: "Failed to load projects.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ projects: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = createProjectSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid project.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .insert({ ...parsed.data, owner_id: auth.user.id })
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to create project.", details: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ project: data }, { status: 201 });
}
