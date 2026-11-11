import {
  fetchRecallTranscript,
  getRecallTranscriptDiagnostics,
  parseRecallTranscriptToSegments,
  type ParsedTranscriptSegment
} from "@/lib/recall/transcript";
import { shouldSkipDuplicateCompletion } from "@/lib/recall/webhook-events";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  applyGuardedMeetingStatus,
  commitTranscriptAndEnqueueAnalysis,
  type CommitTranscriptResult
} from "@/lib/transcript-commit";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";
import type { Meeting } from "@/lib/types";

// The forward-only status guard and the transactional transcript replace are source-independent
// and live in lib/transcript-commit.ts. Re-exported so existing Recall callers (webhook,
// sync-status, dev reimport) keep importing them from here unchanged.
export { applyGuardedMeetingStatus, replaceTranscriptSegments } from "@/lib/transcript-commit";

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
 * Recall-specific half of an import: fetch the bot's transcript artifact and parse it into
 * transcript rows (speaker labels normalized). Writes nothing. An empty result means Recall has
 * not made a downloadable transcript available yet.
 */
export async function fetchRecallTranscriptRows(recallBotId: string): Promise<ParsedTranscriptSegment[]> {
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

  return transcriptRows;
}

/** Injectable I/O for processCompletedRecallMeeting; production callers use the defaults. */
export type RecallMeetingProcessingDeps = {
  claimTranscriptImport: (meetingId: string) => Promise<TranscriptImportClaimResult>;
  releaseTranscriptImportClaim: (meetingId: string) => Promise<void>;
  applyGuardedMeetingStatus: (meetingId: string, status: Meeting["status"]) => Promise<boolean>;
  fetchRecallTranscriptRows: (recallBotId: string) => Promise<ParsedTranscriptSegment[]>;
  commitTranscriptAndEnqueueAnalysis: (input: {
    meetingId: string;
    segments: ParsedTranscriptSegment[];
    requestOrigin?: string;
  }) => Promise<CommitTranscriptResult>;
};

export const defaultRecallMeetingProcessingDeps: RecallMeetingProcessingDeps = {
  claimTranscriptImport,
  releaseTranscriptImportClaim,
  applyGuardedMeetingStatus,
  fetchRecallTranscriptRows,
  commitTranscriptAndEnqueueAnalysis: (input) => commitTranscriptAndEnqueueAnalysis(input)
};

/**
 * The single shared entry point for processing a completed Recall meeting -- called both
 * automatically (via the transcript-import workflow, dispatched for every transcript.done/
 * recording.done delivery) and manually (Sync Status's explicit recovery click). Concurrency
 * safety comes entirely from claimTranscriptImport below: only the one invocation that wins the
 * atomic claim does any real work (Recall fetch, transcript replace, transcript_ready transition,
 * analysis enqueue); every other concurrent invocation -- automatic or manual, for the same
 * meeting -- returns cleanly as already_processing/already_processed without fetching, deleting,
 * inserting, or enqueueing anything.
 *
 * Recall-specific steps (claim, fetch, parse, "not downloadable yet") stay here. The
 * source-independent tail -- transactional replace, guarded transcript_ready transition, and
 * enqueueMeetingAnalysis only for the winner of that transition -- is
 * commitTranscriptAndEnqueueAnalysis (lib/transcript-commit.ts), shared with manual imports.
 */
export async function processCompletedRecallMeeting(
  {
    meetingId,
    recallBotId,
    requestOrigin
  }: {
    meetingId: string;
    recallBotId: string;
    requestOrigin?: string;
  },
  deps: RecallMeetingProcessingDeps = defaultRecallMeetingProcessingDeps
): Promise<RecallMeetingProcessingResult> {
  const claim = await deps.claimTranscriptImport(meetingId);
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
    await deps.applyGuardedMeetingStatus(meetingId, "processing");

    const transcriptRows = await deps.fetchRecallTranscriptRows(recallBotId);

    if (transcriptRows.length === 0) {
      // Stay in "processing", never fall back to "recording". Release the claim so a later
      // delivery can legitimately retry once the artifact is actually ready.
      await deps.applyGuardedMeetingStatus(meetingId, "processing");
      await deps.releaseTranscriptImportClaim(meetingId);
      return {
        status: "processing",
        insertedCount: 0,
        parsedCount: 0,
        analysisStatus: "not_started",
        message: "Meeting ended; the transcript artifact is not downloadable yet."
      };
    }

    const committed = await deps.commitTranscriptAndEnqueueAnalysis({
      meetingId,
      segments: transcriptRows,
      requestOrigin
    });

    if (committed.status === "transition_lost") {
      // The transcript import claim already serializes this in the normal case, so this branch
      // is only reachable if the meeting's status moved past "processing" through some other
      // path (e.g. independently marked failed) between the claim above and the transition.
      // Either way, the transcript import claim does not by itself grant the right to enqueue
      // analysis -- only an actual transcript_ready transition does, so nothing was enqueued.
      return {
        status: "transcript_ready",
        insertedCount: committed.insertedCount,
        parsedCount: transcriptRows.length,
        analysisStatus: "not_started",
        message: "Transcript imported, but this meeting had already moved past processing."
      };
    }

    if (committed.status === "analysis_enqueue_failed") {
      console.warn("[recall-processing] Analysis enqueue failed after transcript import", {
        meeting_id: meetingId,
        error: committed.error,
        details: committed.details
      });
      return {
        status: "transcript_ready",
        insertedCount: committed.insertedCount,
        parsedCount: transcriptRows.length,
        analysisStatus: "enqueue_failed",
        message:
          "Transcript imported successfully. Analysis could not be queued; retry Analyze Meeting."
      };
    }

    return {
      status: "transcript_ready",
      insertedCount: committed.insertedCount,
      parsedCount: transcriptRows.length,
      analysisStatus: "queued",
      jobId: committed.jobId,
      generation: committed.generation,
      message: "Transcript imported. Analysis queued in the background."
    };
  } catch (error) {
    // Never leave the claim held by a run that's dying -- a thrown error here (a Recall fetch
    // failure, a Supabase error, anything) must not permanently block every future import
    // attempt for this meeting. Best-effort: a failure to release must never mask the original
    // error that triggered it.
    await deps.releaseTranscriptImportClaim(meetingId).catch((releaseError) => {
      console.error("[recall-processing] Failed to release transcript import claim after error", {
        meeting_id: meetingId,
        release_error: releaseError instanceof Error ? releaseError.message : "Unknown error"
      });
    });
    throw error;
  }
}
