import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { GOOGLE_INTEGRATION_PROVIDER } from "@/lib/google-integration";
import { createProviderMeeting } from "@/lib/meeting-providers";
import { createRecallBot } from "@/lib/recall/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { UserIntegration } from "@/lib/types";

const payloadSchema = z.object({
  platform: z.enum(["zoom", "google_meet"]),
  title: z.string().trim().min(1).max(200).optional()
});

async function markMeetingFailed(meetingId: string, message: string) {
  const failedWithBotError = await supabaseAdmin
    .from("meetings")
    .update({
      status: "failed",
      bot_error: message
    } as { status: "failed"; bot_error: string })
    .eq("id", meetingId);

  if (failedWithBotError.error) {
    await supabaseAdmin.from("meetings").update({ status: "failed" }).eq("id", meetingId);
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => null)) as unknown;
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  let googleRefreshToken: string | null = null;
  if (parsed.data.platform === "google_meet") {
    const { data: integration, error: integrationError } = await supabaseAdmin
      .from("user_integrations")
      .select("*")
      .eq("user_id", auth.user.id)
      .eq("provider", GOOGLE_INTEGRATION_PROVIDER)
      .maybeSingle();

    const googleIntegration = integration as UserIntegration | null;
    if (integrationError || !googleIntegration?.refresh_token) {
      return NextResponse.json(
        {
          error: "Google Meet is not connected.",
          details: "Connect Google from Account Integrations before starting Google Meet."
        },
        { status: 400 }
      );
    }

    googleRefreshToken = googleIntegration.refresh_token;
  }

  let providerMeeting: Awaited<ReturnType<typeof createProviderMeeting>>;
  try {
    providerMeeting = await createProviderMeeting(parsed.data.platform, parsed.data.title, {
      googleRefreshToken
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to create provider meeting",
        details: error instanceof Error ? error.message : "Unknown provider error."
      },
      { status: 502 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .insert({
      user_id: auth.user.id,
      title: parsed.data.title ?? null,
      meeting_url: providerMeeting.meetingUrl,
      platform: providerMeeting.platform,
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
    const bot = await createRecallBot({
      meetingUrl: meeting.meeting_url,
      meetingId: meeting.id
    });

    const { data: updatedMeeting, error: updateError } = await supabaseAdmin
      .from("meetings")
      .update({
        recall_bot_id: bot.id,
        status: "recording"
      })
      .eq("id", meeting.id)
      .select("*")
      .single();

    if (updateError || !updatedMeeting) {
      return NextResponse.json(
        {
          error: "Meeting created, but failed to save Recall bot data",
          details: updateError?.message,
          meetingId: meeting.id,
          meetingUrl: meeting.meeting_url,
          platform: meeting.platform
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        meetingId: updatedMeeting.id,
        meetingUrl: updatedMeeting.meeting_url,
        platform: updatedMeeting.platform
      },
      { status: 201 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error while creating Recall bot.";
    await markMeetingFailed(meeting.id, message);

    return NextResponse.json(
      {
        error: "Meeting created, but Recall bot creation failed",
        details: process.env.NODE_ENV !== "production" ? message : "Recall bot creation failed.",
        meetingId: meeting.id,
        meetingUrl: meeting.meeting_url,
        platform: meeting.platform
      },
      { status: 502 }
    );
  }
}
