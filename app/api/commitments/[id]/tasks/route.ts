import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const createTaskSchema = z
  .object({
    task: z.string().trim().min(1).max(500),
    workspace_summary: z.string().trim().max(4000).nullable().optional(),
    owner: z.string().trim().max(160).nullable().optional(),
    owners: z.array(z.string().trim().min(1).max(160)).default([]),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    due_date_text: z.string().trim().max(300).nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    workspace_type: z
      .enum([
        "email",
        "research",
        "website_change",
        "design",
        "scheduling",
        "follow_up",
        "coding",
        "planning",
        "analysis",
        "document",
        "other"
      ])
      .default("other")
  })
  .strict();

const reorderSchema = z
  .object({ task_ids: z.array(z.string().uuid()).min(1) })
  .strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedCommitment(id, auth.user.id))) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("commitment_id", id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "Failed to load tasks.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ tasks: data ?? [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const parsed = createTaskSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid task.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { data: lastTask } = await supabaseAdmin
    .from("meeting_tasks")
    .select("position")
    .eq("commitment_id", id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const manualFields = Object.keys(parsed.data);
  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .insert({
      meeting_id: commitment.meeting_id,
      project_id: commitment.project_id ?? null,
      commitment_id: id,
      topic_id: commitment.topic_id,
      ...parsed.data,
      task_type: "commitment",
      suggested_steps: [],
      status: "pending",
      position: (lastTask?.position ?? -1) + 1,
      execution_classification: "committed",
      inferred: false,
      preserve_on_reanalysis: true,
      manual_override_fields: manualFields,
      extraction_metadata: { source: "manual" }
    })
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to create task.", details: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ task: data }, { status: 201 });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedCommitment(id, auth.user.id))) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const parsed = reorderSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid task order." }, { status: 400 });
  }
  const { data: tasks } = await supabaseAdmin
    .from("meeting_tasks")
    .select("id")
    .eq("commitment_id", id)
    .in("id", parsed.data.task_ids);
  if ((tasks ?? []).length !== new Set(parsed.data.task_ids).size) {
    return NextResponse.json(
      { error: "One or more tasks do not belong to this commitment." },
      { status: 400 }
    );
  }
  const updates = await Promise.all(
    parsed.data.task_ids.map((taskId, position) =>
      supabaseAdmin
        .from("meeting_tasks")
        .update({
          position,
          preserve_on_reanalysis: true
        })
        .eq("id", taskId)
        .eq("commitment_id", id)
    )
  );
  const failure = updates.find((result) => result.error);
  if (failure?.error) {
    return NextResponse.json(
      { error: "Failed to reorder tasks.", details: failure.error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ task_ids: parsed.data.task_ids });
}
