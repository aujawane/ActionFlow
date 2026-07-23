import { z } from "zod";

import { getOpenAIModel, openai } from "@/lib/openai";
import type { InsightCategory } from "@/lib/types";

const transcriptAnalysisSchema = z
  .object({
    product_summary: z.string(),
    requirements: z.array(z.string()),
    features: z.array(z.string()),
    user_stories: z.array(z.string()),
    technical_constraints: z.array(z.string()),
    design_preferences: z.array(z.string()),
    implementation_details: z.array(z.string()),
    open_questions: z.array(z.string()),
    risks: z.array(z.string()),
    next_steps: z.array(z.string())
  })
  .strict();

export type TranscriptAnalysisResult = z.infer<typeof transcriptAnalysisSchema>;

const topicSegmentationSchema = z
  .object({
    topics: z.array(
      z.object({
        title: z.string().min(1),
        summary: z.string().default(""),
        start_timestamp: z.string().default(""),
        end_timestamp: z.string().default(""),
        segment_ids: z.array(z.string()),
        confidence: z.number().min(0).max(1).nullable().optional(),
        separation_reason: z.string().default("")
      })
    )
  })
  .strict();

export type TopicSegmentationResult = z.infer<typeof topicSegmentationSchema>;

const transcriptAnalysisJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    product_summary: { type: "string" },
    requirements: {
      type: "array",
      items: { type: "string" }
    },
    features: {
      type: "array",
      items: { type: "string" }
    },
    user_stories: {
      type: "array",
      items: { type: "string" }
    },
    technical_constraints: {
      type: "array",
      items: { type: "string" }
    },
    design_preferences: {
      type: "array",
      items: { type: "string" }
    },
    implementation_details: {
      type: "array",
      items: { type: "string" }
    },
    open_questions: {
      type: "array",
      items: { type: "string" }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    },
    next_steps: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "product_summary",
    "requirements",
    "features",
    "user_stories",
    "technical_constraints",
    "design_preferences",
    "implementation_details",
    "open_questions",
    "risks",
    "next_steps"
  ]
};

export function buildCleanTranscript(
  segments: Array<{ speaker: string | null; text: string; timestamp: string }>
) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "Unknown Speaker";
      const time = new Date(segment.timestamp).toISOString();
      const text = segment.text.trim().replace(/\s+/g, " ");
      return `[${time}] ${speaker}: ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export function buildTranscriptWithSegmentIds(
  segments: Array<{ id: string; speaker: string | null; text: string; timestamp: string }>
) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "Unknown Speaker";
      const time = new Date(segment.timestamp).toISOString();
      const text = segment.text.trim().replace(/\s+/g, " ");
      return `[${segment.id}] [${time}] ${speaker}: ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function analyzeTranscriptWithOpenAI(transcript: string): Promise<
  | { ok: true; data: TranscriptAnalysisResult }
  | { ok: false; error: string; details?: string }
> {
  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        {
          role: "system",
          content:
            "You are a senior product analyst and technical architect. Convert meeting transcript content into concise structured implementation-ready outputs."
        },
        {
          role: "user",
          content: `Analyze this transcript and return only valid JSON matching the required schema.\n\n${transcript}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_transcript_analysis",
          strict: true,
          schema: transcriptAnalysisJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned empty output." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid JSON.",
        details: raw.slice(0, 400)
      };
    }

    const validated = transcriptAnalysisSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "OpenAI JSON did not match expected schema.",
        details: validated.error.message
      };
    }

    return { ok: true, data: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to analyze transcript with OpenAI.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export async function segmentMeetingTopicsWithOpenAI(transcript: string): Promise<
  | { ok: true; data: TopicSegmentationResult }
  | { ok: false; error: string; details?: string }
> {
  const segmentationPrompt = [
    "You are analyzing a software product meeting transcript.",
    "",
    "Your first task is NOT to extract requirements.",
    "",
    "Split the meeting into distinct discussion topics.",
    "",
    "A topic should represent one product area, feature, bug, decision, implementation concern, workflow, integration, UI area, or open question.",
    "",
    "Important rules:",
    "- Do not merge unrelated topics.",
    "- Do not create vague topics like 'general discussion'.",
    "- If the meeting jumps back and forth, a topic may contain non-contiguous transcript segments.",
    "- Prefer 3-8 focused topics when the meeting covers multiple areas.",
    "- Every important transcript segment should belong to at least one topic.",
    "- Ignore small talk unless it affects product requirements.",
    "- Return valid JSON only.",
    "",
    "Return this JSON shape:",
    "{",
    '  "topics": [',
    "    {",
    '      "title": "short topic title",',
    '      "summary": "2-4 sentence summary",',
    '      "start_timestamp": "timestamp of earliest related segment",',
    '      "end_timestamp": "timestamp of latest related segment",',
    '      "segment_ids": ["uuid-1", "uuid-2"],',
    '      "confidence": 0.0,',
    '      "separation_reason": "why this is its own topic"',
    "    }",
    "  ]",
    "}"
  ].join("\n");

  const segmentationJsonSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            start_timestamp: { type: "string" },
            end_timestamp: { type: "string" },
            segment_ids: {
              type: "array",
              items: { type: "string" }
            },
            confidence: { type: ["number", "null"] },
            separation_reason: { type: "string" }
          },
          required: [
            "title",
            "summary",
            "start_timestamp",
            "end_timestamp",
            "segment_ids",
            "confidence",
            "separation_reason"
          ]
        }
      }
    },
    required: ["topics"]
  };

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: segmentationPrompt },
        { role: "user", content: transcript }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_topic_segmentation",
          strict: true,
          schema: segmentationJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned empty topic segmentation output." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid topic segmentation JSON.",
        details: raw.slice(0, 400)
      };
    }

    const validated = topicSegmentationSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Topic segmentation JSON did not match schema.",
        details: validated.error.message
      };
    }

    return { ok: true, data: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to segment topics with OpenAI.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export function buildInsightsPayload(input: {
  meetingId: string;
  analysis: TranscriptAnalysisResult;
  topicId?: string | null;
}): Array<{
  meeting_id: string;
  topic_id: string | null;
  category: InsightCategory;
  content: string;
  confidence: number | null;
}> {
  const { meetingId, analysis, topicId = null } = input;
  return [
    {
      meeting_id: meetingId,
      topic_id: topicId,
      category: "product_summary",
      content: analysis.product_summary,
      confidence: null
    },
    ...analysis.requirements.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "requirements" as const,
      content,
      confidence: null
    })),
    ...analysis.features.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "features" as const,
      content,
      confidence: null
    })),
    ...analysis.user_stories.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "user_stories" as const,
      content,
      confidence: null
    })),
    ...analysis.technical_constraints.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "technical_constraints" as const,
      content,
      confidence: null
    })),
    ...analysis.design_preferences.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "design_preferences" as const,
      content,
      confidence: null
    })),
    ...analysis.implementation_details.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "implementation_details" as const,
      content,
      confidence: null
    })),
    ...analysis.open_questions.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "open_questions" as const,
      content,
      confidence: null
    })),
    ...analysis.risks.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "risks" as const,
      content,
      confidence: null
    })),
    ...analysis.next_steps.map((content) => ({
      meeting_id: meetingId,
      topic_id: topicId,
      category: "next_steps" as const,
      content,
      confidence: null
    }))
  ];
}

