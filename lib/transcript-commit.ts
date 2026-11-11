import { enqueueMeetingAnalysis, type EnqueueAnalysisResult } from "@/lib/meeting-analysis/enqueue";
import { allowedPriorStatuses } from "@/lib/recall/webhook-events";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Meeting } from "@/lib/types";

/**
 * The source-independent end of transcript ingestion. Whatever produced a transcript -- the Recall
 * bot today, a manual upload or paste later -- finishes the same way: replace the meeting's
 * transcript atomically, move the meeting to transcript_ready through the forward-only guard, and
 * queue analysis through the one normal entry point, but only if this caller won that transition.
 *
 * Source-specific work (Recall's import claim, fetch and parse; an import's file parsing) happens
 * before this and is not this module's concern. Nothing here selects a pipeline: analysis always
 * goes through enqueueMeetingAnalysis, the same path every product caller uses.
 */

/** One transcript row to persist. `timestamp` is null when the source has no absolute time --
 * never a placeholder (see lib/transcript-order.ts for how such rows are ordered). */
export type CommittableTranscriptSegment = {
  speaker: string | null;
  participant_name: string | null;
  text: string;
  timestamp: string | null;
  raw_payload: unknown;
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

/**
 * Transactional, canonical transcript replacement -- the shared low-level primitive behind both
 * the Recall-authoritative import path and the dev-only raw-transcript reimport route
 * (app/api/dev/reimport-transcript/route.ts). One call to replace_meeting_transcript_segments(),
 * which performs the delete+insert inside a single Postgres transaction while holding a row lock
 * on the meeting, serializing any concurrent replacement attempt for the same meeting_id
 * regardless of which caller/code path initiated it. (It replaced an earlier non-transactional
 * delete-then-insert that let two concurrent imports each delete 0 rows and then both insert.)
 * This function has no opinion about WHETHER a caller may replace a given meeting's transcript
 * right now -- that is the caller's job (claimTranscriptImport for the automatic Recall path);
 * this is purely "do the replacement atomically".
 */
export async function replaceTranscriptSegments(
  meetingId: string,
  rows: CommittableTranscriptSegment[]
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

export type CommitTranscriptResult =
  /** Segments replaced, but the meeting had already moved past transcript_ready's prior statuses
   * by some other path, so this caller did not win the right to queue analysis. */
  | { status: "transition_lost"; insertedCount: number }
  | { status: "analysis_queued"; insertedCount: number; jobId: string; generation: number }
  | { status: "analysis_enqueue_failed"; insertedCount: number; error: string; details?: string };

export type CommitTranscriptDeps = {
  replaceTranscriptSegments: (
    meetingId: string,
    rows: CommittableTranscriptSegment[]
  ) => Promise<{ insertedCount: number }>;
  applyGuardedMeetingStatus: (meetingId: string, status: Meeting["status"]) => Promise<boolean>;
  enqueueMeetingAnalysis: (
    meetingId: string,
    options: { requestOrigin?: string }
  ) => Promise<EnqueueAnalysisResult>;
};

export const defaultCommitTranscriptDeps: CommitTranscriptDeps = {
  replaceTranscriptSegments,
  applyGuardedMeetingStatus,
  enqueueMeetingAnalysis: (meetingId, options) => enqueueMeetingAnalysis(meetingId, options)
};

/**
 * Replace the transcript, transition to transcript_ready, and queue analysis only if this caller
 * won that transition. Throws (without transitioning or queueing) if the replacement fails, and
 * refuses an empty transcript: a meeting must never reach transcript_ready with nothing to analyze.
 */
export async function commitTranscriptAndEnqueueAnalysis(
  input: {
    meetingId: string;
    segments: CommittableTranscriptSegment[];
    /** Passed through to enqueueMeetingAnalysis unchanged (currently unused there). */
    requestOrigin?: string;
  },
  deps: CommitTranscriptDeps = defaultCommitTranscriptDeps
): Promise<CommitTranscriptResult> {
  const { meetingId, segments, requestOrigin } = input;
  if (segments.length === 0) {
    throw new Error("commitTranscriptAndEnqueueAnalysis requires at least one transcript segment.");
  }

  const { insertedCount } = await deps.replaceTranscriptSegments(meetingId, segments);

  // The transcript import does not by itself grant the right to queue analysis -- only an actual
  // transcript_ready transition does. A caller that loses it (the meeting moved past processing
  // some other way, e.g. independently marked failed) returns without queueing anything.
  const wonTranscriptReady = await deps.applyGuardedMeetingStatus(meetingId, "transcript_ready");
  if (!wonTranscriptReady) {
    return { status: "transition_lost", insertedCount };
  }

  const enqueued = await deps.enqueueMeetingAnalysis(meetingId, { requestOrigin });
  if (!enqueued.ok) {
    return {
      status: "analysis_enqueue_failed",
      insertedCount,
      error: enqueued.error,
      details: enqueued.details
    };
  }
  return {
    status: "analysis_queued",
    insertedCount,
    jobId: enqueued.jobId,
    generation: enqueued.generation
  };
}
