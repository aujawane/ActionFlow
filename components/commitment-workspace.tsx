"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CommitmentCorrectionMenu } from "@/components/commitment-correction-menu";
import { Modal, ModalActions } from "@/components/modal";
import { TaskCorrectionMenu } from "@/components/task-correction-menu";
import { TaskOwnerSelect } from "@/components/task-owner-select";
import { isCommittedWork } from "@/lib/execution-display";
import { getActiveChildTasks } from "@/lib/execution-corrections";
import {
  computeCommitmentProgress,
  deriveCommitmentPeople,
  groupCommitmentTasksByOwner,
  selectNextBestTask,
  shouldPromptForCommitmentCompletion
} from "@/lib/project-execution";
import { formatReadableDate } from "@/lib/format-date";
import {
  getDeliverableLifecycleState,
  groupDeliverablesByType
} from "@/lib/task-deliverable-lifecycle";
import { statusBadgeClassName } from "@/lib/status-badge";
import type {
  CommitmentComment,
  CommitmentParticipant,
  MeetingCommitment,
  MeetingTask,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

/** A task's CURRENT dependency is AI-authored exactly when no human has ever touched this
 * task's dependency selection -- see app/api/tasks/[id]/dependencies/route.ts, which marks
 * "dependencies" in manual_override_fields the moment a person uses the picker below (add,
 * change, or remove). That single flag is deliberately coarse (per-task, not per-edge): once a
 * human decides, AI dependency inference never touches this task's dependencies again. */
function isAiInferredDependency(task: MeetingTask): boolean {
  return !(
    Array.isArray(task.manual_override_fields) &&
    task.manual_override_fields.includes("dependencies")
  );
}

function mergedFragmentCount(task: MeetingTask): number {
  const metadata = task.extraction_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const merged = (metadata as Record<string, unknown>).manually_merged_task_ids;
  return Array.isArray(merged) ? merged.length : 0;
}

/** Matches TaskClarifications' bubble timestamp formatting so Ask Parfait looks like the same
 * assistant system on both the Commitment and Task workspace. */
function formatCommentTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
}

const ASK_PARFAIT_EXAMPLE_PROMPTS = [
  "What's blocking this?",
  "Who owns this next?",
  "What should happen next?",
  "Summarize progress so far"
];

export function CommitmentWorkspace({
  initialCommitment,
  initialTasks,
  initialDependencies,
  initialComments,
  initialParticipants,
  initialArtifacts,
  sourceMeeting,
  currentUserName,
  meetingParticipantOptions
}: {
  initialCommitment: MeetingCommitment;
  initialTasks: MeetingTask[];
  initialDependencies: TaskDependency[];
  initialComments: CommitmentComment[];
  initialParticipants: CommitmentParticipant[];
  initialArtifacts: TaskArtifact[];
  sourceMeeting: { id: string; title: string | null };
  currentUserName?: string | null;
  /** Resolved participant names from this commitment's source meeting -- see
   * lib/meeting-participants.ts. Powers the per-task owner-assignment dropdown below. */
  meetingParticipantOptions: string[];
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [completionModalOpen, setCompletionModalOpen] = useState(false);
  const [completionPromptDismissed, setCompletionPromptDismissed] = useState(false);

  const progress = useMemo(
    () => computeCommitmentProgress(commitment, tasks),
    [commitment, tasks]
  );
  const completionPromptEligible = useMemo(
    () => shouldPromptForCommitmentCompletion(commitment, tasks),
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
  const deliverableRows = useMemo(() => {
    const rows: Array<{ taskItem: MeetingTask; current: TaskArtifact }> = [];
    for (const taskItem of tasks) {
      const taskArtifacts = initialArtifacts.filter((artifact) => artifact.task_id === taskItem.id);
      for (const group of groupDeliverablesByType(taskArtifacts)) {
        if (group.current) rows.push({ taskItem, current: group.current });
      }
    }
    return rows;
  }, [initialArtifacts, tasks]);

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
    if (result?.commitment) {
      setCommitment(result.commitment as MeetingCommitment);
      router.refresh();
      return result.commitment as MeetingCommitment;
    }
    return null;
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
      const updatedTask = result.task as MeetingTask;
      const previousProgress = computeCommitmentProgress(commitment, tasks);
      const nextTasks = tasks.map((task) =>
        task.id === taskId ? updatedTask : task
      );
      setTasks(nextTasks);
      if (
        updatedTask.status === "completed" &&
        previousProgress.percent < 100 &&
        shouldPromptForCommitmentCompletion(commitment, nextTasks)
      ) {
        setCompletionPromptDismissed(false);
        setCompletionModalOpen(true);
      }
      router.refresh();
    }
  }

  function dismissCompletionPrompt() {
    setCompletionModalOpen(false);
    setCompletionPromptDismissed(true);
  }

  async function markCommitmentComplete() {
    const updated = await updateCommitment({
      status: "completed",
      completion_state: "completed"
    });
    if (updated) {
      setCompletionModalOpen(false);
      setCompletionPromptDismissed(true);
    }
  }

  function handleTaskUpdated(updatedTask: MeetingTask) {
    // A task that moved to another commitment, went standalone, or moved to Future Scope no
    // longer belongs in this workspace's active list -- drop it immediately rather than leaving
    // a stale/misleading row behind (see Phase 6 UI-synchronization requirement).
    if (updatedTask.commitment_id !== commitment.id || !isCommittedWork(updatedTask)) {
      setTasks((current) => current.filter((task) => task.id !== updatedTask.id));
      return;
    }
    setTasks((current) =>
      current.map((task) => (task.id === updatedTask.id ? updatedTask : task))
    );
  }

  async function confirmMerge() {
    if (selected.length < 2) return;
    const [survivor, ...merged] = selected;
    setMergeBusy(true);
    setMergeError(null);
    const result = await request(`/api/commitments/${commitment.id}/tasks/merge`, {
      method: "POST",
      body: JSON.stringify({
        survivor_task_id: survivor,
        merged_task_ids: merged
      })
    });
    setMergeBusy(false);
    if (!result) {
      setMergeError(error || "Failed to merge tasks.");
      return;
    }
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
          task_id: merged.includes(dependency.task_id) ? survivor : dependency.task_id,
          depends_on_task_id: merged.includes(dependency.depends_on_task_id)
            ? survivor
            : dependency.depends_on_task_id
        }))
    );
    setSelected([]);
    setConfirmingMerge(false);
    router.refresh();
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

  useEffect(() => {
    const element = chatMessagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [comments, sending]);

  useEffect(() => {
    if (!completionPromptEligible) {
      setCompletionPromptDismissed(false);
      setCompletionModalOpen(false);
    }
  }, [completionPromptEligible]);

  async function submitMessage(value: string) {
    const trimmed = value.trim();
    if (!trimmed || sending) return;

    const optimisticComment: CommitmentComment = {
      id: `optimistic-${Date.now()}`,
      commitment_id: commitment.id,
      user_id: null,
      role: "user",
      message: trimmed,
      created_at: new Date().toISOString()
    };
    setSending(true);
    setComments((current) => [...current, optimisticComment]);
    setMessage("");

    const result = await request(`/api/commitments/${commitment.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ message: trimmed })
    });
    setSending(false);

    if (result?.comments) {
      setComments((current) => [
        ...current.filter((item) => item.id !== optimisticComment.id),
        ...(result.comments as CommitmentComment[])
      ]);
    } else {
      // The request failed -- request() already surfaced an error message, so just drop the
      // optimistic bubble and give the user their draft back rather than leaving a stuck message.
      setComments((current) => current.filter((item) => item.id !== optimisticComment.id));
      setMessage(trimmed);
    }
  }

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    void submitMessage(message);
  }

  function handleChatInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitMessage(message);
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
          <div className="flex items-start gap-1.5">
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
            <CommitmentCorrectionMenu
              commitment={commitment}
              hasActiveChildren={getActiveChildTasks(commitment, tasks).length > 0}
              onCommitmentUpdated={setCommitment}
              onDependenciesRefreshed={setDependencies}
            />
          </div>
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
        {completionPromptEligible && !completionPromptDismissed && !completionModalOpen ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div>
              <p className="text-sm font-semibold text-emerald-950">All tasks are complete</p>
              <p className="mt-1 text-sm text-emerald-800">Ready to close this commitment?</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="secondary-button" onClick={dismissCompletionPrompt}>
                Not yet
              </button>
              <button type="button" className="premium-button" disabled={busy} onClick={() => void markCommitmentComplete()}>
                Mark complete
              </button>
            </div>
          </div>
        ) : null}
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
            onClick={() => setConfirmingMerge(true)}
          >
            Merge tasks
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
                  const mergedCount = mergedFragmentCount(task);
                  return (
                    <article
                      key={task.id}
                      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-200 hover:shadow-md"
                    >
                      {/* 1. Completion checkbox, 2. title, 3. overflow menu. Owner avatar removed
                          here -- these cards already sit under the owner's own heading; repeating
                          it on every card added no information. */}
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
                        <TaskCorrectionMenu task={task} onTaskUpdated={handleTaskUpdated} />
                      </div>
                      {mergedCount > 0 ? (
                        <p className="mt-1 pl-6 text-xs text-slate-400">
                          Combined from {mergedCount + 1} extracted actions
                        </p>
                      ) : null}

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
                        <TaskOwnerSelect
                          ownerValue={task.owner}
                          options={meetingParticipantOptions}
                          ariaLabel={`Owner for ${task.task}`}
                          disabled={busy}
                          onCommit={(ownerValue) => void updateTask(task.id, { owner: ownerValue })}
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
                      {/* AI dependency inference is the default; the picker above is always the
                          human override. Deliberately quiet -- a small secondary note, not a
                          loud badge -- and only shown while the current dependency is still
                          AI-authored (see isAiInferredDependency). */}
                      {dependency && isAiInferredDependency(task) ? (
                        <p
                          className="mt-1 text-[10px] text-slate-400"
                          title="Parfait inferred this dependency automatically. Change or remove it above at any time."
                        >
                          AI inferred
                        </p>
                      ) : null}

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

      {/* Deliverables overview -- an overview of what child tasks have produced, not a second
          editor. Each row opens the same focused deliverable view Task Workspace links to. */}
      {deliverableRows.length > 0 ? (
        <section className="premium-card p-5">
          <h2 className="text-lg font-semibold text-slate-950">Deliverables</h2>
          <div className="mt-4 space-y-2">
            {deliverableRows.map(({ taskItem, current }) => {
              const state = getDeliverableLifecycleState(current);
              return (
                <Link
                  key={current.id}
                  href={`/deliverables/${current.id}` as Route}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-950">
                      {current.title}
                    </span>
                    <span className="text-xs text-slate-500">Task: {taskItem.task}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`badge-state ${
                        state === "accepted"
                          ? "border-brand-200 bg-brand-50 text-brand-800"
                          : state === "failed"
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : "border-slate-200 bg-slate-50 text-slate-700"
                      }`}
                    >
                      {state === "accepted" ? "Accepted" : state === "failed" ? "Failed" : "Draft"}
                    </span>
                    <span className="text-xs font-semibold text-brand-700">Open →</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <Modal
        open={completionModalOpen}
        title="All tasks are complete"
        onClose={dismissCompletionPrompt}
      >
        <h2 className="text-base font-semibold text-slate-950">All tasks are complete</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Is this commitment complete?
        </p>
        <ModalActions>
          <button type="button" className="secondary-button" onClick={dismissCompletionPrompt}>
            Not yet
          </button>
          <button type="button" className="premium-button" disabled={busy} onClick={() => void markCommitmentComplete()}>
            Mark commitment complete
          </button>
        </ModalActions>
      </Modal>

      <Modal
        open={confirmingMerge}
        title="Merge tasks"
        onClose={() => {
          setConfirmingMerge(false);
          setMergeError(null);
        }}
      >
        <h2 className="text-base font-semibold text-slate-950">Merge tasks</h2>
        {selected.length >= 2 ? (
          <>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              These {selected.length} tasks will be combined. Comments, deliverables, and
              dependencies from the others move onto the kept task.
            </p>
            <div className="mt-3 space-y-2">
              <div className="rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                  Kept
                </p>
                <p className="text-sm font-medium text-brand-900">
                  {tasks.find((task) => task.id === selected[0])?.task ?? "Selected task"}
                </p>
              </div>
              {selected.slice(1).map((taskId) => (
                <div key={taskId} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Combined in
                  </p>
                  <p className="text-sm text-slate-700">
                    {tasks.find((task) => task.id === taskId)?.task ?? "Selected task"}
                  </p>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {mergeError ? <p className="mt-3 text-sm text-rose-700">{mergeError}</p> : null}
        <ModalActions>
          <button
            type="button"
            onClick={() => {
              setConfirmingMerge(false);
              setMergeError(null);
            }}
            className="tertiary-button px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmMerge()}
            disabled={mergeBusy}
            className="premium-button px-4 py-2 text-sm"
          >
            {mergeBusy ? "Merging…" : "Merge tasks"}
          </button>
        </ModalActions>
      </Modal>

      <section className="premium-card p-5">
        <h2 className="text-lg font-semibold text-slate-950">Ask Parfait</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Ask about blockers, sequencing, or the next action.
        </p>

        <div ref={chatMessagesRef} className="mt-4 max-h-72 space-y-3 overflow-y-auto pr-1">
          {comments.length === 0 ? (
            <div className="space-y-4 py-4 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-50 text-lg text-brand-700">
                ✦
              </div>
              <p className="mx-auto max-w-xs text-sm leading-6 text-slate-600">
                Ask Parfait about blockers, sequencing, or what to do next on this commitment.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {ASK_PARFAIT_EXAMPLE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setMessage(prompt)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-600 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {comments.map((comment) => {
            const time = formatCommentTime(comment.created_at);

            // System entries (e.g. "Report incorrect extraction") are notes about the
            // commitment, not a conversational turn -- kept visually distinct from both the
            // user's own messages and Parfait's replies (see Ask Parfait comment-role audit).
            if (comment.role === "system") {
              return (
                <div key={comment.id} className="flex justify-center">
                  <p className="max-w-[90%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs leading-5 text-slate-500">
                    <span className="font-semibold uppercase tracking-wide text-slate-400">
                      System{time ? ` · ${time}` : ""}:{" "}
                    </span>
                    {comment.message}
                  </p>
                </div>
              );
            }

            const isUser = comment.role === "user";
            return (
              <div key={comment.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] ${isUser ? "text-right" : "text-left"}`}>
                  <p
                    className={`mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide ${
                      isUser ? "text-brand-700" : "text-slate-400"
                    }`}
                  >
                    {isUser ? "You" : "Parfait"}
                    {time ? ` · ${time}` : ""}
                  </p>
                  <div
                    className={`whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-sm leading-5 shadow-sm ${
                      isUser
                        ? "rounded-br-md bg-brand-700 text-white"
                        : "rounded-bl-md border border-slate-200 bg-white text-slate-700"
                    }`}
                  >
                    {comment.message}
                  </div>
                </div>
              </div>
            );
          })}

          {sending ? (
            <div className="flex justify-start">
              <div>
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Parfait
                </p>
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-3 shadow-sm">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-300 [animation-delay:300ms]" />
                  <span className="ml-1 text-xs text-slate-500">Thinking</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <form onSubmit={sendMessage} className="mt-4 flex items-end gap-2">
          <textarea
            className="premium-input max-h-[7.5rem] min-h-11 flex-1 resize-none py-2.5 text-sm"
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={handleChatInputKeyDown}
            rows={1}
            disabled={sending}
            placeholder="Ask Parfait about this commitment…"
          />
          <button className="premium-button h-11 px-4 text-xs" disabled={sending || !message.trim()}>
            {sending ? "Sending..." : "Send"}
          </button>
        </form>
        <p className="mt-2 text-center text-[10px] text-slate-400">
          Enter to send · Shift+Enter for a new line
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
      </section>
    </div>
  );
}
