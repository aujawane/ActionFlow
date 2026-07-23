import { NextResponse } from "next/server";
import { z } from "zod";

import {
  generateBuildPromptForTarget,
  type PromptTarget
} from "@/lib/prompt-generation";
import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Vercel plan assumption: Pro. Prompt generation loops over targets with OpenAI.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const TARGETS: PromptTarget[] = ["general", "lovable"];
const requestSchema = z.object({
  topic_id: z.string().uuid().optional()
});

function isMissingRelationError(
  error: { code?: string; message?: string } | null,
  relation: string
) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return error.message?.toLowerCase().includes(relation.toLowerCase()) ?? false;
}

function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  column: string
) {
  if (!error) return false;
  if (error.code === "42703") return true;
  return error.message?.toLowerCase().includes(column.toLowerCase()) ?? false;
}

function isInvalidEnumValueError(
  error: { code?: string; message?: string } | null,
  value: string
) {
  if (!error) return false;
  return (
    error.code === "22P02" &&
    (error.message?.toLowerCase().includes(value.toLowerCase()) ?? false)
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
    .select("id, title")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  let parsedBody: z.infer<typeof requestSchema> = {};
  try {
    const rawBody = await request.text();
    if (rawBody.trim()) {
      const parsed = requestSchema.safeParse(JSON.parse(rawBody));
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid request payload", details: parsed.error.flatten() },
          { status: 400 }
        );
      }
      parsedBody = parsed.data;
    }
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const { data: insightsWithTopic, error: insightsError } = await supabaseAdmin
    .from("extracted_insights")
    .select("topic_id, category, content")
    .eq("meeting_id", id);

  let insights = insightsWithTopic;
  if (insightsError && isMissingColumnError(insightsError, "topic_id")) {
    const { data: legacyInsights, error: legacyError } = await supabaseAdmin
      .from("extracted_insights")
      .select("category, content")
      .eq("meeting_id", id);
    if (legacyError) {
      return NextResponse.json(
        { error: "Failed to fetch insights", details: legacyError.message },
        { status: 500 }
      );
    }
    insights = (legacyInsights ?? []).map((item) => ({ ...item, topic_id: null }));
  } else if (insightsError) {
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

  const { data: topics, error: topicsError } = await supabaseAdmin
    .from("meeting_topics")
    .select("id, title")
    .eq("meeting_id", id);
  const topicsMissingTable = isMissingRelationError(topicsError, "meeting_topics");

  const topicId = parsedBody.topic_id;
  const topicRows = topicsMissingTable ? [] : (topics ?? []);
  const hasTopics = topicRows.length > 0;
  if (topicId && !hasTopics) {
    return NextResponse.json(
      { error: "No meeting topics found. Run Analyze Meeting first." },
      { status: 400 }
    );
  }
  if (topicId && hasTopics && !topicRows.some((topic) => topic.id === topicId)) {
    return NextResponse.json(
      { error: "topic_id does not belong to this meeting" },
      { status: 400 }
    );
  }

  let generated: Array<{ topic_id: string | null; tool_type: PromptTarget; prompt: string }>;
  try {
    if (hasTopics) {
      const targetTopics = topicId
        ? topicRows.filter((topic) => topic.id === topicId)
        : topicRows;

      const generatedByTopic = await Promise.all(
        targetTopics.flatMap((topic) =>
          TARGETS.map(async (target) => {
            const topicInsights = insights.filter((insight) => insight.topic_id === topic.id);
            const prompt = await generateBuildPromptForTarget({
              meetingTitle: `${meeting.title ?? "Untitled meeting"} - ${topic.title}`,
              insights: topicInsights,
              target
            });
            if (!prompt) {
              throw new Error(`OpenAI returned empty ${target} prompt for topic ${topic.id}.`);
            }

            return { topic_id: topic.id, tool_type: target, prompt };
          })
        )
      );

      generated = generatedByTopic.filter(
        (row): row is NonNullable<typeof row> => Boolean(row)
      );
    } else {
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

          return { topic_id: null, tool_type: target, prompt };
        })
      );
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown generation error";
    return NextResponse.json(
      { error: "Failed to generate build-ready prompts", details },
      { status: 502 }
    );
  }

  if (generated.length === 0) {
    return NextResponse.json(
      { error: "No insights available for the selected topic scope." },
      { status: 400 }
    );
  }

  async function columnExists(column: string) {
    const { error } = await supabaseAdmin
      .from("generated_prompts")
      .select(column)
      .limit(1);
    return !isMissingColumnError(error, column);
  }

  const [hasTopicId, hasToolType, hasTargetTool] = await Promise.all([
    columnExists("topic_id"),
    columnExists("tool_type"),
    columnExists("target_tool")
  ]);

  if (!hasToolType && !hasTargetTool) {
    return NextResponse.json(
      {
        error: "Failed to save prompts",
        details:
          "generated_prompts is missing both tool_type and target_tool columns. Run DB migrations."
      },
      { status: 500 }
    );
  }

  let cleanupQuery = supabaseAdmin.from("generated_prompts").delete().eq("meeting_id", id);
  if (topicId && hasTopicId) {
    cleanupQuery = cleanupQuery.eq("topic_id", topicId);
  }
  const { error: cleanupError } = await cleanupQuery;

  if (cleanupError) {
    return NextResponse.json(
      { error: "Failed to clear old prompts", details: cleanupError.message },
      { status: 500 }
    );
  }

  const buildInsertRows = (mapGeneralToCodex: boolean) =>
    generated.map((item) => {
      const resolvedTool =
        mapGeneralToCodex && item.tool_type === "general" ? "codex" : item.tool_type;
      return {
        meeting_id: id,
        ...(hasTopicId ? { topic_id: item.topic_id } : {}),
        ...(hasToolType ? { tool_type: resolvedTool } : {}),
        ...(hasTargetTool
          ? {
              target_tool:
                resolvedTool === "general" ? "codex" : resolvedTool
            }
          : {}),
        prompt: item.prompt
      };
    });

  let { data, error } = await supabaseAdmin
    .from("generated_prompts")
    .insert(buildInsertRows(false))
    .select("*");

  if (error && hasToolType && isInvalidEnumValueError(error, "general")) {
    const retryMappedEnum = await supabaseAdmin
      .from("generated_prompts")
      .insert(buildInsertRows(true))
      .select("*");
    data = retryMappedEnum.data;
    error = retryMappedEnum.error;
  }

  if (error) {
    return NextResponse.json(
      { error: "Failed to save prompts", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    prompts: data,
    scope: topicId ?? (hasTopics ? "all_topics" : "meeting")
  });
}
