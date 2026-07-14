"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { ReactNode } from "react";

import { TaskCategoryBadge } from "@/components/task-category-badge";
import { normalizeSuggestedSteps } from "@/lib/ai/task-chat-patch";
import type { MeetingTask } from "@/lib/types";

type TaskWorkspaceState = {
  task: MeetingTask;
  setTask: (task: MeetingTask) => void;
};

const TaskWorkspaceContext = createContext<TaskWorkspaceState | null>(null);

function formatLabel(value: string | null | undefined, fallback = "Unknown") {
  return (value || fallback)
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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

export function TaskWorkspaceHeader() {
  const { task } = useTaskWorkspaceState();
  return (
    <div className="premium-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-brand-700">Task Workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            {task.task}
          </h1>
          {task.workspace_summary ? (
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {task.workspace_summary}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <TaskCategoryBadge task={task} />
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold capitalize text-slate-700">
            {formatLabel(task.status, "pending")}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TaskWorkspaceEditableDetails() {
  const { task } = useTaskWorkspaceState();
  const suggestedSteps = normalizeSuggestedSteps(task.suggested_steps) ?? [];

  return (
    <>
      <section className="premium-card p-5">
        <h2 className="text-sm font-semibold text-slate-900">Task Summary</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Owner
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {task.owner || "Unassigned"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Priority
            </dt>
            <dd className="mt-1 text-sm font-medium capitalize text-slate-900">
              {task.priority}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Task Type
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {formatLabel(task.task_type, "other")}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Status
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {formatLabel(task.status, "pending")}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Due Date
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {task.due_date || "Not set"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Confidence
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {task.confidence === null
                ? "N/A"
                : `${Math.round(task.confidence * 100)}%`}
            </dd>
          </div>
        </dl>
      </section>

      <section className="premium-card p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Suggested Next Steps
        </h2>
        {suggestedSteps.length > 0 ? (
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            {suggestedSteps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            No suggested steps were generated.
          </p>
        )}
      </section>

      <section className="premium-card p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Rationale and Supporting Context
        </h2>
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Rationale
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-700">
              {task.rationale || "No task rationale has been added."}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Supporting Context
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-700">
              {task.supporting_context ||
                "No additional supporting context has been added."}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
