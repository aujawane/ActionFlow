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
    <div className="premium-card space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Insight Sections</h2>
        <p className="text-xs text-slate-500">
          Structured output grouped for planning and implementation.
        </p>
      </div>

      {grouped.length > 0 ? (
        <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
          {grouped.map((section) => (
            <div key={section.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-brand-200">
              <div className="border-b border-brand-100 bg-brand-50/70 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                  {section.label}
                </p>
              </div>
              <div className="space-y-2 p-3">
                {section.items.map((insight) => (
                  <p key={insight.id} className="rounded-lg px-2 py-1 text-sm leading-6 text-slate-700 transition hover:bg-slate-50">
                    {insight.content}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="premium-empty p-6">
          <p className="text-sm font-semibold text-slate-800">No insights yet</p>
          <p className="mt-1 text-sm text-slate-600">
            No insights yet. Click Analyze Meeting to extract requirements,
            constraints, and implementation details.
          </p>
        </div>
      )}
    </div>
  );
}
