import { NextResponse } from "next/server";

import {
  analyzeTranscriptWithOpenAI,
  buildCleanTranscript
} from "@/lib/analysis";
import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { InsightCategory } from "@/lib/types";

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
    .select("speaker, text, timestamp")
    .eq("meeting_id", id)
    .order("timestamp", { ascending: true });

  if (segmentsError) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: segmentsError.message },
      { status: 500 }
    );
  }

  const transcript = buildCleanTranscript(segments ?? []);
  if (!transcript.trim()) {
    return NextResponse.json(
      { error: "No transcript available yet" },
      { status: 400 }
    );
  }

  const analysis = await analyzeTranscriptWithOpenAI(transcript);
  if (!analysis.ok) {
    return NextResponse.json(
      {
        error: "Transcript analysis failed",
        details: analysis.details ?? analysis.error
      },
      { status: 502 }
    );
  }

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

  const structured = analysis.data;
  const payload: Array<{
    meeting_id: string;
    category: InsightCategory;
    content: string;
    confidence: number | null;
  }> = [
    {
      meeting_id: id,
      category: "product_summary",
      content: structured.product_summary,
      confidence: null
    },
    ...structured.requirements.map((content) => ({
      meeting_id: id,
      category: "requirements" as const,
      content,
      confidence: null
    })),
    ...structured.features.map((content) => ({
      meeting_id: id,
      category: "features" as const,
      content,
      confidence: null
    })),
    ...structured.user_stories.map((content) => ({
      meeting_id: id,
      category: "user_stories" as const,
      content,
      confidence: null
    })),
    ...structured.technical_constraints.map((content) => ({
      meeting_id: id,
      category: "technical_constraints" as const,
      content,
      confidence: null
    })),
    ...structured.design_preferences.map((content) => ({
      meeting_id: id,
      category: "design_preferences" as const,
      content,
      confidence: null
    })),
    ...structured.implementation_details.map((content) => ({
      meeting_id: id,
      category: "implementation_details" as const,
      content,
      confidence: null
    })),
    ...structured.open_questions.map((content) => ({
      meeting_id: id,
      category: "open_questions" as const,
      content,
      confidence: null
    })),
    ...structured.risks.map((content) => ({
      meeting_id: id,
      category: "risks" as const,
      content,
      confidence: null
    })),
    ...structured.next_steps.map((content) => ({
      meeting_id: id,
      category: "next_steps" as const,
      content,
      confidence: null
    }))
  ];

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

  return NextResponse.json({ analysis: structured, insights: inserted });
}
