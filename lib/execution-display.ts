import type {
  ExecutionClassification,
  MeetingCommitment,
  MeetingTask
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
}) {
  const activeCommitments = input.commitments.filter(isCommittedWork);
  const ideaCommitments = input.commitments.filter(isIdeaOrRequirement);

  const executionTasks = input.tasks.filter(isCommittedWork);
  const ideaTasks = input.tasks.filter(isIdeaOrRequirement);

  const linkedExecutionTasks = executionTasks.filter((task) => task.commitment_id);
  const standaloneTasks = executionTasks.filter((task) => !task.commitment_id);

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
    (task) => task.commitment_id === commitment.id && isCommittedWork(task)
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
