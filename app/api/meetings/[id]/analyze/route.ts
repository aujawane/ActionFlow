import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Enqueues durable background analysis and returns immediately.
 * Heavy model work runs in the Vercel Workflow worker, not this request.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const configuredInternalSecret = process.env.RECALL_WEBHOOK_SECRET?.trim();
  const suppliedInternalSecret = request.headers
    .get("x-parfait-internal-secret")
    ?.trim();
  const isTrustedInternalRequest =
    Boolean(configuredInternalSecret) &&
    suppliedInternalSecret === configuredInternalSecret;

  let userId: string | null = null;
  if (!isTrustedInternalRequest) {
    const auth = await requireApiUser();
    if (auth.response) return auth.response;
    userId = auth.user.id;
  }

  const { id } = await context.params;

  let meetingQuery = supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null);
  if (userId) {
    meetingQuery = meetingQuery.eq("user_id", userId);
  }
  const { data: meeting } = await meetingQuery.single();

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
    return NextResponse.json(
      { error: "No transcript available yet" },
      { status: 400 }
    );
  }

  const enqueued = await enqueueMeetingAnalysis(id);
  if (!enqueued.ok) {
    return NextResponse.json(
      { error: enqueued.error, details: enqueued.details },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      accepted: true,
      jobId: enqueued.jobId,
      generation: enqueued.generation,
      status: enqueued.status,
      message: "Meeting analysis queued."
    },
    { status: 202 }
  );
}
