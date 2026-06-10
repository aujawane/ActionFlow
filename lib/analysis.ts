import { z } from "zod";

import { OPENAI_MODEL, openai } from "@/lib/openai";

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
