"use client";

import { useCallback, useEffect, useState } from "react";

import { useOptionalTaskWorkspaceState } from "@/components/task-workspace-task-state";
import {
  getDeliverableButtonLabel,
  getDeliverablePanelTitle,
  getTaskCategorization
} from "@/lib/task-deliverables";
import type { MeetingTaskWorkspaceType, TaskArtifact, TaskGuide, TaskPrompt } from "@/lib/types";

type ApiError = {
  error?: string;
  details?: string;
};

type TaskExecutionPanelProps = {
  taskId: string;
  workspaceType: MeetingTaskWorkspaceType;
  initialArtifacts: TaskArtifact[];
};

const promptLabelByWorkspaceType: Partial<Record<MeetingTaskWorkspaceType, string>> = {
  coding: "Generate Implementation Prompt",
  documentation: "Generate Documentation Prompt",
  design: "Generate Design Prompt",
  testing: "Generate Test Prompt",
  planning: "Generate Planning Prompt",
  research: "Generate Research Prompt",
  website_change: "Generate Dev Prompt",
  analysis: "Generate Analysis Prompt"
};

async function parseJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
}

export function TaskExecutionPanel({
  taskId,
  workspaceType,
  initialArtifacts
}: TaskExecutionPanelProps) {
  const workspaceState = useOptionalTaskWorkspaceState();
  const task = workspaceState?.task;
  const categorization = task ? getTaskCategorization(task) : null;
  const deliverableButtonLabel =
    categorization?.suggested_button_label ??
    getDeliverableButtonLabel(categorization?.deliverable_type);
  const deliverablePanelTitle = getDeliverablePanelTitle(categorization?.deliverable_type);
  const deliverableNoun = deliverablePanelTitle.toLowerCase();

  const [guide, setGuide] = useState<TaskGuide | null>(null);
  const [taskPrompt, setTaskPrompt] = useState<TaskPrompt | null>(null);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>(initialArtifacts);
  const [selectedArtifact, setSelectedArtifact] = useState<TaskArtifact | null>(
    initialArtifacts[0] ?? null
  );
  const [showDeliverablePanel, setShowDeliverablePanel] = useState(
    Boolean(initialArtifacts[0])
  );
  const [editableTitle, setEditableTitle] = useState(initialArtifacts[0]?.title ?? "");
  const [editableContent, setEditableContent] = useState(
    initialArtifacts[0]?.content ?? ""
  );
  const [guideLoading, setGuideLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const promptLabel = promptLabelByWorkspaceType[workspaceType];

  useEffect(() => {
    setArtifacts(initialArtifacts);
    if (initialArtifacts[0]) {
      setSelectedArtifact(initialArtifacts[0]);
      setEditableTitle(initialArtifacts[0].title);
      setEditableContent(initialArtifacts[0].content);
      setShowDeliverablePanel(true);
    }
  }, [initialArtifacts]);

  const selectArtifact = useCallback((artifact: TaskArtifact) => {
    setSelectedArtifact(artifact);
    setEditableTitle(artifact.title);
    setEditableContent(artifact.content);
    setShowDeliverablePanel(true);
    setSaveMessage(null);
    setCopyMessage(null);
  }, []);

  async function generateGuide() {
    setGuideLoading(true);
    setGuideError(null);

    const response = await fetch(`/api/tasks/${taskId}/guide`, { method: "POST" });
    const result = await parseJson<{ guide?: TaskGuide } & ApiError>(response);
    setGuideLoading(false);

    if (!response.ok || !result.guide) {
      setGuideError(result.error || "Unable to generate guide.");
      return;
    }

    setGuide(result.guide);
  }

  async function generateDeliverable(regenerate = false) {
    setArtifactLoading(true);
    setArtifactError(null);
    setSaveMessage(null);

    const response = await fetch(
      `/api/tasks/${taskId}/generate-deliverable?regenerate=${regenerate ? "true" : "false"}`,
      { method: "POST" }
    );
    const result = await parseJson<{
      artifact?: TaskArtifact;
      task?: Parameters<NonNullable<typeof workspaceState>["setTask"]>[0];
      reused?: boolean;
    } & ApiError>(response);
    setArtifactLoading(false);

    if (!response.ok || !result.artifact) {
      setArtifactError(result.error || "Unable to generate deliverable.");
      return;
    }

    if (result.task && workspaceState) {
      workspaceState.setTask(result.task);
    }

    setArtifacts((current) => {
      const withoutDuplicate = current.filter((item) => item.id !== result.artifact!.id);
      return [result.artifact!, ...withoutDuplicate];
    });
    selectArtifact(result.artifact);
    setSaveMessage(result.reused ? "Showing saved deliverable." : "Deliverable generated.");
  }

  async function generatePrompt() {
    setPromptLoading(true);
    setPromptError(null);

    const response = await fetch(`/api/tasks/${taskId}/prompt`, { method: "POST" });
    const result = await parseJson<{ taskPrompt?: TaskPrompt } & ApiError>(response);
    setPromptLoading(false);

    if (!response.ok || !result.taskPrompt) {
      setPromptError(result.error || "Unable to generate task prompt.");
      return;
    }

    setTaskPrompt(result.taskPrompt);
  }

  async function saveDeliverable() {
    if (!selectedArtifact) return;

    setSaveLoading(true);
    setSaveMessage(null);

    const response = await fetch(`/api/tasks/${taskId}/deliverable`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactId: selectedArtifact.id,
        title: editableTitle,
        content: editableContent
      })
    });
    const result = await parseJson<{ artifact?: TaskArtifact } & ApiError>(response);
    setSaveLoading(false);

    if (!response.ok || !result.artifact) {
      setSaveMessage(result.error || "Unable to save deliverable.");
      return;
    }

    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === result.artifact!.id ? result.artifact! : artifact
      )
    );
    selectArtifact(result.artifact);
    setSaveMessage("Deliverable saved.");
  }

  async function copyDeliverable() {
    if (!editableContent.trim()) return;
    try {
      await navigator.clipboard.writeText(editableContent);
      setCopyMessage("Copied to clipboard.");
    } catch {
      setCopyMessage("Unable to copy deliverable.");
    }
  }

  const panelTitle = selectedArtifact
    ? getDeliverablePanelTitle(
        selectedArtifact.deliverable_type ?? categorization?.deliverable_type
      )
    : "Deliverable";

  return (
    <div className="space-y-6">
      {/* B. Task Actions -- Guide Me and Execute with Parfait are two modes for accomplishing
          the same task, presented side by side rather than as unrelated cards. Their backend
          behavior (guide generation vs. deliverable generation) stays fully separate. */}
      <section className="premium-card p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Complete This Task
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Task Actions</h2>
          <p className="mt-1 text-sm text-slate-600">
            {categorization?.reason || "Two ways to move this task forward."}
          </p>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">Guide Me</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Get a practical step-by-step plan for completing this yourself.
            </p>
            <button
              type="button"
              onClick={generateGuide}
              disabled={guideLoading}
              className="secondary-button mt-4 w-full"
            >
              {guideLoading ? "Generating..." : "Generate Guide"}
            </button>

            {guideError ? (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {guideError}
              </p>
            ) : null}

            {guide ? (
              <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Summary
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-700">{guide.summary}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Objective
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-700">{guide.objective}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Steps
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
                    {guide.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Execute with Parfait</h3>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Parfait can create a {deliverableNoun} for this task.
            </p>
            <button
              type="button"
              onClick={() => generateDeliverable(false)}
              disabled={artifactLoading}
              className="premium-button mt-4 w-full"
            >
              {artifactLoading ? "Generating..." : deliverableButtonLabel}
            </button>

            {artifactError ? (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {artifactError}
              </p>
            ) : null}
            {saveMessage ? (
              <p className="mt-3 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800">
                {saveMessage}
              </p>
            ) : null}
          </div>
        </div>

        {promptLabel ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-xs text-slate-500">Need a different output format for this task?</p>
            <button
              type="button"
              onClick={generatePrompt}
              disabled={promptLoading}
              className="tertiary-button"
            >
              {promptLoading ? "Generating..." : promptLabel}
            </button>
          </div>
        ) : null}

        {promptError ? (
          <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {promptError}
          </p>
        ) : null}

        {taskPrompt ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {taskPrompt.promptType}
            </p>
            <h3 className="mt-2 text-base font-semibold text-slate-950">{taskPrompt.title}</h3>
            <textarea
              value={taskPrompt.prompt}
              readOnly
              className="mt-3 min-h-80 w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-4 font-mono text-sm leading-6 text-slate-800 shadow-inner outline-none"
            />
          </div>
        ) : null}
      </section>

      {/* C. Deliverables -- promoted next to Task Actions, ahead of any rationale/context, since
          generated output is core product value the user shouldn't have to scroll past evidence
          to find. */}
      <section className="premium-card p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Generated Output
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Deliverables</h2>
        </div>

        {selectedArtifact && showDeliverablePanel ? (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                  {panelTitle}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                  {editableTitle || selectedArtifact.title}
                </h3>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <span>
                    {selectedArtifact.artifact_type} v{selectedArtifact.version}
                  </span>
                  {selectedArtifact.status === "failed" ? (
                    <span className="badge-state border-rose-200 bg-rose-50 text-rose-700">
                      Failed
                    </span>
                  ) : selectedArtifact.status ? (
                    <span className="badge-meta capitalize">{selectedArtifact.status}</span>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={copyDeliverable}
                  className="secondary-button px-3 py-2 text-xs"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => generateDeliverable(true)}
                  disabled={artifactLoading}
                  className="secondary-button px-3 py-2 text-xs"
                >
                  {artifactLoading ? "Generating..." : "Regenerate"}
                </button>
                <button
                  type="button"
                  onClick={saveDeliverable}
                  disabled={saveLoading}
                  className="premium-button px-3 py-2 text-xs"
                >
                  {saveLoading ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeliverablePanel(false)}
                  className="tertiary-button px-3 py-2 text-xs"
                >
                  Close
                </button>
              </div>
            </div>

            {copyMessage ? (
              <p className="mt-4 text-xs font-medium text-slate-500">{copyMessage}</p>
            ) : null}

            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Title
                </label>
                <input
                  value={editableTitle}
                  onChange={(event) => setEditableTitle(event.target.value)}
                  className="premium-input mt-2 w-full text-base font-semibold"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Deliverable
                </label>
                <textarea
                  value={editableContent}
                  onChange={(event) => setEditableContent(event.target.value)}
                  className="mt-2 min-h-[24rem] w-full resize-y rounded-2xl border border-slate-200 bg-white px-5 py-5 font-mono text-sm leading-7 text-slate-800 shadow-inner outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-500/10 sm:min-h-[28rem]"
                />
              </div>
            </div>
          </div>
        ) : null}

        {artifacts.length > 0 ? (
          <div className="mt-5">
            {artifacts.length > 1 || !showDeliverablePanel ? (
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {showDeliverablePanel ? "All saved deliverables" : "Saved deliverables"}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {artifacts.map((artifact) => (
                <button
                  type="button"
                  key={artifact.id}
                  onClick={() => selectArtifact(artifact)}
                  className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                    selectedArtifact?.id === artifact.id
                      ? "border-brand-200 bg-brand-50 text-brand-900"
                      : "border-slate-200 bg-white text-slate-700 hover:border-brand-200 hover:bg-brand-50/40"
                  }`}
                >
                  <p className="text-sm font-semibold">{artifact.title}</p>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                    <span>
                      {artifact.artifact_type} v{artifact.version}
                    </span>
                    {artifact.status === "failed" ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />
                    ) : null}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="premium-empty-compact mt-5">
            <p className="text-sm font-medium text-slate-700">No deliverables yet.</p>
            <p className="mt-1 text-sm text-slate-600">
              Parfait can create a {deliverableNoun} for this task.
            </p>
            <button
              type="button"
              onClick={() => generateDeliverable(false)}
              disabled={artifactLoading}
              className="premium-button mt-4"
            >
              {artifactLoading ? "Generating..." : deliverableButtonLabel}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
