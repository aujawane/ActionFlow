"use client";

import { useEffect, useMemo, useState } from "react";

import type { GeneratedPrompt } from "@/lib/types";

type PromptTool = GeneratedPrompt["target_tool"];

const TOOL_ORDER: PromptTool[] = ["codex", "claude_code", "lovable"];

function toolLabel(tool: PromptTool) {
  if (tool === "codex") return "Codex";
  if (tool === "claude_code") return "Claude Code";
  return "Lovable";
}

export function PromptsPanel({ prompts }: { prompts: GeneratedPrompt[] }) {
  const sortedPrompts = useMemo(() => {
    return [...prompts].sort(
      (a, b) => TOOL_ORDER.indexOf(a.target_tool) - TOOL_ORDER.indexOf(b.target_tool)
    );
  }, [prompts]);

  const [activeTool, setActiveTool] = useState<PromptTool>(sortedPrompts[0]?.target_tool ?? "codex");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const activePrompt = sortedPrompts.find((item) => item.target_tool === activeTool);

  useEffect(() => {
    if (!activePrompt && sortedPrompts[0]) {
      setActiveTool(sortedPrompts[0].target_tool);
    }
  }, [activePrompt, sortedPrompts]);

  async function copyPrompt() {
    if (!activePrompt) return;

    try {
      await navigator.clipboard.writeText(activePrompt.prompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Prompt Tabs</h2>
        <p className="text-xs text-slate-500">
          Copy build-ready prompts for Codex, Claude Code, and Lovable.
        </p>
      </div>
      {sortedPrompts.length > 0 ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {sortedPrompts.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTool(item.target_tool)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  item.target_tool === activeTool
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {toolLabel(item.target_tool)}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {activePrompt ? toolLabel(activePrompt.target_tool) : "Prompt"}
              </p>
              <button
                type="button"
                onClick={copyPrompt}
                disabled={!activePrompt}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy"}
              </button>
            </div>
            {activePrompt ? (
              <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
                {activePrompt.prompt}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-slate-500">No prompt selected.</p>
            )}
          </div>
          {copyState === "failed" ? (
            <p className="text-xs text-rose-700">
              Clipboard access failed in this browser context.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="text-sm text-slate-500">
            No prompts generated yet. Run Analyze Meeting first, then Generate
            Prompts.
          </p>
        </div>
      )}
    </div>
  );
}
