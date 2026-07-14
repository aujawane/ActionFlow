import { fetchRecallTranscript, parseRecallTranscriptToSegments } from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type RecallMeetingProcessingResult =
  | {
      status: "recording";
      insertedCount: 0;
      parsedCount: 0;
      analysisStatus: "not_started";
      message: string;
    }
  | {
      status: "completed";
      insertedCount: number;
      parsedCount: number;
      analysisStatus: "completed" | "skipped";
      message: string;
    };

export async function replaceMeetingTranscriptFromRecall({
  meetingId,
  recallBotId
}: {
  meetingId: string;
  recallBotId: string;
}) {
  const transcriptContent = await fetchRecallTranscript(recallBotId);
  const parsedRows = parseRecallTranscriptToSegments(transcriptContent);
  const sampleSpeakers = parsedRows
    .slice(0, 5)
    .map((row) => row.speaker ?? row.participant_name ?? row.diarized_speaker ?? "Unknown Speaker");

  console.info("Recall transcript rows parsed", {
    bot_id: recallBotId,
    transcript_entry_count: parsedRows.length,
    sample_speakers: sampleSpeakers
  });

  if (parsedRows.length === 0) {
    return { insertedCount: 0, parsedCount: 0, ready: false };
  }

  await supabaseAdmin.from("transcript_segments").delete().eq("meeting_id", meetingId);

  const { data: insertedRows, error: insertError } = await supabaseAdmin
    .from("transcript_segments")
    .insert(
      parsedRows.map((row) => ({
        meeting_id: meetingId,
        speaker: row.speaker,
        participant_name: row.participant_name,
        diarized_speaker: row.diarized_speaker,
        speaker_confidence: row.speaker_confidence,
        text: row.text,
        timestamp: row.timestamp,
        raw_payload: row.raw_payload
      }))
    )
    .select("id");

  if (insertError) {
    throw new Error(insertError.message);
  }

  return {
    insertedCount: insertedRows?.length ?? 0,
    parsedCount: parsedRows.length,
    ready: true
  };
}

async function analyzeImportedMeeting(meetingId: string, requestOrigin?: string) {
  const internalSecret = process.env.RECALL_WEBHOOK_SECRET?.trim();
  if (!internalSecret) {
    throw new Error("Missing RECALL_WEBHOOK_SECRET for internal meeting analysis.");
  }

  const baseUrl =
    process.env.INTERNAL_APP_URL?.trim() ||
    (process.env.NODE_ENV !== "production"
      ? "http://localhost:3000"
      : requestOrigin?.replace(/\/$/, ""));
  if (!baseUrl) {
    throw new Error("Missing internal app URL for meeting analysis.");
  }

  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/analyze`, {
    method: "POST",
    headers: {
      "x-parfait-internal-secret": internalSecret
    }
  });
  const responseText = await response.text();
  let body: unknown = responseText;
  try {
    body = responseText ? (JSON.parse(responseText) as unknown) : {};
  } catch {
    body = responseText;
  }

  console.info("[recall-processing] Analysis response", {
    meeting_id: meetingId,
    status: response.status,
    ok: response.ok,
    body
  });

  if (!response.ok) {
    const object = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const details = typeof object?.details === "string" ? object.details : null;
    const error = typeof object?.error === "string" ? object.error : null;
    throw new Error(details || error || responseText || "Meeting analysis failed.");
  }

  const object = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  return object?.skipped === true ? ("skipped" as const) : ("completed" as const);
}

export async function processCompletedRecallMeeting({
  meetingId,
  recallBotId,
  requestOrigin
}: {
  meetingId: string;
  recallBotId: string;
  requestOrigin?: string;
}): Promise<RecallMeetingProcessingResult> {
  const { error: processingStatusError } = await supabaseAdmin
    .from("meetings")
    .update({ status: "processing" })
    .eq("id", meetingId);
  if (processingStatusError) {
    throw new Error(processingStatusError.message);
  }

  const transcriptResult = await replaceMeetingTranscriptFromRecall({
    meetingId,
    recallBotId
  });

  if (!transcriptResult.ready) {
    const { error: recordingStatusError } = await supabaseAdmin
      .from("meetings")
      .update({ status: "recording" })
      .eq("id", meetingId);
    if (recordingStatusError) {
      throw new Error(recordingStatusError.message);
    }
    return {
      status: "recording",
      insertedCount: 0,
      parsedCount: 0,
      analysisStatus: "not_started",
      message: "Transcript not ready yet."
    };
  }

  const analysisStatus = await analyzeImportedMeeting(meetingId, requestOrigin);
  const { error: completedStatusError } = await supabaseAdmin
    .from("meetings")
    .update({ status: "completed" })
    .eq("id", meetingId);
  if (completedStatusError) {
    throw new Error(completedStatusError.message);
  }

  return {
    status: "completed",
    insertedCount: transcriptResult.insertedCount,
    parsedCount: transcriptResult.parsedCount,
    analysisStatus,
    message:
      analysisStatus === "skipped"
        ? "Transcript imported; analysis skipped because the transcript was too short."
        : "Transcript, topics, and tasks processed."
  };
}
