import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const meetingId = new URL(request.url).searchParams.get("meetingId")?.trim();
  if (!meetingId) {
    return NextResponse.json({ error: "meetingId is required." }, { status: 400 });
  }
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 });

  const [segments, events, commitments, tasks, job] = await Promise.all([
    supabaseAdmin.from("transcript_segments").select("id, timestamp, speaker, text").eq("meeting_id", meetingId).order("timestamp"),
    supabaseAdmin.from("meeting_conversation_events").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_commitments").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_tasks").select("*").eq("meeting_id", meetingId).order("created_at"),
    supabaseAdmin.from("meeting_analysis_jobs").select("generation, status, current_stage, checkpoint").eq("meeting_id", meetingId).order("generation", { ascending: false }).limit(1).maybeSingle()
  ]);
  const error = segments.error ?? events.error ?? commitments.error ?? tasks.error ?? job.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    meeting_id: meetingId,
    pipeline: {
      transcript: segments.data ?? [],
      conversation_events: events.data ?? [],
      execution_graph: {
        commitments: commitments.data ?? [],
        tasks: tasks.data ?? []
      },
      execution_intelligence_v2: {
        generation: job.data?.generation ?? null,
        status: job.data?.status ?? null,
        stage: job.data?.current_stage ?? null,
        reasoning_trace:
          (job.data?.checkpoint as { state?: { reasoningTrace?: unknown } } | null)
            ?.state?.reasoningTrace ?? null
      }
    }
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
