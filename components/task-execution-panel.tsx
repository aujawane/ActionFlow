"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Modal, ModalActions } from "@/components/modal";
import { useOptionalTaskWorkspaceState } from "@/components/task-workspace-task-state";
import { formatReadableDate } from "@/lib/format-date";
import {
  getDeliverableLifecycleState,
  groupDeliverablesByType
} from "@/lib/task-deliverable-lifecycle";
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

function lifecycleBadgeClassName(state: "draft" | "accepted" | "failed") {
  if (state === "accepted") return "border-brand-200 bg-brand-50 text-brand-800";
  if (state === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function lifecycleLabel(state: "draft" | "accepted" | "failed") {
  if (state === "accepted") return "Accepted";
  if (state === "failed") return "Failed";
  return "Draft";
}

async function parseJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
}

export function TaskExecutionPanel({
  taskId,
  workspaceType,
  initialArtifacts
}: TaskExecutionPanelProps) {
  const router = useRouter();
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
  const [guideLoading, setGuideLoading] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [acceptTargetId, setAcceptTargetId] = useState<string | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);

  const promptLabel = promptLabelByWorkspaceType[workspaceType];
  const groups = groupDeliverablesByType(artifacts);
  const acceptTarget = artifacts.find((item) => item.id === acceptTargetId) ?? null;

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

    const response = await fetch(
      `/api/tasks/${taskId}/generate-deliverable?regenerate=${regenerate ? "true" : "false"}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
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
    router.refresh();
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

  async function confirmAccept() {
    if (!acceptTarget) return;
    setAcceptBusy(true);
    const response = await fetch(`/api/deliverables/${acceptTarget.id}/accept`, {
      method: "POST"
    });
    const result = await parseJson<{ artifact?: TaskArtifact; task?: unknown } & ApiError>(
      response
    );
    setAcceptBusy(false);
    if (!response.ok || !result.artifact) return;

    setArtifacts((current) =>
      current.map((item) => (item.id === result.artifact!.id ? result.artifact! : item))
    );
    if (result.task && workspaceState) {
      workspaceState.setTask(result.task as Parameters<typeof workspaceState.setTask>[0]);
    }
    setAcceptTargetId(null);
    router.refresh();
  }

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
              {artifactLoading ? `Parfait is creating the ${deliverableNoun}…` : deliverableButtonLabel}
            </button>

            {artifactError ? (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {artifactError}
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

      {/* C. Deliverables -- compact cards only. Deeper interaction (edit, regenerate with
          instructions, version history) lives on the focused deliverable view; forcing the full
          editor into this page was the thing Phase 7 explicitly moved away from. */}
      <section className="premium-card p-5 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Generated Output
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Deliverables</h2>
        </div>

        {groups.length > 0 ? (
          <div className="mt-5 space-y-3">
            {groups.map((group) => {
              const current = group.current;
              if (!current) {
                return group.latestFailed ? (
                  <div
                    key={group.deliverableType}
                    className="rounded-2xl border border-rose-200 bg-rose-50 p-4"
                  >
                    <p className="text-sm font-semibold text-rose-700">Generation failed</p>
                    <p className="mt-1 text-xs text-rose-700">
                      {group.latestFailed.content || "Parfait was unable to generate this deliverable."}
                    </p>
                    <button
                      type="button"
                      onClick={() => generateDeliverable(true)}
                      disabled={artifactLoading}
                      className="secondary-button mt-3 px-3 py-1.5 text-xs"
                    >
                      {artifactLoading ? "Retrying…" : "Retry"}
                    </button>
                  </div>
                ) : null;
              }
              const state = getDeliverableLifecycleState(current);
              const preview = current.content.replace(/\s+/g, " ").trim().slice(0, 160);
              return (
                <div
                  key={group.deliverableType}
                  className="rounded-2xl border border-slate-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-950">{current.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className={`badge-state ${lifecycleBadgeClassName(state)}`}>
                          {lifecycleLabel(state)}
                        </span>
                        <span>Generated {formatReadableDate(current.created_at)}</span>
                      </div>
                    </div>
                  </div>
                  {preview ? (
                    <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
                      &ldquo;{preview}
                      {current.content.length > 160 ? "…" : ""}&rdquo;
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/deliverables/${current.id}` as Route}
                      className="secondary-button px-3 py-1.5 text-xs"
                    >
                      Open
                    </Link>
                    {state === "draft" ? (
                      <button
                        type="button"
                        onClick={() => setAcceptTargetId(current.id)}
                        className="premium-button px-3 py-1.5 text-xs"
                      >
                        Accept
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => generateDeliverable(true)}
                      disabled={artifactLoading}
                      className="tertiary-button px-3 py-1.5 text-xs"
                    >
                      {artifactLoading ? "Regenerating…" : "Regenerate"}
                    </button>
                    {group.latestFailed ? (
                      <span className="text-xs text-rose-600">Last regeneration failed</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
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

      <Modal
        open={acceptTargetId !== null}
        title="Accept this deliverable?"
        onClose={() => setAcceptTargetId(null)}
      >
        <h2 className="text-base font-semibold text-slate-950">Accept this deliverable?</h2>
        {acceptTarget && task ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {task.status === "completed" ? (
              <>
                <span className="font-semibold text-slate-900">&ldquo;{task.task}&rdquo;</span>{" "}
                is already completed by another accepted deliverable. Accepting this one keeps
                it completed.
              </>
            ) : (
              <>
                This will mark:
                <br />
                <span className="font-semibold text-slate-900">&ldquo;{task.task}&rdquo;</span>
                <br />
                as completed.
              </>
            )}
          </p>
        ) : null}
        <ModalActions>
          <button
            type="button"
            onClick={() => setAcceptTargetId(null)}
            className="tertiary-button px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmAccept()}
            disabled={acceptBusy}
            className="premium-button px-4 py-2 text-sm"
          >
            {acceptBusy ? "Accepting…" : "Accept & Complete Task"}
          </button>
        </ModalActions>
      </Modal>
    </div>
  );
}
