import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { createRecallBot } from "@/lib/recall/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

const googleMeetRegex = /^https:\/\/meet\.google\.com\/[a-z0-9-]+($|[/?].*)/i;

const payloadSchema = z.object({
  meetingUrl: z
    .string()
    .url()
    .refine((value) => googleMeetRegex.test(value), {
      message: "meetingUrl must be a valid Google Meet link."
    }),
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
    const bot = await createRecallBot({
      meetingUrl: meeting.meeting_url,
      meetingId: meeting.id
    });

    const { data: updatedMeeting, error: updateError } = await supabaseAdmin
      .from("meetings")
      .update({
        recall_bot_id: bot.id,
        status: "joining"
      })
      .eq("id", meeting.id)
      .select("*")
      .single();

    if (updateError || !updatedMeeting) {
      return NextResponse.json(
        {
          error: "Meeting created, but failed to save Recall bot data",
          details: updateError?.message,
          meeting
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ meeting: updatedMeeting }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error while creating Recall bot.";
    const isDev = process.env.NODE_ENV !== "production";

    const failedWithBotError = await supabaseAdmin
      .from("meetings")
      .update({
        status: "failed",
        bot_error: message
      } as { status: "failed"; bot_error: string })
      .eq("id", meeting.id);

    // If schema does not support bot_error, fallback to other likely error columns.
    if (failedWithBotError.error) {
      const failedWithRecallError = await supabaseAdmin
        .from("meetings")
        .update({
          status: "failed",
          recall_error: message
        } as { status: "failed"; recall_error: string })
        .eq("id", meeting.id);

      if (failedWithRecallError.error) {
        const failedWithErrorMessage = await supabaseAdmin
          .from("meetings")
          .update({
            status: "failed",
            error_message: message
          } as { status: "failed"; error_message: string })
          .eq("id", meeting.id);

        if (failedWithErrorMessage.error) {
          await supabaseAdmin
            .from("meetings")
            .update({ status: "failed" })
            .eq("id", meeting.id);
        }
      }
    }

    const { data: failedMeeting } = await supabaseAdmin
      .from("meetings")
      .select("*")
      .eq("id", meeting.id)
      .single();

    return NextResponse.json(
      {
        error: "Meeting created, but Recall bot creation failed",
        details: isDev ? message : "Recall bot creation failed.",
        meeting: failedMeeting ?? meeting
      },
      { status: 502 }
    );
  }
}
