import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const updateCommitmentSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().nullable().optional(),
    owner: z.string().trim().nullable().optional(),
    owners: z.array(z.string().trim().min(1)).optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    due_date_text: z.string().trim().nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    status: z
      .enum(["pending", "in_progress", "completed", "dismissed", "blocked"])
      .optional(),
    completion_state: z
      .enum(["open", "in_progress", "blocked", "completed", "cancelled"])
      .optional()
  })
  .strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateCommitmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid commitment update.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { data: commitment } = await supabaseAdmin
    .from("meeting_commitments")
    .select("id, meeting_id")
    .eq("id", id)
    .maybeSingle();
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", commitment.meeting_id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const update = { ...parsed.data };
  if (update.completion_state === "completed" && !update.status) {
    update.status = "completed";
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_commitments")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to update commitment.", details: error?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ commitment: data });
}
