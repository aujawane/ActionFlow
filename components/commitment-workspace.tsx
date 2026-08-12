"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  computeCommitmentProgress,
  deriveCommitmentPeople,
  groupCommitmentTasksByOwner,
  selectNextBestTask
} from "@/lib/project-execution";
import { formatReadableDate } from "@/lib/format-date";
import { statusBadgeClassName } from "@/lib/status-badge";
import type {
  CommitmentComment,
  CommitmentParticipant,
  MeetingCommitment,
  MeetingTask,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

export function CommitmentWorkspace({
  initialCommitment,
  initialTasks,
  initialDependencies,
  initialComments,
  initialParticipants,
  initialArtifacts,
  sourceMeeting,
  currentUserName
}: {
  initialCommitment: MeetingCommitment;
  initialTasks: MeetingTask[];
  initialDependencies: TaskDependency[];
  initialComments: CommitmentComment[];
  initialParticipants: CommitmentParticipant[];
  initialArtifacts: TaskArtifact[];
  sourceMeeting: { id: string; title: string | null };
  currentUserName?: string | null;
}) {
  const router = useRouter();
  const [commitment, setCommitment] = useState(initialCommitment);
  const [tasks, setTasks] = useState(initialTasks);
  const [dependencies, setDependencies] = useState(initialDependencies);
  const [comments, setComments] = useState(initialComments);
  const [participants, setParticipants] = useState(initialParticipants);
  const [selected, setSelected] = useState<string[]>([]);
  const [newTask, setNewTask] = useState("");
  const [newParticipant, setNewParticipant] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const progress = useMemo(
    () => computeCommitmentProgress(commitment, tasks),
    [commitment, tasks]
  );
  const next = useMemo(
    () =>
      selectNextBestTask({
        tasks,
        dependencies,
        commitments: [commitment],
        currentUserName
      }),
    [commitment, currentUserName, dependencies, tasks]
  );
  const taskGroups = useMemo(() => groupCommitmentTasksByOwner(tasks), [tasks]);
  const people = useMemo(
    () => deriveCommitmentPeople({ commitment, tasks, participants }),
    [commitment, participants, tasks]
  );

  async function request(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.details || result.error || "Request failed.");
        return null;
      }
      return result;
    } catch {
      // A network failure here (e.g. a dropped dev-server connection) previously left this
      // request unresolved forever -- busy stayed true and no error surfaced, so a later retry
      // of the same field could look like it silently did nothing.
      setError("Network error. The change was not saved -- please try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function updateCommitment(patch: Record<string, unknown>) {
    const result = await request(`/api/commitments/${commitment.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    if (result?.commitment) setCommitment(result.commitment as MeetingCommitment);
  }

  async function updateTask(taskId: string, patch: Record<string, unknown>) {
    const result = await request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    if (result?.task) {
      // Commitment progress is derived from this same `tasks` state (see the `progress`
      // useMemo below), so updating it here is what makes the progress bar move immediately.
      // router.refresh() also runs so any other consumer of this page's server props (e.g. a
      // back-navigation into this route) picks up the persisted change too.
      setTasks((current) =>
        current.map((task) =>
          task.id === taskId ? (result.task as MeetingTask) : task
        )
      );
      router.refresh();
    }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!newTask.trim()) return;
    const result = await request(`/api/commitments/${commitment.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ task: newTask.trim() })
    });
    if (result?.task) {
      setTasks((current) => [...current, result.task as MeetingTask]);
      setNewTask("");
    }
  }

  async function moveTask(taskId: string, direction: -1 | 1) {
    const group = taskGroups.find((item) =>
      item.tasks.some((task) => task.id === taskId)
    );
    if (!group) return;
    const index = group.tasks.findIndex((task) => task.id === taskId);
    const target = index + direction;
    if (target < 0 || target >= group.tasks.length) return;
    const ordered = [...tasks];
    const currentIndex = ordered.findIndex((task) => task.id === taskId);
    const targetIndex = ordered.findIndex(
      (task) => task.id === group.tasks[target].id
    );
    [ordered[currentIndex], ordered[targetIndex]] = [
      ordered[targetIndex],
      ordered[currentIndex]
    ];
    const result = await request(`/api/commitments/${commitment.id}/tasks`, {
      method: "PATCH",
      body: JSON.stringify({ task_ids: ordered.map((task) => task.id) })
    });
    if (result) {
      setTasks(ordered.map((task, position) => ({ ...task, position })));
    }
  }

  async function addParticipant(event: React.FormEvent) {
    event.preventDefault();
    if (!newParticipant.trim()) return;
    const result = await request(
      `/api/commitments/${commitment.id}/participants`,
      {
        method: "POST",
        body: JSON.stringify({ participant_name: newParticipant.trim() })
      }
    );
    if (result?.participant) {
      setParticipants((current) => [
        ...current.filter(
          (participant) =>
            participant.participant_name.toLowerCase() !==
            newParticipant.trim().toLowerCase()
        ),
        result.participant as CommitmentParticipant
      ]);
      setNewParticipant("");
    }
  }

  async function removeParticipant(participantId: string) {
    const result = await request(
      `/api/commitments/${commitment.id}/participants`,
      {
        method: "DELETE",
        body: JSON.stringify({ participant_id: participantId })
      }
    );
    if (result) {
      setParticipants((current) =>
        current.filter((participant) => participant.id !== participantId)
      );
    }
  }

  async function mergeSelected() {
    if (selected.length < 2) return;
    const [survivor, ...merged] = selected;
    const result = await request(
      `/api/commitments/${commitment.id}/tasks/merge`,
      {
        method: "POST",
        body: JSON.stringify({
          survivor_task_id: survivor,
          merged_task_ids: merged
        })
      }
    );
    if (result) {
      setTasks((current) => current.filter((task) => !merged.includes(task.id)));
      setDependencies((current) =>
        current
          .filter(
            (dependency) =>
              !merged.includes(dependency.task_id) &&
              !merged.includes(dependency.depends_on_task_id)
          )
          .map((dependency) => ({
            ...dependency,
            task_id: merged.includes(dependency.task_id)
              ? survivor
              : dependency.task_id,
            depends_on_task_id: merged.includes(dependency.depends_on_task_id)
              ? survivor
              : dependency.depends_on_task_id
          }))
      );
      setSelected([]);
      router.refresh();
    }
  }

  async function setDependency(taskId: string, dependsOnTaskId: string) {
    const result = await request(`/api/tasks/${taskId}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({
        depends_on_task_ids: dependsOnTaskId ? [dependsOnTaskId] : []
      })
    });
    if (result?.dependencies) {
      setDependencies((current) => [
        ...current.filter((dependency) => dependency.task_id !== taskId),
        ...(result.dependencies as TaskDependency[])
      ]);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    const result = await request(`/api/commitments/${commitment.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ message: message.trim() })
    });
    if (result?.comments) {
      setComments((current) => [
        ...current,
        ...(result.comments as CommitmentComment[])
      ]);
      setMessage("");
    }
  }

  return (
    <div className="space-y-6">
      <section className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Commitment Workspace
            </p>
            <input
              className="mt-2 w-full border-0 bg-transparent p-0 text-2xl font-semibold text-slate-950 outline-none"
              value={commitment.title}
              onChange={(event) =>
                setCommitment((current) => ({
                  ...current,
                  title: event.target.value
                }))
              }
              onBlur={() => void updateCommitment({ title: commitment.title })}
            />
            <textarea
              className="premium-input mt-3 min-h-20"
              value={commitment.description ?? ""}
              placeholder="Commitment description"
              onChange={(event) =>
                setCommitment((current) => ({
                  ...current,
                  description: event.target.value || null
                }))
              }
              onBlur={() =>
                void updateCommitment({ description: commitment.description })
              }
            />
          </div>
          <select
            className="premium-input w-44"
            value={commitment.status}
            onChange={(event) =>
              void updateCommitment({
                status: event.target.value,
                completion_state:
                  event.target.value === "completed"
                    ? "completed"
                    : event.target.value === "blocked"
                      ? "blocked"
                      : event.target.value === "in_progress"
                        ? "in_progress"
                        : "open"
              })
            }
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <input
            className="premium-input"
            value={commitment.lead_owner_name ?? commitment.owner ?? ""}
            placeholder="Lead owner"
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                owner: event.target.value || null,
                lead_owner_name: event.target.value || null
              }))
            }
            onBlur={() =>
              void updateCommitment({
                lead_owner_name:
                  commitment.lead_owner_name ?? commitment.owner ?? null
              })
            }
          />
          <select
            className="premium-input"
            value={commitment.priority}
            onChange={(event) =>
              void updateCommitment({ priority: event.target.value })
            }
          >
            <option value="high">High priority</option>
            <option value="medium">Medium priority</option>
            <option value="low">Low priority</option>
          </select>
          <input
            className="premium-input"
            type="date"
            value={commitment.due_date ?? ""}
            onChange={(event) => {
              const dueDate = event.target.value || null;
              setCommitment((current) => ({ ...current, due_date: dueDate }));
              void updateCommitment({ due_date: dueDate });
            }}
          />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            People involved
          </span>
          {people.map((person) => (
            <span
              key={person.toLowerCase()}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-800">
                {person
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase()}
              </span>
              {person}
              {participants.find(
                (participant) =>
                  participant.manually_added &&
                  participant.participant_name.toLowerCase() ===
                    person.toLowerCase()
              ) ? (
                <button
                  type="button"
                  className="ml-0.5 text-slate-400 hover:text-rose-600"
                  aria-label={`Remove ${person}`}
                  onClick={() =>
                    void removeParticipant(
                      participants.find(
                        (participant) =>
                          participant.participant_name.toLowerCase() ===
                          person.toLowerCase()
                      )!.id
                    )
                  }
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
          <form className="flex gap-1" onSubmit={addParticipant}>
            <input
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
              value={newParticipant}
              placeholder="Add person"
              onChange={(event) => setNewParticipant(event.target.value)}
            />
            <button
              className="secondary-button px-2 py-1 text-xs"
              disabled={!newParticipant.trim() || busy}
            >
              Add
            </button>
          </form>
        </div>
        <Link
          href={`/meetings/${sourceMeeting.id}` as Route}
          className="mt-4 inline-flex text-xs font-semibold text-brand-700 hover:underline"
        >
          Source: {sourceMeeting.title || "Untitled meeting"}
        </Link>
        <div className="mt-5">
          <div className="mb-2 flex justify-between text-sm text-slate-600">
            <span>Progress</span>
            <span>
              {progress.completed} of {progress.total} complete
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-600"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      </section>

      {next ? (
        <section className="premium-card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Next Best Task
            </p>
            <p className="mt-1 font-semibold text-slate-950">{next.task.task}</p>
          </div>
          <Link href={`/tasks/${next.task.id}` as Route} className="premium-button">
            Execute Task
          </Link>
        </section>
      ) : null}

      <section className="premium-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">Tasks</h2>
          <button
            type="button"
            className="secondary-button"
            disabled={selected.length < 2 || busy}
            onClick={() => void mergeSelected()}
          >
            Merge Selected into First
          </button>
        </div>
        <form onSubmit={createTask} className="mt-4 flex gap-2">
          <input
            className="premium-input"
            placeholder="Create a task"
            value={newTask}
            onChange={(event) => setNewTask(event.target.value)}
          />
          <button className="premium-button" disabled={busy || !newTask.trim()}>
            Add Task
          </button>
        </form>
        <div className="mt-6 space-y-7">
          {taskGroups.map((group) => (
            <section key={group.owner ?? "__unassigned__"}>
              <div className="mb-3 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-800">
                  {group.owner
                    ? group.owner
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join("")
                        .toUpperCase()
                    : "?"}
                </span>
                <h3 className="text-sm font-semibold text-slate-900">
                  {group.owner ?? "Unassigned"}
                </h3>
                <span className="text-xs text-slate-400">{group.tasks.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {group.tasks.map((task, groupIndex) => {
                  const dependency = dependencies.find(
                    (item) => item.task_id === task.id
                  );
                  const blocker = dependency
                    ? tasks.find(
                        (candidate) =>
                          candidate.id === dependency.depends_on_task_id &&
                          candidate.status !== "completed"
                      )
                    : null;
                  const artifactCount = initialArtifacts.filter(
                    (artifact) => artifact.task_id === task.id
                  ).length;
                  const dueLabel = formatReadableDate(task.due_date ?? null);
                  return (
                    <article
                      key={task.id}
                      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-200 hover:shadow-md"
                    >
                      {/* 1. Completion checkbox, 2. title. Owner avatar removed here -- these
                          cards already sit under the owner's own heading; repeating it on every
                          card added no information. */}
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-brand-600"
                          checked={selected.includes(task.id)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, task.id]
                                : current.filter((id) => id !== task.id)
                            )
                          }
                          aria-label={`Select ${task.task}`}
                        />
                        <Link
                          href={`/tasks/${task.id}` as Route}
                          className="min-w-0 flex-1 text-sm font-semibold leading-5 text-slate-950 hover:text-brand-700"
                        >
                          {task.task}
                        </Link>
                      </div>

                      {/* 3. Status -- a real <select>, styled to read as a status pill rather
                          than a form field, so it stays instantly scannable and still edits
                          in place with the exact same change handler. */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <select
                          className={`badge-state cursor-pointer border ${statusBadgeClassName(task.status)}`}
                          value={task.status}
                          disabled={busy}
                          onChange={(event) => void updateTask(task.id, { status: event.target.value })}
                          aria-label={`Status for ${task.task}`}
                        >
                          <option value="pending">Pending</option>
                          <option value="in_progress">In progress</option>
                          <option value="blocked">Blocked</option>
                          <option value="completed">Complete</option>
                          <option value="dismissed">Dismissed</option>
                        </select>
                        {/* 4. Dependency/blocker -- only shown when relevant. */}
                        {blocker ? (
                          <span
                            className="badge-state border-rose-200 bg-rose-50 text-rose-700"
                            title={`Blocked by ${blocker.task}`}
                          >
                            Blocked by {blocker.task}
                          </span>
                        ) : null}
                        {task.inferred ? <span className="badge-internal">Inferred</span> : null}
                        {dueLabel ? <span className="badge-meta">Due {dueLabel}</span> : null}
                        {artifactCount > 0 ? (
                          <span className="badge-meta">
                            {artifactCount} deliverable{artifactCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>

                      {/* 5. Owner (reassignment) + dependency picker -- present for every task
                          (functionality preserved) but visually quiet, since it duplicates the
                          owner-group heading in the common case. */}
                      <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-100 pt-2">
                        <input
                          className="inline-edit-field"
                          value={task.owner ?? ""}
                          placeholder="Unassigned"
                          onChange={(event) =>
                            setTasks((current) =>
                              current.map((item) =>
                                item.id === task.id
                                  ? { ...item, owner: event.target.value || null }
                                  : item
                              )
                            )
                          }
                          onBlur={() => void updateTask(task.id, { owner: task.owner })}
                          aria-label={`Owner for ${task.task}`}
                        />
                        <select
                          className="inline-edit-field"
                          value={dependency?.depends_on_task_id ?? ""}
                          onChange={(event) => void setDependency(task.id, event.target.value)}
                          aria-label={`Dependency for ${task.task}`}
                        >
                          <option value="">No dependency</option>
                          {tasks
                            .filter((candidate) => candidate.id !== task.id)
                            .map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                After: {candidate.task}
                              </option>
                            ))}
                        </select>
                      </div>

                      <div className="mt-1.5 flex justify-end gap-0.5">
                        <button
                          className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                          type="button"
                          disabled={groupIndex === 0 || busy}
                          onClick={() => void moveTask(task.id, -1)}
                          aria-label={`Move ${task.task} earlier`}
                          title="Move earlier in this owner's order"
                        >
                          ← Earlier
                        </button>
                        <button
                          className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                          type="button"
                          disabled={groupIndex === group.tasks.length - 1 || busy}
                          onClick={() => void moveTask(task.id, 1)}
                          aria-label={`Move ${task.task} later`}
                          title="Move later in this owner's order"
                        >
                          Later →
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="premium-card p-5">
        <h2 className="text-lg font-semibold text-slate-950">Ask Parfait</h2>
        <div className="mt-4 max-h-72 space-y-3 overflow-y-auto">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className={`rounded-xl p-3 text-sm ${
                comment.role === "user"
                  ? "ml-8 bg-brand-50 text-brand-950"
                  : "mr-8 bg-slate-50 text-slate-700"
              }`}
            >
              {comment.message}
            </div>
          ))}
        </div>
        <form onSubmit={sendMessage} className="mt-4 flex gap-2">
          <textarea
            className="premium-input min-h-16"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask about blockers, sequencing, or the next action…"
          />
          <button className="premium-button" disabled={busy || !message.trim()}>
            Send
          </button>
        </form>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
      </section>
    </div>
  );
}
