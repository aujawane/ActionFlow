import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
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

  return NextResponse.json({ meeting }, { status: 201 });
}
