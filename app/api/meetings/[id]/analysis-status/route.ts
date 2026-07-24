import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { getLatestMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, status")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  try {
    const job = await getLatestMeetingAnalysisJob(id);
    return NextResponse.json({
      meetingId: id,
      meetingStatus: meeting.status,
      job: job
        ? {
            id: job.id,
            generation: job.generation,
            status: job.status,
            current_stage: job.current_stage,
            progress: job.progress,
            error: job.error,
            retry_count: job.retry_count,
            started_at: job.started_at,
            completed_at: job.completed_at,
            created_at: job.created_at,
            updated_at: job.updated_at
          }
        : null
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load analysis status",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
