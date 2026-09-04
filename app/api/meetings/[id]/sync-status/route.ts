import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { fetchRecallBotStatus } from "@/lib/recall/client";
import { applyGuardedMeetingStatus, processCompletedRecallMeeting } from "@/lib/recall/processing";
import { mapBotLifecycleCodeToMeetingStatus } from "@/lib/recall/webhook-events";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Explicit, user-initiated recovery: asks Recall directly for a bot's authoritative status and
 * imports the transcript when ready. This is a manual action (a button click), not a poller --
 * Parfait does not call this automatically on a timer or on page load. Normal lifecycle updates
 * come from /api/recall/webhook; this exists only to recover a meeting if a webhook was missed.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, recall_bot_id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  if (!meeting.recall_bot_id) {
    return NextResponse.json({ error: "Meeting has no Recall bot id" }, { status: 400 });
  }

  const recallStatus = await fetchRecallBotStatus(meeting.recall_bot_id);
  const mappedStatus = mapBotLifecycleCodeToMeetingStatus(recallStatus.status);

  console.info("[sync-status] Recall bot status", {
    meeting_id: id,
    recall_bot_id: meeting.recall_bot_id,
    recall_status: recallStatus.status,
    mapped_status: mappedStatus,
    transcript_exists: recallStatus.transcriptAvailable
  });

  if (mappedStatus === "failed") {
    await supabaseAdmin.from("meetings").update({ status: "failed" }).eq("id", id);
    return NextResponse.json({
      status: "failed",
      recallStatus: recallStatus.status,
      transcriptExists: recallStatus.transcriptAvailable,
      insertedSegments: 0
    });
  }

  const shouldAttemptImport = recallStatus.transcriptAvailable || mappedStatus === "processing";

  if (shouldAttemptImport) {
    const result = await processCompletedRecallMeeting({
      meetingId: id,
      recallBotId: meeting.recall_bot_id,
      requestOrigin: new URL(request.url).origin
    });

    if (result.status === "processing" || result.status === "already_processed") {
      return NextResponse.json(
        {
          status: result.status,
          recallStatus: recallStatus.status,
          transcriptExists: result.status === "already_processed",
          insertedSegments: result.insertedCount,
          analysisStatus: result.analysisStatus,
          message: result.message
        },
        { status: result.status === "processing" ? 202 : 200 }
      );
    }

    console.info("[sync-status] Transcript processed", {
      meeting_id: id,
      recall_bot_id: meeting.recall_bot_id,
      inserted_segments: result.insertedCount,
      analysis_status: result.analysisStatus,
      job_id: result.jobId,
      generation: result.generation
    });

    return NextResponse.json({
      status: result.status,
      recallStatus: recallStatus.status,
      transcriptExists: true,
      insertedSegments: result.insertedCount,
      analysisStatus: result.analysisStatus,
      jobId: result.jobId,
      generation: result.generation,
      message: result.message
    });
  }

  if (mappedStatus) {
    const applied = await applyGuardedMeetingStatus(id, mappedStatus);
    return NextResponse.json({
      status: mappedStatus,
      recallStatus: recallStatus.status,
      transcriptExists: recallStatus.transcriptAvailable,
      insertedSegments: 0,
      applied
    });
  }

  return NextResponse.json({
    status: "unchanged",
    recallStatus: recallStatus.status,
    transcriptExists: recallStatus.transcriptAvailable,
    insertedSegments: 0,
    message: "No new updates from Recall yet."
  });
}

export const GET = POST;
