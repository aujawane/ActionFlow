import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const REASON_LABELS: Record<string, string> = {
  wrong_owner: "Wrong owner",
  wrong_supporting_person: "Wrong supporting person",
  wrong_classification: "Wrong classification",
  duplicate: "Duplicate",
  missing_context: "Missing/incorrect context",
  not_execution_work: "Should not be execution work",
  other: "Other"
};

const bodySchema = z
  .object({
    reason: z.enum([
      "wrong_owner",
      "wrong_supporting_person",
      "wrong_classification",
      "duplicate",
      "missing_context",
      "not_execution_work",
      "other"
    ]),
    note: z.string().trim().max(1000).optional()
  })
  .strict();

/** Mirrors /api/tasks/[id]/report -- see that route for why commitment_comments (not a new
 * table) is the right home for this. */
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report." }, { status: 400 });
  }

  const label = REASON_LABELS[parsed.data.reason];
  const message = parsed.data.note
    ? `Reported incorrect extraction: ${label} -- ${parsed.data.note}`
    : `Reported incorrect extraction: ${label}`;

  const { error } = await supabaseAdmin.from("commitment_comments").insert({
    commitment_id: id,
    user_id: auth.user.id,
    role: "system",
    message,
    metadata: {
      kind: "extraction_report",
      reason: parsed.data.reason,
      note: parsed.data.note ?? null
    }
  });
  if (error) {
    return NextResponse.json(
      { error: "Failed to save report.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
