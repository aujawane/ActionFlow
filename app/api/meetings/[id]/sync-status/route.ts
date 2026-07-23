import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { fetchRecallBotStatus } from "@/lib/recall/client";
import { processCompletedRecallMeeting } from "@/lib/recall/processing";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Vercel plan assumption: Pro. Sync may trigger full transcript + analysis processing.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

function isRecallDone(status: string) {
  const normalized = status.toLowerCase();
  return (
    normalized.includes("done") ||
    normalized.includes("complete") ||
    normalized.includes("completed") ||
    normalized.includes("ended") ||
    normalized.includes("finished")
  );
}

function isRecallFailed(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error") || normalized.includes("fatal");
}

function isRecallActive(status: string) {
  const normalized = status.toLowerCase();
  return (
    normalized.includes("call") ||
    normalized.includes("record") ||
    normalized.includes("join") ||
    normalized.includes("active")
  );
}

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
  console.info("[sync-status] Recall bot status", {
    meeting_id: id,
    recall_bot_id: meeting.recall_bot_id,
    recall_status: recallStatus.status,
    transcript_exists: recallStatus.transcriptAvailable
  });

  if (isRecallFailed(recallStatus.status)) {
    await supabaseAdmin
      .from("meetings")
      .update({ status: "failed" })
      .eq("id", id);
    return NextResponse.json({
      status: "failed",
      recallStatus: recallStatus.status,
      transcriptExists: recallStatus.transcriptAvailable,
      insertedSegments: 0
    });
  }

  if (isRecallDone(recallStatus.status) || recallStatus.transcriptAvailable) {
    const result = await processCompletedRecallMeeting({
      meetingId: id,
      recallBotId: meeting.recall_bot_id,
      requestOrigin: new URL(request.url).origin
    });
    if (result.status === "recording") {
      return NextResponse.json(
        {
          status: result.status,
          recallStatus: recallStatus.status,
          transcriptExists: false,
          insertedSegments: result.insertedCount,
          analysisStatus: result.analysisStatus,
          message: result.message
        },
        { status: 202 }
      );
    }

    console.info("[sync-status] Transcript processed", {
      meeting_id: id,
      recall_bot_id: meeting.recall_bot_id,
      inserted_segments: result.insertedCount,
      analysis_status: result.analysisStatus
    });

    return NextResponse.json({
      status: result.status,
      recallStatus: recallStatus.status,
      transcriptExists: true,
      insertedSegments: result.insertedCount,
      analysisStatus: result.analysisStatus,
      message: result.message
    });
  }

  const nextStatus = isRecallActive(recallStatus.status) ? "recording" : "joining";
  await supabaseAdmin.from("meetings").update({ status: nextStatus }).eq("id", id);

  return NextResponse.json({
    status: nextStatus,
    recallStatus: recallStatus.status,
    transcriptExists: recallStatus.transcriptAvailable,
    insertedSegments: 0
  });
}

export const GET = POST;
