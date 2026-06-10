import { NextResponse } from "next/server";

import {
  generateBuildPromptForTarget,
  type PromptTarget
} from "@/lib/prompt-generation";
import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const TARGETS: PromptTarget[] = ["codex", "claude_code", "lovable"];

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, title")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data: insights, error: insightsError } = await supabaseAdmin
    .from("extracted_insights")
    .select("category, content")
    .eq("meeting_id", id);

  if (insightsError) {
    return NextResponse.json(
      { error: "Failed to fetch insights", details: insightsError.message },
      { status: 500 }
    );
  }

  if (!insights || insights.length === 0) {
    return NextResponse.json(
      { error: "No extracted insights found. Run Analyze Meeting first." },
      { status: 400 }
    );
  }

  let generated: Array<{ tool_type: PromptTarget; prompt: string }>;
  try {
    generated = await Promise.all(
      TARGETS.map(async (target) => {
        const prompt = await generateBuildPromptForTarget({
          meetingTitle: meeting.title,
          insights,
          target
        });

        if (!prompt) {
          throw new Error(`OpenAI returned empty ${target} prompt.`);
        }

        return { tool_type: target, prompt };
      })
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown generation error";
    return NextResponse.json(
      { error: "Failed to generate build-ready prompts", details },
      { status: 502 }
    );
  }

  const { error: cleanupError } = await supabaseAdmin
    .from("generated_prompts")
    .delete()
    .eq("meeting_id", id);

  if (cleanupError) {
    return NextResponse.json(
      { error: "Failed to clear old prompts", details: cleanupError.message },
      { status: 500 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("generated_prompts")
    .insert(
      generated.map((item) => ({
        meeting_id: id,
        tool_type: item.tool_type,
        prompt: item.prompt
      }))
    )
    .select("*");

  if (error) {
    return NextResponse.json(
      { error: "Failed to save prompts", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ prompts: data });
}
