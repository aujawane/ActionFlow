import { OPENAI_MODEL, openai } from "@/lib/openai";
import type { ExtractedInsight } from "@/lib/types";

export type PromptTarget = "codex" | "claude_code" | "lovable";

type InsightRow = Pick<ExtractedInsight, "category" | "content">;

interface InsightBuckets {
  productContext: string[];
  userGoals: string[];
  features: string[];
  technicalConstraints: string[];
  designPreferences: string[];
  implementationDetails: string[];
  openQuestions: string[];
  risks: string[];
  nextSteps: string[];
}

function groupInsights(insights: InsightRow[]): InsightBuckets {
  const buckets: InsightBuckets = {
    productContext: [],
    userGoals: [],
    features: [],
    technicalConstraints: [],
    designPreferences: [],
    implementationDetails: [],
    openQuestions: [],
    risks: [],
    nextSteps: []
  };

  for (const insight of insights) {
    const value = insight.content.trim();
    if (!value) continue;

    switch (insight.category) {
      case "product_summary":
      case "product_requirements":
      case "requirements":
        buckets.productContext.push(value);
        buckets.userGoals.push(value);
        break;
      case "user_stories":
        buckets.userGoals.push(value);
        break;
      case "features":
        buckets.features.push(value);
        break;
      case "technical_constraints":
        buckets.technicalConstraints.push(value);
        break;
      case "design_preferences":
        buckets.designPreferences.push(value);
        break;
      case "implementation_details":
        buckets.implementationDetails.push(value);
        break;
      case "open_questions":
        buckets.openQuestions.push(value);
        break;
      case "risks":
        buckets.risks.push(value);
        break;
      case "next_steps":
        buckets.nextSteps.push(value);
        break;
      default:
        buckets.productContext.push(value);
        break;
    }
  }

  return buckets;
}

function bulletList(title: string, items: string[]) {
  const safeItems =
    items.length > 0 ? items : ["Not explicitly captured in transcript insights."];
  return [`${title}:`, ...safeItems.map((item) => `- ${item}`)].join("\n");
}

function requiredSectionsPrompt(meetingTitle: string, grouped: InsightBuckets) {
  return [
    `Meeting: ${meetingTitle}`,
    "",
    bulletList("Product context", grouped.productContext),
    "",
    bulletList("User goals", grouped.userGoals),
    "",
    bulletList("Feature list", grouped.features),
    "",
    "Database schema suggestions:",
    "- Recommend normalized tables, key relationships, and indexing strategy aligned to requirements.",
    "- Include migration notes and assumptions where requirements are ambiguous.",
    "",
    "API routes:",
    "- Propose REST endpoints with methods, payloads, auth behavior, and error contracts.",
    "",
    "UI pages/components:",
    "- Propose route-level pages and reusable components with state/data flow guidance.",
    "",
    "Acceptance criteria:",
    "- Write testable criteria for happy path, edge cases, and failure behavior.",
    "",
    "Implementation constraints:",
    ...(grouped.technicalConstraints.length > 0
      ? grouped.technicalConstraints.map((item) => `- ${item}`)
      : ["- Not explicitly captured in transcript insights."]),
    ...(grouped.designPreferences.length > 0
      ? ["- Respect design preferences:", ...grouped.designPreferences.map((d) => `  - ${d}`)]
      : []),
    ...(grouped.openQuestions.length > 0
      ? ["- Address unresolved questions:", ...grouped.openQuestions.map((q) => `  - ${q}`)]
      : []),
    ...(grouped.risks.length > 0
      ? ["- Mitigate identified risks:", ...grouped.risks.map((r) => `  - ${r}`)]
      : []),
    "",
    "Testing requirements:",
    "- Include unit, integration, and end-to-end coverage expectations.",
    "- Include API contract and regression test guidance."
  ].join("\n");
}

export async function generateBuildPromptForTarget(input: {
  meetingTitle: string | null;
  insights: InsightRow[];
  target: PromptTarget;
}) {
  const grouped = groupInsights(input.insights);
  const meetingTitle = input.meetingTitle ?? "Untitled meeting";

  const targetInstructionMap: Record<PromptTarget, string> = {
    codex:
      "Write a build-ready implementation prompt optimized for Codex. Be concise, concrete, and file-oriented.",
    claude_code:
      "Write a build-ready implementation prompt optimized for Claude Code. Include planning notes, architecture decisions, and verification checklist.",
    lovable:
      "Write a build-ready implementation prompt optimized for Lovable. Emphasize product UX clarity plus full-stack build steps."
  };

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a principal engineer converting meeting insights into high-quality prompts for coding agents."
      },
      {
        role: "user",
        content: [
          targetInstructionMap[input.target],
          "",
          "Output requirements:",
          "- Return markdown only.",
          "- Include explicit headings for each required section exactly once.",
          "- Required sections: Product Context, User Goals, Feature List, Database Schema Suggestions, API Routes, UI Pages/Components, Acceptance Criteria, Implementation Constraints, Testing Requirements.",
          "- Include a concrete implementation plan with sequenced steps.",
          "- Include realistic assumptions where needed.",
          "- Do not omit any required section.",
          "",
          requiredSectionsPrompt(meetingTitle, grouped)
        ].join("\n")
      }
    ]
  });

  return response.output_text?.trim() || "";
}
