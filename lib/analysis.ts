import { z } from "zod";

import { OPENAI_MODEL, openai } from "@/lib/openai";
import type {
  InsightCategory,
  MeetingTaskPriority,
  MeetingTaskType,
  MeetingTaskWorkspaceType,
  MeetingTopic
} from "@/lib/types";

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

const topicTaskExtractionSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          task: z.string().min(1),
          owner: z.string().nullable(),
          task_type: z.enum(["commitment", "implicit_commitment", "unassigned_work"]),
          priority: z.enum(["low", "medium", "high"]).default("medium"),
          suggested_steps: z.array(z.string()),
          source_quote: z.string().nullable(),
          confidence: z.number().min(0).max(1).nullable(),
          workspace_type: z.enum([
            "research",
            "email",
            "proposal",
            "coding",
            "documentation",
            "design",
            "meeting_follow_up",
            "planning",
            "testing",
            "decision",
            "learning",
            "other"
          ]),
          workspace_summary: z.string().nullable()
        })
        .strict()
    )
  })
  .strict();

export type TopicTaskExtractionResult = z.infer<typeof topicTaskExtractionSchema>;

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

const topicTaskExtractionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string" },
          owner: { type: ["string", "null"] },
          task_type: {
            type: "string",
            enum: ["commitment", "implicit_commitment", "unassigned_work"]
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"]
          },
          suggested_steps: {
            type: "array",
            items: { type: "string" }
          },
          source_quote: { type: ["string", "null"] },
          confidence: { type: ["number", "null"] },
          workspace_type: {
            type: "string",
            enum: [
              "research",
              "email",
              "proposal",
              "coding",
              "documentation",
              "design",
              "meeting_follow_up",
              "planning",
              "testing",
              "decision",
              "learning",
              "other"
            ]
          },
          workspace_summary: { type: ["string", "null"] }
        },
        required: [
          "task",
          "owner",
          "task_type",
          "priority",
          "suggested_steps",
          "source_quote",
          "confidence",
          "workspace_type",
          "workspace_summary"
        ]
      }
    }
  },
  required: ["tasks"]
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
      model: OPENAI_MODEL,
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

export async function extractTopicTasksWithOpenAI(
  topic: Pick<MeetingTopic, "title" | "summary">,
  transcriptSegments: Array<{ speaker: string | null; text: string; timestamp: string }>
): Promise<
  | { ok: true; data: TopicTaskExtractionResult }
  | { ok: false; error: string; details?: string }
> {
  const transcript = buildCleanTranscript(transcriptSegments);

  const taskExtractionPrompt = [
    "You extract post-meeting action items from exactly one topic in a software product meeting.",
    "",
    "Scope rules:",
    "- Use only the topic and transcript excerpt provided.",
    "- Do not combine tasks across unrelated topics.",
    "- Do not invent tasks unrelated to the transcript.",
    "- If no clear action items exist, return an empty tasks array.",
    "",
    "Extract these task types:",
    "- commitment: a person explicitly commits to doing something, e.g. \"I'll send the email.\"",
    "- implicit_commitment: vague personal follow-up language, e.g. \"I'll look into it\", \"I'll research that\", \"Let me check\", \"I can send that over\".",
    "- unassigned_work: work mentioned without a clear owner, e.g. \"Someone needs to\", \"We should figure out\", \"We need to follow up on\".",
    "",
    "Normalization rules:",
    "- Convert vague commitments into clear concrete tasks using nearby context.",
    "- Preserve the transcript meaning; do not add unrelated work.",
    "- Use the speaker name as owner when the speaker personally commits.",
    "- Use null for owner when ownership is unclear or the task is unassigned work.",
    "- Include a short source_quote when possible.",
    "- Generate 2-5 practical suggested next steps for each task.",
    "- Use priority low, medium, or high. Default to medium when unclear.",
    "",
    "Workspace classification rules:",
    "- Research tasks should become research.",
    "- Email, draft, send message, or outreach tasks should become email.",
    "- Build, implement, fix, code, or engineering tasks should become coding.",
    "- Create proposal, pitch, or proposal-style plan docs should become proposal.",
    "- Write docs, specs, PRDs, or requirements should become documentation.",
    "- UI, UX, visual, or design tasks should become design.",
    "- Follow-up, schedule, check back, or circle-back tasks should become meeting_follow_up.",
    "- Planning, roadmap, timeline, sequencing, or coordination tasks should become planning.",
    "- Testing, QA, validation, or verification tasks should become testing.",
    "- Decide, choose, approve, or finalize tasks should become decision.",
    "- Learn, study, understand, or get familiar tasks should become learning.",
    "- Unknown tasks should become other.",
    "- workspace_summary should be one concise sentence describing the workspace focus.",
    "- Return valid JSON only."
  ].join("\n");

  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: taskExtractionPrompt
        },
        {
          role: "user",
          content: [
            `Topic: ${topic.title}`,
            topic.summary ? `Topic summary: ${topic.summary}` : null,
            "",
            "Transcript excerpt:",
            transcript
          ]
            .filter(Boolean)
            .join("\n")
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "topic_task_extraction",
          strict: true,
          schema: topicTaskExtractionJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned empty task extraction output." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid task extraction JSON.",
        details: raw.slice(0, 400)
      };
    }

    const validated = topicTaskExtractionSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Task extraction JSON did not match schema.",
        details: validated.error.message
      };
    }

    return { ok: true, data: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to extract topic tasks with OpenAI.",
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
      model: OPENAI_MODEL,
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

export function buildMeetingTasksPayload(input: {
  meetingId: string;
  topicId: string;
  extraction: TopicTaskExtractionResult;
}): Array<{
  meeting_id: string;
  topic_id: string;
  task: string;
  owner: string | null;
  task_type: MeetingTaskType;
  priority: MeetingTaskPriority;
  suggested_steps: string[];
  source_quote: string | null;
  confidence: number | null;
  workspace_type: MeetingTaskWorkspaceType;
  workspace_summary: string | null;
}> {
  return input.extraction.tasks.map((task) => ({
    meeting_id: input.meetingId,
    topic_id: input.topicId,
    task: task.task.trim(),
    owner: task.owner?.trim() || null,
    task_type: task.task_type,
    priority: task.priority,
    suggested_steps: task.suggested_steps
      .map((step) => step.trim())
      .filter((step) => step.length > 0),
    source_quote: task.source_quote?.trim() || null,
    confidence: task.confidence,
    workspace_type: task.workspace_type,
    workspace_summary: task.workspace_summary?.trim() || null
  }));
}
