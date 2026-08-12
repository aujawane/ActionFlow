import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const REASON_LABELS: Record<string, string> = {
  wrong_owner: "Wrong owner",
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
      "wrong_classification",
      "duplicate",
      "missing_context",
      "not_execution_work",
      "other"
    ]),
    note: z.string().trim().max(1000).optional()
  })
  .strict();

/**
 * Low-friction "this is wrong" flag. Reuses task_comments (the same table/thread Ask Parfait
 * already writes to) with role "system" rather than a new feedback table -- it shows up as a
 * plain, auditable entry in the task's existing history instead of a separate, hidden mechanism.
 */
export async function POST(
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report." }, { status: 400 });
  }

  const label = REASON_LABELS[parsed.data.reason];
  const message = parsed.data.note
    ? `Reported incorrect extraction: ${label} -- ${parsed.data.note}`
    : `Reported incorrect extraction: ${label}`;

  const { error } = await supabaseAdmin.from("task_comments").insert({
    task_id: id,
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
