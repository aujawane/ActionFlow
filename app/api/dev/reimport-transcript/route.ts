import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { replaceTranscriptSegments } from "@/lib/recall/processing";
import {
  parseRecallTranscriptToSegments,
  type RecallTranscriptEntry
} from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";

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
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json(
      { error: "Meeting not found.", details: meetingError?.message },
      { status: 404 }
    );
  }

  const parsedRows = parseRecallTranscriptToSegments(transcript as RecallTranscriptEntry[])
    .map(normalizeTranscriptSpeaker);
  const speakers = parsedRows.map((row) => row.speaker ?? "Unknown Speaker");
  console.info("[dev/reimport-transcript] entries received", {
    meeting_id: meetingId,
    entry_count: transcript.length,
    parsed_segment_count: parsedRows.length,
    sample_speakers: getSampleSpeakers(speakers)
  });

  // Transactional replace (delete+insert in one Postgres transaction, row-locked on the
  // meeting) -- the same shared primitive the Recall-authoritative import path uses, so this
  // dev-only force-overwrite tool can't leave a meeting's transcript half-replaced either.
  // Intentionally NOT gated behind claimTranscriptImport: this route's whole purpose is letting a
  // developer force an overwrite regardless of the meeting's current status/claim state.
  let insertedCount = 0;
  try {
    const result = await replaceTranscriptSegments(
      meetingId,
      parsedRows.map((row) => ({ ...row, speaker: row.speaker ?? "Unknown Speaker" }))
    );
    insertedCount = result.insertedCount;
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to replace transcript segments.",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
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
