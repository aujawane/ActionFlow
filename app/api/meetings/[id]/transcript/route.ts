import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";
import type { TranscriptSegment } from "@/lib/types";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id, status, updated_at")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("transcript_segments")
    .select("*")
    .eq("meeting_id", id)
    .order("timestamp", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: error.message },
      { status: 500 }
    );
  }

  const segments = canonicalTranscriptOrder((data ?? []) as TranscriptSegment[])
    .map(normalizeTranscriptSpeaker);

  return NextResponse.json(
    {
      segments,
      meeting: {
        id: meeting.id,
        status: meeting.status,
        updated_at: meeting.updated_at
      }
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}
