import { isCommitmentCurrentGeneration, isTaskCurrentGeneration } from "@/lib/execution-generation";
import type {
  ExecutionClassification,
  MeetingCommitment,
  MeetingTask,
  MeetingTaskStatus
} from "@/lib/types";

export function getExecutionClassification(
  value: ExecutionClassification | null | undefined
): ExecutionClassification {
  return value ?? "committed";
}

export function isCommittedWork(
  item: Pick<MeetingCommitment | MeetingTask, "execution_classification">
) {
  return getExecutionClassification(item.execution_classification) === "committed";
}

// Explicit allowlists (not a "not dismissed" negative check) against the real
// MeetingTaskStatus enum -- see lib/types.ts. A dismissed task is neither still outstanding
// (isTaskExecutable) nor countable toward progress (isTaskCountedForProgress); a completed task
// is no longer outstanding but still counts toward progress, since "done" is part of "how much is
// done."
const EXECUTABLE_TASK_STATUSES: ReadonlySet<MeetingTaskStatus> = new Set([
  "pending",
  "in_progress",
  "blocked"
]);
const PROGRESS_COUNTED_TASK_STATUSES: ReadonlySet<MeetingTaskStatus> = new Set([
  "pending",
  "in_progress",
  "blocked",
  "completed"
]);

/** Still outstanding work: not completed, not dismissed. The single gate for "does this belong in
 * an active/standalone task list" and "can the Execute Task control run on this." */
export function isTaskExecutable(task: Pick<MeetingTask, "status">) {
  return EXECUTABLE_TASK_STATUSES.has(task.status);
}

/** Committed work that should count toward a progress/workload total -- excludes only dismissed
 * (abandoned) work; completed work still counts toward both the numerator and denominator. */
export function isTaskCountedForProgress(task: Pick<MeetingTask, "status">) {
  return PROGRESS_COUNTED_TASK_STATUSES.has(task.status);
}

export function isIdeaOrRequirement(
  item: Pick<MeetingCommitment | MeetingTask, "execution_classification">
) {
  const classification = getExecutionClassification(item.execution_classification);
  return (
    classification === "proposed" ||
    classification === "requirement" ||
    classification === "future_consideration"
  );
}

export function partitionExecutionGraph(input: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  /** The meeting's current analysis generation (Meeting.execution_graph_generation). When
   * provided, active/execution buckets exclude rows stamped with an older generation -- pass
   * null/undefined to skip generation filtering entirely (e.g. when the caller aggregates rows
   * across meetings and applies its own per-meeting generation filter first). */
  currentGeneration?: number | null;
}) {
  const activeCommitments = input.commitments.filter(
    (commitment) =>
      isCommittedWork(commitment) && isCommitmentCurrentGeneration(commitment, input.currentGeneration)
  );
  const ideaCommitments = input.commitments.filter(isIdeaOrRequirement);

  // Dismissed tasks are excluded here so every consumer of executionTasks/linkedExecutionTasks/
  // standaloneTasks -- counts, progress, and rendered rows alike -- shares one definition of
  // "this is still part of the active execution graph." Completed work still counts (progress
  // needs it); only standaloneTasks narrows further to what Execute Task can actually act on.
  const executionTasks = input.tasks.filter(
    (task) =>
      isCommittedWork(task) &&
      isTaskCountedForProgress(task) &&
      isTaskCurrentGeneration(task, input.currentGeneration)
  );
  const ideaTasks = input.tasks.filter(isIdeaOrRequirement);

  const linkedExecutionTasks = executionTasks.filter((task) => task.commitment_id);
  const standaloneTasks = executionTasks.filter(
    (task) => !task.commitment_id && isTaskExecutable(task)
  );

  return {
    activeCommitments,
    ideaCommitments,
    executionTasks,
    ideaTasks,
    linkedExecutionTasks,
    standaloneTasks
  };
}

export function commitmentProgress(
  commitment: MeetingCommitment,
  tasks: MeetingTask[]
) {
  const linked = tasks.filter(
    (task) =>
      task.commitment_id === commitment.id && isCommittedWork(task) && isTaskCountedForProgress(task)
  );
  const completed = linked.filter((task) => task.status === "completed").length;
  const total = linked.length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, percent };
}

export function formatClassificationLabel(value: ExecutionClassification) {
  switch (value) {
    case "committed":
      return "Committed";
    case "proposed":
      return "Proposed";
    case "requirement":
      return "Requirement";
    case "future_consideration":
      return "Future";
  }
}
