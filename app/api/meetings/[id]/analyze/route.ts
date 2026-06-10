import { NextResponse } from "next/server";

import { extractInsightsFromTranscript } from "@/lib/analysis";
import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .single();

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data: segments, error: segmentsError } = await supabaseAdmin
    .from("transcript_segments")
    .select("content")
    .eq("meeting_id", id)
    .order("started_at", { ascending: true });

  if (segmentsError) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: segmentsError.message },
      { status: 500 }
    );
  }

  const transcript = (segments ?? []).map((s) => s.content).join("\n");
  if (!transcript.trim()) {
    return NextResponse.json(
      { error: "No transcript available yet" },
      { status: 400 }
    );
  }

  const insights = await extractInsightsFromTranscript(transcript);

  const { error: deleteError } = await supabaseAdmin
    .from("extracted_insights")
    .delete()
    .eq("meeting_id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: "Failed to reset previous insights", details: deleteError.message },
      { status: 500 }
    );
  }

  const payload = insights.map((item) => ({
    meeting_id: id,
    category: item.category,
    content: item.content,
    confidence: item.confidence
  }));

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("extracted_insights")
    .insert(payload)
    .select("*");

  if (insertError) {
    return NextResponse.json(
      { error: "Failed to save insights", details: insertError.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ insights: inserted });
}
