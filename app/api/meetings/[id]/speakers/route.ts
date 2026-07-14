import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import {
  getMeetingSpeakerResolution,
  saveMeetingSpeakerMappings
} from "@/lib/speaker-resolution";
import { supabaseAdmin } from "@/lib/supabase/admin";

const mappingsSchema = z.object({
  mappings: z
    .array(
      z.object({
        rawSpeakerLabel: z.string().trim().min(1).max(200),
        displayName: z.string().trim().min(1).max(200)
      })
    )
    .min(1)
    .max(100)
});

async function verifyOwnedMeeting(meetingId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();
  return { meeting: data, error };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { meeting } = await verifyOwnedMeeting(id, auth.user.id);
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  try {
    const result = await getMeetingSpeakerResolution(id);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store, max-age=0" }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load speaker roster.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { meeting } = await verifyOwnedMeeting(id, auth.user.id);
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const parsed = mappingsSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid speaker mappings.",
        details: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  try {
    const result = await saveMeetingSpeakerMappings(id, parsed.data.mappings);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store, max-age=0" }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to save speaker mappings.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
