import { OPENAI_MODEL, openai } from "@/lib/openai";
import type { InsightCategory } from "@/lib/types";

type InsightPayload = {
  category: InsightCategory;
  content: string;
  confidence: number | null;
};

export async function extractInsightsFromTranscript(transcript: string) {
  const systemPrompt = [
    "You are a senior product analyst.",
    "Extract actionable software delivery insights from a meeting transcript.",
    "Return strict JSON with this shape:",
    '{"insights":[{"category":"product_requirements|features|user_stories|technical_constraints|design_preferences|implementation_details|open_questions","content":"...", "confidence":0.0}]}'
  ].join(" ");

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Transcript:\n${transcript}`
      }
    ]
  });

  const text = response.output_text;
  let parsed: { insights: InsightPayload[] } = { insights: [] };

  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback when model returns prose instead of strict JSON.
    parsed = {
      insights: [
        {
          category: "open_questions",
          content:
            "Model output could not be parsed as JSON. Re-run analysis with a stricter model/temperature setup.",
          confidence: 0.2
        }
      ]
    };
  }

  return parsed.insights;
}
