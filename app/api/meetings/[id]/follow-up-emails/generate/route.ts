import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { generateMeetingFollowUpEmails } from "@/lib/meeting-follow-up-email-service";
import type { FollowUpEmailMode } from "@/lib/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OpenAI API key is not configured." },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    mode?: unknown;
    regenerate?: unknown;
    recipient_name?: unknown;
  } | null;
  if (body?.mode !== "individual" && body?.mode !== "team_summary") {
    return NextResponse.json(
      { error: "Mode must be individual or team_summary." },
      { status: 400 }
    );
  }
  if (body.regenerate !== undefined && typeof body.regenerate !== "boolean") {
    return NextResponse.json(
      { error: "Regenerate must be a boolean." },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const result = await generateMeetingFollowUpEmails({
    meetingId: id,
    userId: auth.user.id,
    mode: body.mode as FollowUpEmailMode,
    regenerate: body.regenerate === true,
    recipientName:
      typeof body.recipient_name === "string" && body.recipient_name.trim()
        ? body.recipient_name.trim()
        : undefined
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        details: "details" in result ? result.details : undefined
      },
      { status: result.status }
    );
  }

  revalidatePath(`/meetings/${id}`);
  return NextResponse.json({ artifacts: result.artifacts, reused: result.reused });
}
