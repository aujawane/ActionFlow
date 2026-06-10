import { OPENAI_MODEL, openai } from "@/lib/openai";
import type { ExtractedInsight } from "@/lib/types";

export type PromptTarget = "codex" | "claude_code" | "lovable";

function baseBrief(
  title: string | null,
  insights: Pick<ExtractedInsight, "category" | "content">[]
) {
  const grouped = insights
    .map((item) => `- [${item.category}] ${item.content}`)
    .join("\n");

  return `Meeting Title: ${title ?? "Untitled meeting"}\n\nExtracted insights:\n${grouped}`;
}

export async function generateBuildPromptForTarget(input: {
  meetingTitle: string | null;
  insights: Pick<ExtractedInsight, "category" | "content">[];
  target: PromptTarget;
}) {
  const targetInstructionMap: Record<PromptTarget, string> = {
    codex:
      "Write a build-ready prompt optimized for OpenAI Codex style coding agents with clear acceptance criteria and file-level implementation guidance.",
    claude_code:
      "Write a build-ready prompt optimized for Claude Code with planning context, constraints, and a strong verification checklist.",
    lovable:
      "Write a build-ready prompt optimized for Lovable to generate polished product + frontend/backend implementation quickly."
  };

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a principal engineer converting meeting insights into concrete implementation prompts."
      },
      {
        role: "user",
        content: [
          targetInstructionMap[input.target],
          "",
          "Requirements:",
          "- Include scope, architecture assumptions, data model requirements, and API behavior.",
          "- Include a step-by-step implementation checklist.",
          "- Include test and validation steps.",
          "",
          baseBrief(input.meetingTitle, input.insights)
        ].join("\n")
      }
    ]
  });

  return response.output_text;
}
