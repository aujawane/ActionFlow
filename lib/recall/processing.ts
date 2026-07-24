import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import {
  fetchRecallTranscript,
  getRecallTranscriptDiagnostics,
  parseRecallTranscriptToSegments
} from "@/lib/recall/transcript";
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
      status: "transcript_ready";
      insertedCount: number;
      parsedCount: number;
      analysisStatus: "queued" | "enqueue_failed";
      jobId?: string;
      generation?: number;
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
  console.info("[recall-processing] Transcript import diagnostics", {
    bot_id: recallBotId,
    ...getRecallTranscriptDiagnostics(transcriptContent)
  });
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
  ).slice(0, 5);
  const diarizedSpeakers = Array.from(
    new Set(
      resolvedRows
        .map((row) => row.diarized_speaker?.trim())
        .filter((name): name is string => Boolean(name))
    )
  ).slice(0, 5);
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

  const { error: transcriptReadyError } = await supabaseAdmin
    .from("meetings")
    .update({ status: "transcript_ready" })
    .eq("id", meetingId);
  if (transcriptReadyError) {
    throw new Error(transcriptReadyError.message);
  }

  const enqueued = await enqueueMeetingAnalysis(meetingId, { requestOrigin });
  if (!enqueued.ok) {
    console.warn("[recall-processing] Analysis enqueue failed after transcript import", {
      meeting_id: meetingId,
      error: enqueued.error,
      details: enqueued.details
    });
    return {
      status: "transcript_ready",
      insertedCount: transcriptResult.insertedCount,
      parsedCount: transcriptResult.parsedCount,
      analysisStatus: "enqueue_failed",
      message:
        "Transcript imported successfully. Analysis could not be queued; retry Analyze Meeting."
    };
  }

  return {
    status: "transcript_ready",
    insertedCount: transcriptResult.insertedCount,
    parsedCount: transcriptResult.parsedCount,
    analysisStatus: "queued",
    jobId: enqueued.jobId,
    generation: enqueued.generation,
    message: "Transcript imported. Analysis queued in the background."
  };
}
