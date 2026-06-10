import type { ExtractedInsight } from "@/lib/types";

const sectionOrder = [
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
] as const;

const sectionLabels: Record<(typeof sectionOrder)[number], string> = {
  product_summary: "Product Summary",
  requirements: "Requirements",
  features: "Features",
  user_stories: "User Stories",
  technical_constraints: "Technical Constraints",
  design_preferences: "Design Preferences",
  implementation_details: "Implementation Details",
  open_questions: "Open Questions",
  risks: "Risks",
  next_steps: "Next Steps"
};

export function InsightsPanel({ insights }: { insights: ExtractedInsight[] }) {
  const grouped = sectionOrder
    .map((key) => ({
      key,
      label: sectionLabels[key],
      items: insights.filter((insight) => insight.category === key)
    }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Insight Sections</h2>
        <p className="text-xs text-slate-500">
          Structured output grouped for planning and implementation.
        </p>
      </div>

      {grouped.length > 0 ? (
        <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
          {grouped.map((section) => (
            <div key={section.key} className="rounded-lg border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {section.label}
                </p>
              </div>
              <div className="space-y-2 p-3">
                {section.items.map((insight) => (
                  <p key={insight.id} className="text-sm text-slate-700">
                    - {insight.content}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="text-sm text-slate-600">
            No insights yet. Click Analyze Meeting to extract requirements,
            constraints, and implementation details.
          </p>
        </div>
      )}
    </div>
  );
}
