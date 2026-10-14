import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import {
  fetchRecallTranscript,
  getRecallTranscriptDiagnostics,
  parseRecallTranscriptToSegments,
  type ParsedTranscriptSegment
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
      status: "already_processing";
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
      analysisStatus: "queued" | "enqueue_failed" | "not_started";
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

/** A claim older than this is treated as abandoned rather than active, so a meeting can never be
 * permanently stuck if the process holding a claim is hard-killed (a platform-level timeout/OOM
 * kill, the exact failure class the global_correction incident surfaced) before it reaches
 * releaseTranscriptImportClaim's cleanup. A single Recall fetch + transcript replace normally
 * completes in well under a minute; 10 minutes is generous headroom before treating a claim as
 * dead, not a tight budget. */
const TRANSCRIPT_IMPORT_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

export type TranscriptImportClaimResult =
  | { claimed: true }
  | { claimed: false; reason: "already_done" | "already_in_progress" };

/**
 * The one atomic claim automatic Recall-completion processing must win before doing any real
 * work. Deliberately NOT meetings.status -- bot.call_ended/bot.done already move a meeting to
 * "processing" before transcript.done/recording.done (the two artifact-completion events that
 * both trigger an import) are ever received, so by the time an import claim would be attempted,
 * EVERY concurrent deliverer already sees the same "processing" status; it cannot distinguish
 * "nobody is importing yet" from "an import is already in flight" the way this column can.
 *
 * Single atomic `UPDATE ... WHERE ... RETURNING` (the same shape applyGuardedMeetingStatus already
 * uses) -- one caller's update can see and claim an unclaimed (or stale-claimed) row; a second,
 * truly concurrent caller's identical statement simply matches zero rows, by Postgres's own
 * row-level locking, not by any check this function performs itself.
 */
export async function claimTranscriptImport(meetingId: string): Promise<TranscriptImportClaimResult> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - TRANSCRIPT_IMPORT_CLAIM_STALE_AFTER_MS).toISOString();

  const { data, error } = await supabaseAdmin
    .from("meetings")
    .update({ transcript_import_claimed_at: now.toISOString() })
    .eq("id", meetingId)
    .neq("status", "transcript_ready")
    .neq("status", "completed")
    .or(`transcript_import_claimed_at.is.null,transcript_import_claimed_at.lt.${staleBefore}`)
    .select("id");
  if (error) throw new Error(error.message);
  if ((data?.length ?? 0) > 0) return { claimed: true };

  // Lost the claim -- this read is purely to report an accurate reason to the caller; it plays
  // no role in the safety guarantee above, which the atomic update alone already provides.
  const { data: current } = await supabaseAdmin
    .from("meetings")
    .select("status")
    .eq("id", meetingId)
    .maybeSingle();
  const reason =
    current && shouldSkipDuplicateCompletion(current.status as Meeting["status"])
      ? ("already_done" as const)
      : ("already_in_progress" as const);
  return { claimed: false, reason };
}

/** Releases a held import claim so a legitimate later attempt (the transcript genuinely wasn't
 * downloadable yet, or the claimed run threw before finishing) can re-claim and retry. Never
 * called when a run completes successfully through to transcript_ready -- shouldSkipDuplicateCompletion
 * already blocks re-entry for that meeting from that point on, so there is nothing left to
 * release for. Best-effort by design at call sites that use it inside a catch block: a failure
 * here must never mask the original error that triggered the release. */
export async function releaseTranscriptImportClaim(meetingId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("meetings")
    .update({ transcript_import_claimed_at: null })
    .eq("id", meetingId);
  if (error) throw new Error(error.message);
}

/**
 * Transactional, canonical transcript replacement -- the shared low-level primitive behind both
 * the Recall-authoritative import path below and the dev-only raw-transcript reimport route
 * (app/api/dev/reimport-transcript/route.ts). Replaces replaceMeetingTranscriptFromRecall's old
 * two-step `.delete()` then `.insert()` (two separate, non-transactional Supabase calls -- the
 * exact gap that let two concurrent imports each delete 0 rows and then both insert their own
 * full row set) with one call to replace_meeting_transcript_segments(), which performs the
 * delete+insert inside a single Postgres transaction while holding a row lock on the meeting,
 * serializing any concurrent replacement attempt for the same meeting_id regardless of which
 * caller/code path initiated it. This function has no opinion about WHETHER a caller is allowed
 * to replace a given meeting's transcript right now -- that's claimTranscriptImport's job for the
 * automatic path; this is purely "do the replacement atomically," reused by both the gated
 * automatic path and the intentionally-ungated dev tool. */
export async function replaceTranscriptSegments(
  meetingId: string,
  rows: ParsedTranscriptSegment[]
): Promise<{ insertedCount: number }> {
  if (rows.length === 0) {
    const { error } = await supabaseAdmin
      .from("transcript_segments")
      .delete()
      .eq("meeting_id", meetingId);
    if (error) throw new Error(error.message);
    return { insertedCount: 0 };
  }

  const { data, error } = await supabaseAdmin.rpc("replace_meeting_transcript_segments", {
    p_meeting_id: meetingId,
    p_segments: rows.map((row) => ({
      speaker: row.speaker,
      participant_name: row.participant_name,
      text: row.text,
      timestamp: row.timestamp,
      raw_payload: row.raw_payload
    }))
  });
  if (error) throw new Error(error.message);
  return { insertedCount: data?.length ?? 0 };
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

  const { insertedCount } = await replaceTranscriptSegments(meetingId, transcriptRows);

  return {
    insertedCount,
    parsedCount: transcriptRows.length,
    ready: true
  };
}

/**
 * The single shared entry point for processing a completed Recall meeting -- called both
 * automatically (via the transcript-import workflow, dispatched for every transcript.done/
 * recording.done delivery) and manually (Sync Status's explicit recovery click). Concurrency
 * safety comes entirely from claimTranscriptImport below: only the one invocation that wins the
 * atomic claim does any real work (Recall fetch, transcript replace, transcript_ready transition,
 * analysis enqueue); every other concurrent invocation -- automatic or manual, for the same
 * meeting -- returns cleanly as already_processing/already_processed without fetching, deleting,
 * inserting, or enqueueing anything.
 */
export async function processCompletedRecallMeeting({
  meetingId,
  recallBotId,
  requestOrigin
}: {
  meetingId: string;
  recallBotId: string;
  requestOrigin?: string;
}): Promise<RecallMeetingProcessingResult> {
  const claim = await claimTranscriptImport(meetingId);
  if (!claim.claimed) {
    if (claim.reason === "already_done") {
      return {
        status: "already_processed",
        insertedCount: 0,
        parsedCount: 0,
        analysisStatus: "not_started",
        message: "Transcript already imported for this meeting; skipping duplicate completion event."
      };
    }
    return {
      status: "already_processing",
      insertedCount: 0,
      parsedCount: 0,
      analysisStatus: "not_started",
      message: "Transcript import for this meeting is already in progress; skipping duplicate completion event."
    };
  }

  try {
    await applyGuardedMeetingStatus(meetingId, "processing");

    const transcriptResult = await replaceMeetingTranscriptFromRecall({
      meetingId,
      recallBotId
    });

    if (!transcriptResult.ready) {
      // Stay in "processing", never fall back to "recording". Release the claim so a later
      // delivery can legitimately retry once the artifact is actually ready.
      await applyGuardedMeetingStatus(meetingId, "processing");
      await releaseTranscriptImportClaim(meetingId);
      return {
        status: "processing",
        insertedCount: 0,
        parsedCount: 0,
        analysisStatus: "not_started",
        message: "Meeting ended; the transcript artifact is not downloadable yet."
      };
    }

    const wonTranscriptReady = await applyGuardedMeetingStatus(meetingId, "transcript_ready");
    if (!wonTranscriptReady) {
      // The transcript import claim already serializes this in the normal case, so this branch
      // is only reachable if the meeting's status moved past "processing" through some other
      // path (e.g. independently marked failed) between the claim above and here. Either way,
      // the transcript import claim does not by itself grant the right to enqueue analysis --
      // only an actual transcript_ready transition does, so no analysis is enqueued here.
      return {
        status: "transcript_ready",
        insertedCount: transcriptResult.insertedCount,
        parsedCount: transcriptResult.parsedCount,
        analysisStatus: "not_started",
        message: "Transcript imported, but this meeting had already moved past processing."
      };
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
  } catch (error) {
    // Never leave the claim held by a run that's dying -- a thrown error here (a Recall fetch
    // failure, a Supabase error, anything) must not permanently block every future import
    // attempt for this meeting. Best-effort: a failure to release must never mask the original
    // error that triggered it.
    await releaseTranscriptImportClaim(meetingId).catch((releaseError) => {
      console.error("[recall-processing] Failed to release transcript import claim after error", {
        meeting_id: meetingId,
        release_error: releaseError instanceof Error ? releaseError.message : "Unknown error"
      });
    });
    throw error;
  }
}
