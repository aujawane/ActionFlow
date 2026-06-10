import type { GeneratedPrompt } from "@/lib/types";

export function PromptsPanel({ prompts }: { prompts: GeneratedPrompt[] }) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Generated Prompts</h2>
      {prompts.length > 0 ? (
        <div className="space-y-3">
          {prompts.map((item) => (
            <div key={item.id} className="rounded-md border border-slate-200 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {item.target_tool.replace("_", " ")}
              </p>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
                {item.prompt}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          No prompts generated yet. Run Analyze Meeting first, then Generate
          Prompts.
        </p>
      )}
    </div>
  );
}
