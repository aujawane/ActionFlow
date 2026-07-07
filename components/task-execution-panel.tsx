"use client";

import { useState } from "react";

import type { TaskArtifact, TaskGuide } from "@/lib/types";

type ApiError = {
  error?: string;
  details?: string;
};

type TaskExecutionPanelProps = {
  taskId: string;
  initialArtifacts: TaskArtifact[];
};

async function parseJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
}

export function TaskExecutionPanel({
  taskId,
  initialArtifacts
}: TaskExecutionPanelProps) {
  const [guide, setGuide] = useState<TaskGuide | null>(null);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>(initialArtifacts);
  const [selectedArtifact, setSelectedArtifact] = useState<TaskArtifact | null>(
    initialArtifacts[0] ?? null
  );
  const [editableTitle, setEditableTitle] = useState(initialArtifacts[0]?.title ?? "");
  const [editableContent, setEditableContent] = useState(initialArtifacts[0]?.content ?? "");
  const [guideLoading, setGuideLoading] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  function selectArtifact(artifact: TaskArtifact) {
    setSelectedArtifact(artifact);
    setEditableTitle(artifact.title);
    setEditableContent(artifact.content);
    setSaveMessage(null);
  }

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

  async function generateDeliverable() {
    setArtifactLoading(true);
    setArtifactError(null);

    const response = await fetch(`/api/tasks/${taskId}/generate`, { method: "POST" });
    const result = await parseJson<{ artifact?: TaskArtifact } & ApiError>(response);
    setArtifactLoading(false);

    if (!response.ok || !result.artifact) {
      setArtifactError(result.error || "Unable to generate deliverable.");
      return;
    }

    setArtifacts((current) => [result.artifact!, ...current]);
    selectArtifact(result.artifact);
  }

  async function saveArtifact() {
    if (!selectedArtifact) return;

    setSaveLoading(true);
    setSaveMessage(null);

    const response = await fetch(`/api/task-artifacts/${selectedArtifact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: editableTitle,
        content: editableContent
      })
    });
    const result = await parseJson<{ artifact?: TaskArtifact } & ApiError>(response);
    setSaveLoading(false);

    if (!response.ok || !result.artifact) {
      setSaveMessage(result.error || "Unable to save artifact.");
      return;
    }

    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === result.artifact!.id ? result.artifact! : artifact
      )
    );
    selectArtifact(result.artifact);
    setSaveMessage("Artifact saved.");
  }

  return (
    <div className="space-y-6">
      <section className="premium-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Guide Me</h2>
            <p className="mt-1 text-xs text-slate-500">
              Generate a practical guide for completing this task yourself.
            </p>
          </div>
          <button
            type="button"
            onClick={generateGuide}
            disabled={guideLoading}
            className="premium-button"
          >
            {guideLoading ? "Generating..." : "Generate Guide"}
          </button>
        </div>

        {guideError ? (
          <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {guideError}
          </p>
        ) : null}

        {guide ? (
          <div className="mt-5 space-y-4">
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
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Recommended Approach
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-700">
                {guide.recommendedApproach}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Resources
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {guide.resources.map((resource) => (
                    <li key={resource}>{resource}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Success Criteria
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {guide.successCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Estimated Effort
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-700">{guide.estimatedEffort}</p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="premium-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Do It For Me</h2>
            <p className="mt-1 text-xs text-slate-500">
              Generate and save a first draft deliverable for this task.
            </p>
          </div>
          <button
            type="button"
            onClick={generateDeliverable}
            disabled={artifactLoading}
            className="premium-button"
          >
            {artifactLoading ? "Generating..." : "Generate Deliverable"}
          </button>
        </div>

        {artifactError ? (
          <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {artifactError}
          </p>
        ) : null}

      </section>

      {selectedArtifact ? (
        <section className="premium-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                Current Artifact
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                {selectedArtifact.title}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {selectedArtifact.artifact_type} v{selectedArtifact.version}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={saveArtifact}
                disabled={saveLoading}
                className="premium-button"
              >
                {saveLoading ? "Saving..." : "Save Artifact"}
              </button>
              {saveMessage ? <p className="text-sm text-slate-600">{saveMessage}</p> : null}
            </div>
          </div>

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
                Document
              </label>
              <textarea
                value={editableContent}
                onChange={(event) => setEditableContent(event.target.value)}
                className="mt-2 min-h-[32rem] w-full resize-y rounded-2xl border border-slate-200 bg-white px-5 py-5 font-mono text-sm leading-7 text-slate-800 shadow-inner outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-500/10 sm:min-h-[40rem]"
              />
            </div>
          </div>
        </section>
      ) : null}

      <section className="premium-card p-5">
        <h2 className="text-sm font-semibold text-slate-900">Artifacts</h2>
        <p className="mt-1 text-xs text-slate-500">
          Saved deliverables for this task. Select an artifact to edit it.
        </p>

        {artifacts.length > 0 ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                <p className="mt-2 text-xs text-slate-500">
                  {artifact.artifact_type} v{artifact.version}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="premium-empty mt-5 p-6 text-left">
            <p className="text-sm font-semibold text-slate-800">No artifacts yet.</p>
            <p className="mt-1 text-sm text-slate-600">
              Generate a deliverable to save the first artifact for this task.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
