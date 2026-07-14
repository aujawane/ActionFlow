import { fetchRecallTranscript, parseRecallTranscriptToSegments } from "@/lib/recall/transcript";
import {
  buildSpeakerAliasMap,
  getAmbiguousParticipantNames,
  getMappedSpeakerName,
  getRawSpeakerLabel,
  getResolvedSpeakerName
} from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingSpeakerAlias } from "@/lib/types";

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
  const { data: aliasRows, error: aliasesError } = await supabaseAdmin
    .from("meeting_speaker_aliases")
    .select("*")
    .eq("meeting_id", meetingId);
  if (aliasesError) {
    throw new Error(aliasesError.message);
  }

  const aliases = (aliasRows ?? []) as MeetingSpeakerAlias[];
  const aliasMap = buildSpeakerAliasMap(aliases);
  const ambiguousParticipants = getAmbiguousParticipantNames(parsedRows);
  const resolvedRows = parsedRows.map((row) => {
    const rawSpeakerLabel = getRawSpeakerLabel(row);
    const resolvedSpeaker = getMappedSpeakerName(rawSpeakerLabel, aliasMap);
    return {
      ...row,
      resolved_speaker: resolvedSpeaker,
      speaker: getResolvedSpeakerName(
        { ...row, resolved_speaker: resolvedSpeaker },
        aliasMap,
        ambiguousParticipants
      )
    };
  });
  const sampleSpeakers = resolvedRows
    .slice(0, 5)
    .map((row) => row.speaker ?? row.participant_name ?? row.diarized_speaker ?? "Unknown Speaker");
  const participantNames = Array.from(
    new Set(
      resolvedRows
        .map((row) => row.participant_name?.trim())
        .filter((name): name is string => Boolean(name))
    )
  );
  const diarizedSpeakers = Array.from(
    new Set(
      resolvedRows
        .map((row) => row.diarized_speaker?.trim())
        .filter((name): name is string => Boolean(name))
    )
  );
  const segmentCountBySpeaker = resolvedRows.reduce<Record<string, number>>((counts, row) => {
    const speaker = row.speaker?.trim() || "Unknown Speaker";
    counts[speaker] = (counts[speaker] ?? 0) + 1;
    return counts;
  }, {});

  console.info("Recall transcript rows parsed", {
    bot_id: recallBotId,
    transcript_entry_count: resolvedRows.length,
    sample_speakers: sampleSpeakers,
    participant_names: participantNames,
    diarized_speakers: diarizedSpeakers,
    ambiguous_participants: Array.from(ambiguousParticipants),
    preferred_diarized_labels: ambiguousParticipants.size > 0,
    segment_count_by_speaker: segmentCountBySpeaker
  });

  if (resolvedRows.length === 0) {
    return { insertedCount: 0, parsedCount: 0, ready: false };
  }

  const { error: deleteError } = await supabaseAdmin
    .from("transcript_segments")
    .delete()
    .eq("meeting_id", meetingId);
  if (deleteError) {
    throw new Error(deleteError.message);
  }

  const { data: insertedRows, error: insertError } = await supabaseAdmin
    .from("transcript_segments")
    .insert(
      resolvedRows.map((row) => ({
        meeting_id: meetingId,
        speaker: row.speaker,
        participant_name: row.participant_name,
        diarized_speaker: row.diarized_speaker,
        resolved_speaker: row.resolved_speaker,
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
    parsedCount: resolvedRows.length,
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
