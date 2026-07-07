import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  parseRecallTranscriptToSegments,
  type RecallTranscriptEntry
} from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";

type ReimportTranscriptRequest = {
  meetingId?: unknown;
  transcript?: unknown;
};

function getSampleSpeakers(speakers: string[]) {
  return Array.from(new Set(speakers)).slice(0, 5);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => null)) as ReimportTranscriptRequest | null;
  const meetingId = typeof body?.meetingId === "string" ? body.meetingId.trim() : "";
  const transcript = Array.isArray(body?.transcript) ? body.transcript : null;

  if (!meetingId) {
    return NextResponse.json({ error: "meetingId is required." }, { status: 400 });
  }

  if (!transcript) {
    return NextResponse.json(
      { error: "transcript must be an array of Recall transcript entries." },
      { status: 400 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", auth.user.id)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json(
      { error: "Meeting not found.", details: meetingError?.message },
      { status: 404 }
    );
  }

  const parsedRows = parseRecallTranscriptToSegments(transcript as RecallTranscriptEntry[]);
  const speakers = parsedRows.map((row) => row.speaker ?? "Unknown Speaker");
  console.info("[dev/reimport-transcript] entries received", {
    meeting_id: meetingId,
    entry_count: transcript.length,
    parsed_segment_count: parsedRows.length,
    sample_speakers: getSampleSpeakers(speakers)
  });

  const { error: deleteError } = await supabaseAdmin
    .from("transcript_segments")
    .delete()
    .eq("meeting_id", meetingId);

  if (deleteError) {
    return NextResponse.json(
      { error: "Failed to delete existing transcript segments.", details: deleteError.message },
      { status: 500 }
    );
  }

  let insertedCount = 0;
  if (parsedRows.length > 0) {
    const { data: insertedRows, error: insertError } = await supabaseAdmin
      .from("transcript_segments")
      .insert(
        parsedRows.map((row) => ({
          meeting_id: meetingId,
          speaker: row.speaker ?? "Unknown Speaker",
          text: row.text,
          timestamp: row.timestamp,
          raw_payload: row.raw_payload
        }))
      )
      .select("id");

    if (insertError) {
      return NextResponse.json(
        { error: "Failed to insert transcript segments.", details: insertError.message },
        { status: 500 }
      );
    }

    insertedCount = insertedRows?.length ?? 0;
  }

  console.info("[dev/reimport-transcript] segments inserted", {
    meeting_id: meetingId,
    inserted_count: insertedCount,
    sample_speakers: getSampleSpeakers(speakers)
  });

  return NextResponse.json({
    ok: true,
    meetingId,
    receivedEntries: transcript.length,
    insertedSegments: insertedCount,
    sampleSpeakers: getSampleSpeakers(speakers)
  });
}
