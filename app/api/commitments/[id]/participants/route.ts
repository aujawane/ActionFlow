import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { mergeManualOverrideFields } from "@/lib/manual-overrides";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const participantSchema = z
  .object({
    participant_name: z.string().trim().min(1).max(120),
    participant_user_id: z.string().uuid().nullable().optional(),
    involvement_role: z
      .enum(["participant", "reviewer", "approver", "input_provider"])
      .default("participant")
  })
  .strict();

async function authorize(commitmentId: string, userId: string) {
  return getOwnedCommitment(commitmentId, userId);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const commitment = await authorize(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const { data, error } = await supabaseAdmin
    .from("commitment_participants")
    .select("*")
    .eq("commitment_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "Failed to load participants.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ participants: data ?? [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const commitment = await authorize(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const parsed = participantSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid participant.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { data, error } = await supabaseAdmin
    .from("commitment_participants")
    .upsert(
      {
        commitment_id: id,
        ...parsed.data,
        manually_added: true
      },
      { onConflict: "commitment_id,participant_name" }
    )
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to add participant.", details: error?.message },
      { status: 500 }
    );
  }
  await supabaseAdmin
    .from("meeting_commitments")
    .update({
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        commitment.manual_override_fields,
        ["participants"]
      )
    })
    .eq("id", id);
  return NextResponse.json({ participant: data }, { status: 201 });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const commitment = await authorize(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const participantId = z
    .string()
    .uuid()
    .safeParse((await request.json().catch(() => null))?.participant_id);
  if (!participantId.success) {
    return NextResponse.json({ error: "participant_id is required." }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("commitment_participants")
    .delete()
    .eq("id", participantId.data)
    .eq("commitment_id", id)
    .eq("manually_added", true);
  if (error) {
    return NextResponse.json(
      { error: "Failed to remove participant.", details: error.message },
      { status: 500 }
    );
  }
  await supabaseAdmin
    .from("meeting_commitments")
    .update({
      preserve_on_reanalysis: true,
      manual_override_fields: mergeManualOverrideFields(
        commitment.manual_override_fields,
        ["participants"]
      )
    })
    .eq("id", id);
  return NextResponse.json({ ok: true });
}
