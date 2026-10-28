import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  enqueueMeetingAnalysisV2,
  isAnalysisPipelineV2StagingEnabled
} from "@/lib/meeting-analysis/enqueue-v2";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Staging validation only: explicitly enqueues a pipeline-v2 analysis for one owned meeting.
 * 404 unless ANALYSIS_PIPELINE_V2_STAGING_ENABLED=true AND the Supabase project is staging.
 * No internal-secret bypass, no webhook caller; the normal /analyze route stays on v1.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isAnalysisPipelineV2StagingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { count, error: segmentsError } = await supabaseAdmin
    .from("transcript_segments")
    .select("id", { count: "exact", head: true })
    .eq("meeting_id", id);
  if (segmentsError) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: segmentsError.message },
      { status: 500 }
    );
  }
  if (!count || count < 1) {
    return NextResponse.json({ error: "No transcript available yet" }, { status: 400 });
  }

  const enqueued = await enqueueMeetingAnalysisV2(id);
  if (!enqueued.ok) {
    return NextResponse.json(
      { error: enqueued.error, details: "details" in enqueued ? enqueued.details : undefined },
      { status: 500 }
    );
  }
  return NextResponse.json(
    {
      accepted: true,
      pipelineVersion: 2,
      jobId: enqueued.jobId,
      generation: enqueued.generation,
      status: enqueued.status,
      message: "Meeting analysis (pipeline v2) queued."
    },
    { status: 202 }
  );
}
