import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { createRecallBot } from "@/lib/recall";
import { supabaseAdmin } from "@/lib/supabase/admin";

const payloadSchema = z.object({
  meetingUrl: z.string().url(),
  title: z.string().trim().min(1).max(200).optional()
});

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { data, error } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch meetings", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ meetings: data });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .insert({
      user_id: auth.user.id,
      title: parsed.data.title ?? null,
      meeting_url: parsed.data.meetingUrl,
      status: "pending"
    })
    .select("*")
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json(
      { error: "Failed to create meeting", details: meetingError?.message },
      { status: 500 }
    );
  }

  try {
    const webhookUrl = `${env.NEXT_PUBLIC_APP_URL}/api/recall/webhook`;
    const bot = await createRecallBot({
      meetingUrl: meeting.meeting_url,
      webhookUrl,
      meetingId: meeting.id
    });

    const { error: updateError } = await supabaseAdmin
      .from("meetings")
      .update({
        recall_bot_id: bot.id,
        status: "joining"
      })
      .eq("id", meeting.id);

    if (updateError) {
      return NextResponse.json(
        {
          error: "Recall bot created but meeting update failed",
          details: updateError.message,
          meetingId: meeting.id,
          recallBotId: bot.id
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      meeting: { ...meeting, recall_bot_id: bot.id, status: "joining" }
    });
  } catch (error) {
    const { error: failUpdateError } = await supabaseAdmin
      .from("meetings")
      .update({ status: "failed" })
      .eq("id", meeting.id);

    return NextResponse.json(
      {
        error: "Created meeting but failed to create Recall bot",
        details: error instanceof Error ? error.message : "Unknown error",
        meetingId: meeting.id,
        statusUpdateError: failUpdateError?.message ?? null
      },
      { status: 502 }
    );
  }
}
