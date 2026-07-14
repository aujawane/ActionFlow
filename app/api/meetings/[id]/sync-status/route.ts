import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { fetchRecallBotStatus } from "@/lib/recall/client";
import { replaceMeetingTranscriptFromRecall } from "@/lib/recall/processing";
import { supabaseAdmin } from "@/lib/supabase/admin";

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

async function runAnalysis(request: Request, meetingId: string) {
  const requestOrigin = new URL(request.url).origin;
  const appUrl =
    process.env.INTERNAL_APP_URL?.trim() ||
    (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : requestOrigin);
  const response = await fetch(`${appUrl}/api/meetings/${meetingId}/analyze`, {
    method: "POST",
    headers: {
      cookie: request.headers.get("cookie") ?? ""
    }
  });
  const responseText = await response.text();
  let body: unknown = responseText;
  try {
    body = responseText ? (JSON.parse(responseText) as unknown) : {};
  } catch {
    body = responseText;
  }

  console.info("[sync-status] Analysis response", {
    meeting_id: meetingId,
    status: response.status,
    ok: response.ok,
    body
  });

  if (!response.ok) {
    const bodyObject = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const details = typeof bodyObject?.details === "string" ? bodyObject.details : null;
    const error = typeof bodyObject?.error === "string" ? bodyObject.error : null;
    throw new Error(details || error || responseText || "Meeting analysis failed.");
  }

  return body;
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
    await supabaseAdmin.from("meetings").update({ status: "processing" }).eq("id", id);

    const { insertedCount, ready } = await replaceMeetingTranscriptFromRecall({
      meetingId: id,
      recallBotId: meeting.recall_bot_id
    });
    if (!ready) {
      return NextResponse.json(
        {
          status: "processing",
          recallStatus: recallStatus.status,
          transcriptExists: false,
          insertedSegments: 0,
          message: "Transcript not ready yet."
        },
        { status: 202 }
      );
    }

    console.info("[sync-status] Transcript processed", {
      meeting_id: id,
      recall_bot_id: meeting.recall_bot_id,
      inserted_segments: insertedCount
    });

    let analysisStatus: "completed" | "failed" | "skipped" = "completed";
    let analysisError: string | null = null;
    try {
      const analysisBody = await runAnalysis(request, id);
      const analysisObject =
        analysisBody && typeof analysisBody === "object"
          ? (analysisBody as Record<string, unknown>)
          : null;
      if (analysisObject?.skipped === true) {
        analysisStatus = "skipped";
      }
    } catch (error) {
      analysisStatus = "failed";
      analysisError = error instanceof Error ? error.message : "Meeting analysis failed.";
      console.error("[sync-status] Analysis failed after transcript import", {
        meeting_id: id,
        recall_bot_id: meeting.recall_bot_id,
        error: analysisError
      });
    }

    await supabaseAdmin.from("meetings").update({ status: "completed" }).eq("id", id);

    return NextResponse.json({
      status: "completed",
      recallStatus: recallStatus.status,
      transcriptExists: true,
      insertedSegments: insertedCount,
      analysisStatus,
      analysisError
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
