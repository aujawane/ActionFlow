import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import {
  fetchRecallTranscript,
  getRecallTranscriptDiagnostics,
  parseRecallTranscriptToSegments
} from "@/lib/recall/transcript";
import { allowedPriorStatuses, shouldSkipDuplicateCompletion } from "@/lib/recall/webhook-events";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";
import type { Meeting } from "@/lib/types";

export type RecallMeetingProcessingResult =
  | {
      status: "already_processed";
      insertedCount: 0;
      parsedCount: 0;
      analysisStatus: "not_started";
      message: string;
    }
  | {
      status: "processing";
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

/**
 * Forward-only, idempotent meeting status write: the update only applies if the meeting's current
 * status is still one Supabase can see as "earlier" than `status` (see allowedPriorStatuses), so a
 * duplicate/out-of-order webhook delivery can never regress an already-advanced meeting. Returns
 * whether the write actually applied (false means the meeting had already moved past `status`).
 */
export async function applyGuardedMeetingStatus(
  meetingId: string,
  status: Meeting["status"]
): Promise<boolean> {
  const priorStatuses = allowedPriorStatuses(status);
  if (priorStatuses.length === 0) return false;

  const { data, error } = await supabaseAdmin
    .from("meetings")
    .update({ status })
    .eq("id", meetingId)
    .in("status", priorStatuses)
    .select("id");
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

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
  const transcriptRows = parsedRows.map(normalizeTranscriptSpeaker);
  const sampleSpeakers = transcriptRows
    .slice(0, 5)
    .map((row) => row.speaker ?? "Unknown Speaker");
  const participantNames = Array.from(
    new Set(
      transcriptRows
        .map((row) => row.participant_name?.trim())
        .filter((name): name is string => Boolean(name))
    )
  ).slice(0, 5);
  const segmentCountBySpeaker = transcriptRows.reduce<Record<string, number>>((counts, row) => {
    const speaker = row.speaker?.trim() || "Unknown Speaker";
    counts[speaker] = (counts[speaker] ?? 0) + 1;
    return counts;
  }, {});

  console.info("Recall transcript rows parsed", {
    bot_id: recallBotId,
    transcript_entry_count: transcriptRows.length,
    sample_speakers: sampleSpeakers,
    participant_names: participantNames,
    segment_count_by_speaker: segmentCountBySpeaker
  });

  if (transcriptRows.length === 0) {
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
      transcriptRows.map((row) => ({
        meeting_id: meetingId,
        speaker: row.speaker,
        participant_name: row.participant_name,
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
    parsedCount: transcriptRows.length,
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
  const { data: existingMeeting, error: fetchError } = await supabaseAdmin
    .from("meetings")
    .select("status")
    .eq("id", meetingId)
    .single();
  if (fetchError || !existingMeeting) {
    throw new Error(fetchError?.message ?? "Meeting not found before transcript import.");
  }

  // A transcript.done/recording.done redelivery (Recall retries non-2xx deliveries, and duplicate
  // deliveries are otherwise possible) must not re-import or re-enqueue analysis for a meeting
  // whose transcript is already persisted.
  if (shouldSkipDuplicateCompletion(existingMeeting.status as Meeting["status"])) {
    return {
      status: "already_processed",
      insertedCount: 0,
      parsedCount: 0,
      analysisStatus: "not_started",
      message: "Transcript already imported for this meeting; skipping duplicate completion event."
    };
  }

  await applyGuardedMeetingStatus(meetingId, "processing");

  const transcriptResult = await replaceMeetingTranscriptFromRecall({
    meetingId,
    recallBotId
  });

  if (!transcriptResult.ready) {
    // Stay in "processing", never fall back to "recording" -- the call has already ended by the
    // time this path runs; the transcript artifact just isn't downloadable yet.
    await applyGuardedMeetingStatus(meetingId, "processing");
    return {
      status: "processing",
      insertedCount: 0,
      parsedCount: 0,
      analysisStatus: "not_started",
      message: "Meeting ended; the transcript artifact is not downloadable yet."
    };
  }

  await applyGuardedMeetingStatus(meetingId, "transcript_ready");

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
