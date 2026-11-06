import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { handleAnalyzeV2Request } from "@/lib/meeting-analysis/analyze-v2-request";
import {
  enqueueMeetingAnalysisV2,
  isAnalysisPipelineV2EnabledForMeeting
} from "@/lib/meeting-analysis/enqueue-v2";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Explicitly enqueues a pipeline-v2 analysis for one owned meeting. 404 unless the v2 gate is
 * open for this meeting (ANALYSIS_PIPELINE_V2_ENABLED=true and the meeting is in
 * ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS; see lib/meeting-analysis/v2-activation.ts).
 * No internal-secret bypass, no webhook caller; the normal /analyze route stays on v1.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const { status, body } = await handleAnalyzeV2Request(id, {
    isEnabledForMeeting: (meetingId) => isAnalysisPipelineV2EnabledForMeeting(meetingId),
    authenticate: async () => {
      const auth = await requireApiUser();
      return auth.user ? { userId: auth.user.id } : null;
    },
    findOwnedMeeting: async (meetingId, userId) => {
      const { data: meeting } = await supabaseAdmin
        .from("meetings")
        .select("id")
        .eq("id", meetingId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      return Boolean(meeting);
    },
    countTranscriptSegments: async (meetingId) => {
      const { count, error } = await supabaseAdmin
        .from("transcript_segments")
        .select("id", { count: "exact", head: true })
        .eq("meeting_id", meetingId);
      return { count: count ?? 0, error: error?.message ?? null };
    },
    enqueue: async (meetingId) => {
      const enqueued = await enqueueMeetingAnalysisV2(meetingId);
      return enqueued.ok
        ? enqueued
        : { ok: false, error: enqueued.error, details: "details" in enqueued ? enqueued.details : undefined };
    }
  });
  return NextResponse.json(body, { status });
}
