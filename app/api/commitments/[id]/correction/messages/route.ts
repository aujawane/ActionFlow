import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { runCommitmentCorrectionAgent } from "@/lib/commitment-correction/agent";
import { buildCommitmentCorrectionContext } from "@/lib/commitment-correction/context";
import { loadMeetingParticipantOptions } from "@/lib/meeting-participants";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const bodySchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          message: z.string().max(4000)
        })
      )
      .max(40)
      .optional()
  })
  .strict();

/**
 * A single conversational turn of "Correct with Parfait" -- interprets the user's freeform
 * message against the commitment's current state and returns structured proposed changes. Never
 * mutates anything (that only ever happens via POST .../correction/apply after the user clicks
 * Apply -- see lib/commitment-correction/validate.ts for why that endpoint never trusts this
 * one's output directly). The conversation itself is not persisted server-side (see the PR
 * description's migration-policy note) -- the client resends bounded history each turn.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  }

  const [participantOptions, { data: meeting }] = await Promise.all([
    loadMeetingParticipantOptions(commitment.meeting_id),
    supabaseAdmin.from("meetings").select("id, title").eq("id", commitment.meeting_id).maybeSingle()
  ]);

  const correctionContext = buildCommitmentCorrectionContext({
    commitment,
    sourceMeeting: meeting ? { id: meeting.id, title: meeting.title ?? null } : null,
    participantOptions
  });

  const agentResult = await runCommitmentCorrectionAgent({
    context: correctionContext,
    history: parsed.data.history ?? [],
    latestUserMessage: parsed.data.message
  });

  if (!agentResult.ok) {
    return NextResponse.json(
      {
        responseType: "answer",
        message: "Sorry, I couldn't understand that. Could you describe the correction differently?",
        changes: []
      },
      { status: 200 }
    );
  }

  return NextResponse.json(agentResult.result);
}
