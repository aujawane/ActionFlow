"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";

import type { MeetingTask } from "@/lib/types";

type ExecutionDashboardProps = {
  participants: string[];
  tasks: MeetingTask[];
};

type TaskOwnerUpdateResponse = {
  task?: MeetingTask;
  error?: string;
  details?: string;
};

function formatLabel(value: string | null | undefined, fallback = "Unknown") {
  return (value || fallback)
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeOwner(owner: string | null | undefined) {
  const normalized = owner?.trim();
  if (!normalized || normalized.toLowerCase() === "unassigned") {
    return null;
  }
  return normalized;
}

function normalizeParticipantName(name: string | null | undefined) {
  const normalized = normalizeOwner(name);
  if (!normalized || normalized.toLowerCase() === "unknown speaker") {
    return null;
  }
  return normalized;
}

function dedupeNames(names: Array<string | null | undefined>) {
  const byLowercaseName = new Map<string, string>();
  for (const name of names) {
    const normalized = normalizeParticipantName(name);
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (!byLowercaseName.has(key)) {
      byLowercaseName.set(key, normalized);
    }
  }

  return Array.from(byLowercaseName.values()).sort((a, b) => a.localeCompare(b));
}

function canonicalizeParticipantName(
  name: string | null | undefined,
  participantNames: string[]
) {
  const normalized = normalizeParticipantName(name);
  if (!normalized) return null;

  return (
    participantNames.find(
      (participantName) => participantName.toLowerCase() === normalized.toLowerCase()
    ) ?? normalized
  );
}

function sortByPriority(tasks: MeetingTask[]) {
  const weight: Record<MeetingTask["priority"], number> = {
    high: 0,
    medium: 1,
    low: 2
  };

  return [...tasks].sort((a, b) => {
    const priorityDelta = weight[a.priority] - weight[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return a.task.localeCompare(b.task);
  });
}

export function ExecutionDashboard({ participants, tasks }: ExecutionDashboardProps) {
  const [localTasks, setLocalTasks] = useState(tasks);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const participantNames = useMemo(() => {
    const taskOwners = localTasks.map((task) => task.owner);
    return dedupeNames([...participants, ...taskOwners]);
  }, [localTasks, participants]);

  const taskCountsByOwner = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of localTasks) {
      const owner = canonicalizeParticipantName(task.owner, participantNames);
      if (!owner) continue;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return counts;
  }, [localTasks, participantNames]);

  const tasksByOwner = useMemo(() => {
    const groups = new Map<string, MeetingTask[]>();
    for (const ownerName of participantNames) {
      groups.set(ownerName, []);
    }

    const unassigned: MeetingTask[] = [];
    for (const task of localTasks) {
      const owner = canonicalizeParticipantName(task.owner, participantNames);
      if (!owner) {
        unassigned.push(task);
        continue;
      }

      groups.set(owner, [...(groups.get(owner) ?? []), task]);
    }

    return {
      assignedGroups: participantNames.map((ownerName) => ({
        ownerName,
        tasks: sortByPriority(groups.get(ownerName) ?? [])
      })),
      unassigned: sortByPriority(unassigned)
    };
  }, [localTasks, participantNames]);

  async function updateTaskOwner(taskId: string, owner: string | null) {
    const previousTasks = localTasks;
    setError(null);
    setUpdatingTaskId(taskId);
    setLocalTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, owner } : task))
    );

    try {
      const response = await fetch(`/api/tasks/${taskId}/owner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner })
      });
      const result = (await response.json().catch(() => ({}))) as TaskOwnerUpdateResponse;

      if (!response.ok || !result.task) {
        setLocalTasks(previousTasks);
        setError(result.error || "Failed to update task owner.");
        return;
      }

      setLocalTasks((current) =>
        current.map((task) => (task.id === taskId ? result.task! : task))
      );
    } catch {
      setLocalTasks(previousTasks);
      setError("Request failed while updating task owner.");
    } finally {
      setUpdatingTaskId(null);
    }
  }

  return (
    <section className="premium-card space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Execution Dashboard
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
            Work by Owner
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Review task ownership, fix assignments, and open task workspaces.
          </p>
        </div>
        <div className="rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800">
          {localTasks.length} {localTasks.length === 1 ? "task" : "tasks"}
        </div>
      </div>

      {participantNames.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {participantNames.map((participant) => (
            <div
              key={participant}
              className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
            >
              <p className="truncate text-sm font-semibold text-slate-900">{participant}</p>
              <p className="mt-1 text-xs text-slate-500">
                {taskCountsByOwner.get(participant) ?? 0} assigned
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="premium-empty p-5 text-left">
          <p className="text-sm font-semibold text-slate-800">No speakers detected yet.</p>
          <p className="mt-1 text-sm text-slate-600">
            Transcript speaker names will appear here after transcript ingestion.
          </p>
        </div>
      )}

      {error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="space-y-5">
        {tasksByOwner.assignedGroups.map(({ ownerName, tasks: ownerTasks }) => (
          <OwnerSection
            key={ownerName}
            title={ownerName}
            tasks={ownerTasks}
            participants={participantNames}
            updatingTaskId={updatingTaskId}
            onOwnerChange={updateTaskOwner}
          />
        ))}

        <OwnerSection
          title="Unassigned Work"
          tasks={tasksByOwner.unassigned}
          participants={participantNames}
          updatingTaskId={updatingTaskId}
          onOwnerChange={updateTaskOwner}
        />
      </div>
    </section>
  );
}

function OwnerSection({
  title,
  tasks,
  participants,
  updatingTaskId,
  onOwnerChange
}: {
  title: string;
  tasks: MeetingTask[];
  participants: string[];
  updatingTaskId: string | null;
  onOwnerChange: (taskId: string, owner: string | null) => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      {tasks.length > 0 ? (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              participants={participants}
              updating={updatingTaskId === task.id}
              onOwnerChange={onOwnerChange}
            />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No tasks in this section.</p>
      )}
    </section>
  );
}

function TaskCard({
  task,
  participants,
  updating,
  onOwnerChange
}: {
  task: MeetingTask;
  participants: string[];
  updating: boolean;
  onOwnerChange: (taskId: string, owner: string | null) => void;
}) {
  const owner = canonicalizeParticipantName(task.owner, participants);

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold leading-6 text-slate-950">{task.task}</h4>
          <p className="mt-1 text-xs text-slate-500">
            Owner: <span className="font-medium text-slate-700">{owner ?? "Unassigned"}</span>
          </p>
        </div>
        <Link href={`/tasks/${task.id}` as Route} className="secondary-button px-3 py-1.5 text-xs">
          Open Workspace
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full border border-brand-100 bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-800">
          {formatLabel(task.workspace_type, "other")}
        </span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium capitalize text-slate-700">
          {task.priority} priority
        </span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium capitalize text-slate-700">
          {formatLabel(task.status, "pending")}
        </span>
      </div>

      {task.workspace_summary ? (
        <p className="mt-3 text-sm leading-6 text-slate-600">{task.workspace_summary}</p>
      ) : null}

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        Assign Owner
      </label>
      <select
        value={owner ?? ""}
        disabled={updating}
        onChange={(event) => onOwnerChange(task.id, event.target.value || null)}
        className="premium-input mt-1 text-sm"
      >
        <option value="">Unassigned</option>
        {participants.map((participant) => (
          <option key={participant} value={participant}>
            {participant}
          </option>
        ))}
        {owner && !participants.includes(owner) ? (
          <option value={owner}>{owner}</option>
        ) : null}
      </select>
      {updating ? <p className="mt-2 text-xs text-slate-500">Updating owner...</p> : null}
    </article>
  );
}
