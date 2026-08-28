"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";

import { InferredTaskBadge } from "@/components/task-execution-badges";
import { TaskCorrectionMenu } from "@/components/task-correction-menu";
import { TaskOwnerSelect } from "@/components/task-owner-select";
import { isTaskExecutable } from "@/lib/execution-display";
import { isInferredTask } from "@/lib/task-execution-display";
import { formatStatusLabel, statusBadgeClassName } from "@/lib/status-badge";
import type { MeetingTask } from "@/lib/types";

export function StandaloneTasksPanel({
  tasks: initialTasks,
  meetingParticipantOptions
}: {
  tasks: MeetingTask[];
  /** Resolved participant names from this meeting -- see lib/meeting-participants.ts. One shared
   * list for every task card's owner dropdown, loaded once by the caller (no per-task query). */
  meetingParticipantOptions: string[];
}) {
  const [tasks, setTasks] = useState(initialTasks);

  // router.refresh() after analysis completes re-renders the server parent with fresh tasks --
  // without this, this component's local state (needed for optimistic corrections) would
  // silently keep showing the pre-analysis snapshot until a full page reload.
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  function handleTaskUpdated(updated: MeetingTask) {
    // A task that moved into a commitment or over to Future Scope is no longer standalone/active
    // -- drop it from this list immediately rather than leaving a stale row.
    if (updated.commitment_id || updated.execution_classification !== "committed") {
      setTasks((current) => current.filter((task) => task.id !== updated.id));
      return;
    }
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
  }

  async function updateOwner(taskId: string, owner: string | null) {
    // Same canonical PATCH /api/tasks/[id] pathway used by Commitment Workspace and Task
    // Workspace -- same authorization, manual_override_fields/preserve_on_reanalysis handling.
    // Only `owner` is patched, so classification/commitment_id (and therefore standalone
    // membership) never changes here.
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner })
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.task) handleTaskUpdated(result.task as MeetingTask);
  }

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
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">
                {task.task}
                {isInferredTask(task) ? (
                  <span className="ml-2 inline-flex align-middle">
                    <InferredTaskBadge />
                  </span>
                ) : null}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`badge-state ${statusBadgeClassName(task.status)}`}>
                  {formatStatusLabel(task.status)}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span>Owner</span>
                  <TaskOwnerSelect
                    ownerValue={task.owner}
                    options={meetingParticipantOptions}
                    ariaLabel={`Owner for ${task.task}`}
                    className="inline-edit-field py-0.5 text-xs"
                    onCommit={(owner) => void updateOwner(task.id, owner)}
                  />
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {isTaskExecutable(task) ? (
                <Link
                  href={`/tasks/${task.id}` as Route}
                  className="tertiary-button px-2.5 py-1 text-xs text-brand-700"
                >
                  Execute Task
                </Link>
              ) : null}
              <TaskCorrectionMenu
                task={task}
                onTaskUpdated={handleTaskUpdated}
                meetingParticipantOptions={meetingParticipantOptions}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
