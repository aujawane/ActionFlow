import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const mergeSchema = z
  .object({
    survivor_task_id: z.string().uuid(),
    merged_task_ids: z.array(z.string().uuid()).min(1)
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedCommitment(id, auth.user.id))) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const parsed = mergeSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid task merge." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin.rpc("merge_commitment_tasks", {
    p_commitment_id: id,
    p_survivor_task_id: parsed.data.survivor_task_id,
    p_merged_task_ids: parsed.data.merged_task_ids
  });
  if (error) {
    return NextResponse.json(
      { error: "Failed to merge tasks.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ survivor_task_id: data });
}
