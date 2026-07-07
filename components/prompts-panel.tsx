"use client";

import { useMemo, useState } from "react";

import type { GeneratedPrompt } from "@/lib/types";

type RenderPromptTool = "general" | "lovable";
const TOOL_ORDER: RenderPromptTool[] = ["lovable", "general"];

function toolLabel(tool: RenderPromptTool) {
  if (tool === "lovable") return "Lovable Prompt";
  return "General Prompt";
}

export function PromptsPanel({ prompts }: { prompts: GeneratedPrompt[] }) {
  const promptByTool = useMemo(() => {
    const byTool = new Map<RenderPromptTool, GeneratedPrompt>();
    const sorted = [...prompts].sort((a, b) => {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    for (const prompt of sorted) {
      const normalizedTool: RenderPromptTool | null =
        prompt.tool_type === "general" || prompt.tool_type === "codex"
          ? "general"
          : prompt.tool_type === "lovable"
            ? "lovable"
            : null;
      if (!normalizedTool) continue;
      if (!byTool.has(normalizedTool)) byTool.set(normalizedTool, prompt);
    }
    return byTool;
  }, [prompts]);
  const [copyState, setCopyState] = useState<Record<string, "idle" | "copied" | "failed">>({});

  async function copyPrompt(tool: RenderPromptTool, text: string) {
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopyState((prev) => ({ ...prev, [tool]: "copied" }));
    } catch {
      setCopyState((prev) => ({ ...prev, [tool]: "failed" }));
    }

    setTimeout(() => {
      setCopyState((prev) => ({ ...prev, [tool]: "idle" }));
    }, 1500);
  }

  return (
    <div className="premium-card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Topic Prompts</h2>
        <p className="text-xs text-slate-500">
          Previously generated topic prompts are shown here for reference.
        </p>
      </div>
      {TOOL_ORDER.some((tool) => promptByTool.has(tool)) ? (
        <div className="space-y-3">
          {TOOL_ORDER.map((tool) => {
            const prompt = promptByTool.get(tool);
            const state = copyState[tool] ?? "idle";
            return (
              <div key={tool} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-200">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {toolLabel(tool)}
                  </p>
                  <button
                    type="button"
                    onClick={() => copyPrompt(tool, prompt?.prompt ?? "")}
                    disabled={!prompt}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800 disabled:opacity-60"
                  >
                    {state === "copied"
                      ? "Copied"
                      : state === "failed"
                        ? "Copy failed"
                        : "Copy"}
                  </button>
                </div>
                {prompt ? (
                  <pre className="mt-2 max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-800">
                    {prompt.prompt}
                  </pre>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">
                    Prompt not generated yet for this topic.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="premium-empty p-6">
          <p className="text-sm font-semibold text-slate-800">No prompts yet</p>
          <p className="mt-1 text-sm text-slate-600">
            Task-specific prompts now live inside applicable task workspaces.
          </p>
        </div>
      )}
    </div>
  );
}
