import type { MeetingCommitment, MeetingTask } from "@/lib/types";

export function isInferredTask(task: Pick<MeetingTask, "inferred">) {
  return task.inferred === true;
}

export function buildCommitmentTitleMap(
  commitments: Array<Pick<MeetingCommitment, "id" | "title">>
) {
  return new Map(commitments.map((commitment) => [commitment.id, commitment.title]));
}

export function getCommitmentTitleForTask(
  task: Pick<MeetingTask, "commitment_id">,
  titles: Map<string, string>
) {
  return task.commitment_id ? titles.get(task.commitment_id) ?? null : null;
}
