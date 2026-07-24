"use client";

import Link from "next/link";
import type { Route } from "next";

import { InferredTaskBadge } from "@/components/task-execution-badges";
import { isInferredTask } from "@/lib/task-execution-display";
import type { MeetingTask } from "@/lib/types";

export function StandaloneTasksPanel({ tasks }: { tasks: MeetingTask[] }) {
  if (tasks.length === 0) return null;

  return (
    <section className="premium-card space-y-3 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Execution Graph
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">
          Standalone Tasks
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Actionable committed work that does not belong to a broader commitment.
        </p>
      </div>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5"
          >
            <div>
              <p className="text-sm font-medium text-slate-900">
                {task.task}
                {isInferredTask(task) ? (
                  <span className="ml-2 inline-flex align-middle">
                    <InferredTaskBadge />
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-slate-500">
                {task.owner || "Unassigned"} · {task.status.replaceAll("_", " ")}
              </p>
            </div>
            <Link
              href={`/tasks/${task.id}` as Route}
              className="text-xs font-semibold text-brand-700 hover:underline"
            >
              Open workspace
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
