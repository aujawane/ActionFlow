import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  getMeetingSpeakerResolution,
  saveMeetingSpeakerMappings
} from "@/lib/speaker-resolution";
import { supabaseAdmin } from "@/lib/supabase/admin";

type AliasInput = {
  raw_speaker_label?: unknown;
  display_name?: unknown;
};

async function getOwnedMeeting(meetingId: string, userId: string) {
  const { data: meeting, error } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();

  return { meeting, error };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { meeting, error: meetingError } = await getOwnedMeeting(id, auth.user.id);
  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  try {
    const result = await getMeetingSpeakerResolution(id);
    return NextResponse.json({ aliases: result.aliases });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load speaker aliases.",
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
  const { meeting, error: meetingError } = await getOwnedMeeting(id, auth.user.id);
  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { aliases?: unknown } | null;
  const aliases = Array.isArray(body?.aliases) ? (body.aliases as AliasInput[]) : null;
  if (!aliases) {
    return NextResponse.json({ error: "aliases must be an array." }, { status: 400 });
  }

  const mappings = aliases
    .map((alias) => ({
      rawSpeakerLabel:
        typeof alias.raw_speaker_label === "string"
          ? alias.raw_speaker_label.trim()
          : "",
      displayName:
        typeof alias.display_name === "string" ? alias.display_name.trim() : ""
    }))
    .filter((alias) => alias.rawSpeakerLabel && alias.displayName);

  if (mappings.length === 0) {
    return NextResponse.json(
      { error: "At least one alias with raw_speaker_label and display_name is required." },
      { status: 400 }
    );
  }

  try {
    const result = await saveMeetingSpeakerMappings(id, mappings);
    return NextResponse.json({ aliases: result.aliases });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to save speaker aliases.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
