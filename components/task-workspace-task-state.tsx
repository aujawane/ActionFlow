"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { ReactNode } from "react";

import { TaskCategoryBadge } from "@/components/task-category-badge";
import { InferredTaskBadge } from "@/components/task-execution-badges";
import { TaskCorrectionMenu } from "@/components/task-correction-menu";
import { TaskOwnerSelect } from "@/components/task-owner-select";
import { normalizeSuggestedSteps } from "@/lib/ai/task-chat-patch";
import { formatReadableDate } from "@/lib/format-date";
import { formatStatusLabel, statusBadgeClassName } from "@/lib/status-badge";
import { getCategoryDisplayLabel, getTaskCategorization } from "@/lib/task-deliverables";
import { isInferredTask } from "@/lib/task-execution-display";
import type { MeetingTask } from "@/lib/types";

type TaskWorkspaceState = {
  task: MeetingTask;
  setTask: (task: MeetingTask) => void;
};

const TaskWorkspaceContext = createContext<TaskWorkspaceState | null>(null);

export function TaskWorkspaceTaskProvider({
  initialTask,
  children
}: {
  initialTask: MeetingTask;
  children: ReactNode;
}) {
  const [task, setTask] = useState(initialTask);

  useEffect(() => {
    setTask(initialTask);
  }, [initialTask]);

  const value = useMemo(() => ({ task, setTask }), [task]);
  return (
    <TaskWorkspaceContext.Provider value={value}>
      {children}
    </TaskWorkspaceContext.Provider>
  );
}

export function useOptionalTaskWorkspaceState() {
  return useContext(TaskWorkspaceContext);
}

function useTaskWorkspaceState() {
  const value = useOptionalTaskWorkspaceState();
  if (!value) {
    throw new Error("Task workspace components require TaskWorkspaceTaskProvider.");
  }
  return value;
}

export type TaskWorkspaceParentCommitment = {
  id: string;
  title: string;
  progress: { completed: number; total: number };
};

/** A. Task Header -- everything needed to understand the task at a glance (title, status,
 * owner, due date, priority, parent commitment) in one read-first card. Editing still happens
 * through Ask Parfait (see TaskClarifications) -- there has never been a direct edit form on
 * this page, so this stays presentation-only rather than inventing a new form. */
export function TaskWorkspaceHeader({
  parentCommitment,
  meetingParticipantOptions
}: {
  parentCommitment?: TaskWorkspaceParentCommitment | null;
  /** Resolved participant names from this task's source meeting -- see
   * lib/meeting-participants.ts. Powers the owner-assignment dropdown below. */
  meetingParticipantOptions: string[];
}) {
  const { task, setTask } = useTaskWorkspaceState();
  const dueLabel = formatReadableDate(task.due_date ?? null);

  async function saveOwner(owner: string | null) {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner })
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.task) setTask(result.task);
  }

  return (
    <div className="premium-card p-6">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Task Workspace
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {task.task}
            </h1>
            {task.workspace_summary ? (
              <p className="max-w-3xl text-sm leading-6 text-slate-600">
                {task.workspace_summary}
              </p>
            ) : null}
          </div>
          <TaskCorrectionMenu task={task} onTaskUpdated={setTask} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className={`badge-state ${statusBadgeClassName(task.status)}`}>
            {formatStatusLabel(task.status)}
          </span>
          <span className="flex items-center text-slate-600">
            <span className="text-slate-500">Owner&nbsp;</span>
            <TaskOwnerSelect
              ownerValue={task.owner}
              options={meetingParticipantOptions}
              ariaLabel="Task owner"
              className="inline-edit-field font-semibold text-slate-800"
              onCommit={(owner) => {
                setTask({ ...task, owner });
                void saveOwner(owner);
              }}
            />
          </span>
          <span className="text-slate-600">
            <span className="text-slate-500">Due </span>
            <span className="font-semibold text-slate-800">{dueLabel ?? "Not set"}</span>
          </span>
          {task.priority === "high" ? (
            <span className="badge-state border-rose-200 bg-rose-50 text-rose-700">
              High priority
            </span>
          ) : (
            <span className="badge-meta capitalize">{task.priority} priority</span>
          )}
          <TaskCategoryBadge task={task} />
          {isInferredTask(task) ? <InferredTaskBadge /> : null}
        </div>

        {parentCommitment ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Parent
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">
              {parentCommitment.title}
            </span>
            <span className="text-xs text-slate-500">
              {parentCommitment.progress.completed} / {parentCommitment.progress.total} tasks
            </span>
            <Link
              href={`/commitments/${parentCommitment.id}` as Route}
              className="text-xs font-semibold text-brand-700 hover:underline"
            >
              Open commitment →
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Compact and omitted entirely when there is nothing to show -- extraction-provided next steps
 * are useful when present, but a large card reading "No suggested steps were generated" is pure
 * noise (see Phase 4 empty-section policy). */
export function TaskWorkspaceSuggestedSteps() {
  const { task } = useTaskWorkspaceState();
  const steps = normalizeSuggestedSteps(task.suggested_steps) ?? [];
  if (steps.length === 0) return null;

  return (
    <section className="premium-card p-5">
      <h2 className="text-sm font-semibold text-slate-900">Suggested Next Steps</h2>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-slate-700">
        {steps.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
      </ol>
    </section>
  );
}

/** Classification metadata + trust/debug layers (rationale, supporting context, extraction
 * confidence) -- deliberately reactive (context-driven) rather than static props, since Ask
 * Parfait can patch task_type/rationale/supporting_context and this must stay in sync without a
 * reload. Meant to be rendered inside the page's Context & Evidence disclosure, not as its own
 * card, so it never competes visually with the task-completion workflow above it. */
export function TaskWorkspaceClassificationEvidence() {
  const { task } = useTaskWorkspaceState();
  const categorization = getTaskCategorization(task);
  const confidenceLabel =
    task.confidence === null || task.confidence === undefined
      ? "N/A"
      : `${Math.round(task.confidence * 100)}%`;
  const rationale = task.rationale?.trim();
  const supportingContext = task.supporting_context?.trim();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs text-slate-600">
        <span>
          <span className="text-slate-500">Task type </span>
          <span className="font-medium capitalize text-slate-800">
            {formatStatusLabel(task.task_type)}
          </span>
        </span>
        <span>
          <span className="text-slate-500">Category </span>
          <span className="font-medium text-slate-800">
            {getCategoryDisplayLabel(categorization.category)}
          </span>
        </span>
        <span>
          <span className="text-slate-500">Extraction confidence </span>
          <span className="font-medium text-slate-800">{confidenceLabel}</span>
        </span>
      </div>

      {rationale ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Rationale
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-700">{rationale}</p>
        </div>
      ) : null}

      {supportingContext ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Supporting Context
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-700">{supportingContext}</p>
        </div>
      ) : null}
    </div>
  );
}
