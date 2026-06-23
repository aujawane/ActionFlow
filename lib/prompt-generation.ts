import { OPENAI_MODEL, openai } from "@/lib/openai";
import type { ExtractedInsight } from "@/lib/types";

export type PromptTarget = "general" | "lovable";

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

const MAX_ITEMS_PER_BUCKET = 8;
const MAX_ITEM_LENGTH = 280;

function normalizeInsightText(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_ITEM_LENGTH);
}

function pushUniqueLimited(bucket: string[], value: string) {
  if (!value) return;
  if (bucket.includes(value)) return;
  if (bucket.length >= MAX_ITEMS_PER_BUCKET) return;
  bucket.push(value);
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
    const value = normalizeInsightText(insight.content);
    if (!value) continue;

    switch (insight.category) {
      case "product_summary":
      case "product_requirements":
      case "requirements":
        pushUniqueLimited(buckets.productContext, value);
        pushUniqueLimited(buckets.userGoals, value);
        break;
      case "user_stories":
        pushUniqueLimited(buckets.userGoals, value);
        break;
      case "features":
        pushUniqueLimited(buckets.features, value);
        break;
      case "technical_constraints":
        pushUniqueLimited(buckets.technicalConstraints, value);
        break;
      case "design_preferences":
        pushUniqueLimited(buckets.designPreferences, value);
        break;
      case "implementation_details":
        pushUniqueLimited(buckets.implementationDetails, value);
        break;
      case "open_questions":
        pushUniqueLimited(buckets.openQuestions, value);
        break;
      case "risks":
        pushUniqueLimited(buckets.risks, value);
        break;
      case "next_steps":
        pushUniqueLimited(buckets.nextSteps, value);
        break;
      default:
        pushUniqueLimited(buckets.productContext, value);
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
    `Project: ${meetingTitle}`,
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

function lovableSectionsPrompt(meetingTitle: string, grouped: InsightBuckets) {
  return [
    `Project: ${meetingTitle}`,
    "",
    bulletList("Product context", grouped.productContext),
    "",
    bulletList("Feature list", grouped.features),
    "",
    bulletList("User goals and stories", grouped.userGoals),
    "",
    bulletList("Open questions", grouped.openQuestions),
    "",
    bulletList("Risks", grouped.risks),
    "",
    bulletList("Next steps", grouped.nextSteps)
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
    general:
      "Write a general development prompt that works well for coding agents like Codex, Cursor, Claude Code, Gemini, and Windsurf.",
    lovable:
      "Write a Lovable-specific prompt focused on UI generation, UX flows, screens, layouts, components, and styling details."
  };

  const outputRequirementsMap: Record<PromptTarget, string[]> = {
    general: [
      "Output requirements:",
      "- Return markdown only.",
      "- Include explicit headings for each required section exactly once.",
      "- Required sections: Project Overview, Requirements, User Stories, Implementation Guidance, Architecture Recommendations, Acceptance Criteria.",
      "- Keep the prompt practical and directly executable by coding agents.",
      "- Include concrete assumptions when requirements are ambiguous."
    ],
    lovable: [
      "Output requirements:",
      "- Return markdown only.",
      "- Include headings: Product Overview, UX Goals, Screens & Layouts, Core Components, Styling Direction, User Flows, Acceptance Criteria.",
      "- Optimize for Lovable generating polished UI quickly.",
      "- Prioritize clear screen behavior, interaction details, and component structure.",
      "- Keep implementation notes focused on frontend/UI delivery."
    ]
  };

  const contextByTarget =
    input.target === "general"
      ? requiredSectionsPrompt(meetingTitle, grouped)
      : lovableSectionsPrompt(meetingTitle, grouped);

  const scopeRules = [
    `Strict scope rules for the project "${meetingTitle}":`,
    "- Treat this as ONE single, standalone project.",
    "- Build only this one project. Never bundle, merge, or describe multiple applications.",
    "- Use ONLY the insights provided below for this project.",
    "- Do not reference, mention, or borrow requirements, features, user stories, constraints, screens, or data from any other product, app, or topic.",
    "- If the insights describe a single product (e.g. a Task Tracker), the entire prompt must be about only that product.",
    "- Never write phrases like \"build a Task Tracker, Calculator, and Expense Tracker\" or otherwise combine separate products."
  ];

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a principal engineer converting a SINGLE topic's meeting insights into a build-ready prompt for ONE standalone project. You must never reference, combine, or mention any other project, product, app, feature area, or topic. Use only the insights provided for this one project."
      },
      {
        role: "user",
        content: [
          targetInstructionMap[input.target],
          "",
          ...scopeRules,
          "",
          ...outputRequirementsMap[input.target],
          "",
          contextByTarget
        ].join("\n")
      }
    ]
  });

  return response.output_text?.trim() || "";
}
