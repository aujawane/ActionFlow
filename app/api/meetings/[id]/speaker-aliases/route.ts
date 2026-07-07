import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
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

  const { data: aliases, error } = await supabaseAdmin
    .from("meeting_speaker_aliases")
    .select("*")
    .eq("meeting_id", id)
    .order("raw_speaker_label", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to load speaker aliases.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ aliases: aliases ?? [] });
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

  const rows = aliases
    .map((alias) => ({
      meeting_id: id,
      raw_speaker_label:
        typeof alias.raw_speaker_label === "string" ? alias.raw_speaker_label.trim() : "",
      display_name: typeof alias.display_name === "string" ? alias.display_name.trim() : ""
    }))
    .filter((alias) => alias.raw_speaker_label && alias.display_name);

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "At least one alias with raw_speaker_label and display_name is required." },
      { status: 400 }
    );
  }

  const { data: savedAliases, error } = await supabaseAdmin
    .from("meeting_speaker_aliases")
    .upsert(rows, { onConflict: "meeting_id,raw_speaker_label" })
    .select("*")
    .order("raw_speaker_label", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to save speaker aliases.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ aliases: savedAliases ?? [] });
}
