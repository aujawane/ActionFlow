import type { ExtractedInsight } from "@/lib/types";

export function InsightsPanel({ insights }: { insights: ExtractedInsight[] }) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Extracted Insights</h2>
      {insights.length > 0 ? (
        <div className="space-y-2">
          {insights.map((insight) => (
            <div
              key={insight.id}
              className="rounded-md border border-slate-200 bg-slate-50 p-3"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {insight.category.replaceAll("_", " ")}
              </p>
              <p className="mt-1 text-sm text-slate-800">{insight.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          No insights yet. Click Analyze Meeting to extract requirements and
          technical details.
        </p>
      )}
    </div>
  );
}
