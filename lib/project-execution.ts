import { isCommittedWork, isTaskCountedForProgress } from "@/lib/execution-display";
import { isCommitmentCurrentGeneration, isTaskCurrentGeneration } from "@/lib/execution-generation";
import type {
  CommitmentParticipant,
  Meeting,
  MeetingCommitment,
  MeetingTask,
  Project,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

export type ExecutionProgress = {
  completed: number;
  total: number;
  percent: number;
};

export type RankedTask = {
  task: MeetingTask;
  score: number;
  blockedBy: string[];
  reasons: string[];
};

export type CommitmentWorkspaceModel = {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  dependencies: TaskDependency[];
  artifacts: TaskArtifact[];
  evidenceSegmentIds: string[];
  progress: ExecutionProgress;
  nextBestTask: RankedTask | null;
  taskGroups: OwnerTaskGroup[];
  people: string[];
};

export type OwnerTaskGroup = {
  owner: string | null;
  tasks: MeetingTask[];
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function percent(completed: number, total: number) {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

export function computeCommitmentProgress(
  commitment: MeetingCommitment,
  tasks: MeetingTask[]
): ExecutionProgress {
  const children = tasks.filter(
    (task) =>
      task.commitment_id === commitment.id && isCommittedWork(task) && isTaskCountedForProgress(task)
  );
  if (children.length === 0) {
    const completed = commitment.status === "completed" ? 1 : 0;
    return { completed, total: 1, percent: completed * 100 };
  }
  const completed = children.filter((task) => task.status === "completed").length;
  return {
    completed,
    total: children.length,
    percent: percent(completed, children.length)
  };
}

export function computeProjectProgress(input: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}): ExecutionProgress {
  const commitments = input.commitments.filter(
    (commitment) => !commitment.converted_to_task_id && isCommittedWork(commitment)
  );
  const linkedTaskIds = new Set<string>();
  let completed = 0;
  let total = 0;

  for (const commitment of commitments) {
    const children = input.tasks.filter(
      (task) =>
        task.commitment_id === commitment.id &&
        isCommittedWork(task) &&
        isTaskCountedForProgress(task)
    );
    if (children.length === 0) {
      total += 1;
      completed += Number(commitment.status === "completed");
      continue;
    }
    for (const task of children) {
      linkedTaskIds.add(task.id);
      total += 1;
      completed += Number(task.status === "completed");
    }
  }

  for (const task of input.tasks) {
    if (
      !linkedTaskIds.has(task.id) &&
      !task.commitment_id &&
      isCommittedWork(task) &&
      isTaskCountedForProgress(task)
    ) {
      total += 1;
      completed += Number(task.status === "completed");
    }
  }

  return { completed, total, percent: percent(completed, total) };
}

function ownerMatches(task: MeetingTask, currentUserName?: string | null) {
  if (!currentUserName) return false;
  const expected = currentUserName.trim().toLowerCase();
  return [task.owner, ...stringArray(task.owners)].some(
    (owner) => owner?.trim().toLowerCase() === expected
  );
}

function dueDateScore(dueDate: string | null | undefined, today: Date) {
  if (!dueDate) return { score: 0, reason: null as string | null };
  const due = new Date(`${dueDate}T00:00:00Z`);
  const day = 86_400_000;
  const days = Math.ceil((due.getTime() - today.getTime()) / day);
  if (days < 0) return { score: 90, reason: "overdue" };
  if (days === 0) return { score: 80, reason: "due today" };
  if (days <= 3) return { score: 65 - days, reason: `due in ${days} days` };
  if (days <= 14) return { score: 35 - days, reason: `due in ${days} days` };
  return { score: 5, reason: null };
}

export function rankNextBestTasks(input: {
  tasks: MeetingTask[];
  dependencies?: TaskDependency[];
  commitments?: MeetingCommitment[];
  currentUserName?: string | null;
  today?: Date;
}): RankedTask[] {
  const dependencies = input.dependencies ?? [];
  const commitments = new Map(
    (input.commitments ?? []).map((commitment) => [commitment.id, commitment])
  );
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const today = input.today ?? new Date();
  const priorityScore = { high: 70, medium: 40, low: 10 };

  return input.tasks
    .flatMap((task): RankedTask[] => {
      if (
        !isCommittedWork(task) ||
        task.status === "completed" ||
        task.status === "dismissed" ||
        task.status === "blocked"
      ) {
        return [];
      }
      const parent = task.commitment_id
        ? commitments.get(task.commitment_id)
        : null;
      if (
        parent &&
        (parent.status === "blocked" ||
          parent.status === "dismissed" ||
          parent.status === "completed")
      ) {
        return [];
      }

      const blockedBy = dependencies
        .filter((dependency) => dependency.task_id === task.id)
        .map((dependency) => tasks.get(dependency.depends_on_task_id))
        .filter(
          (prerequisite): prerequisite is MeetingTask =>
            prerequisite !== undefined && prerequisite.status !== "completed"
        )
        .map((prerequisite) => prerequisite.id);
      if (blockedBy.length > 0) return [];

      const due = dueDateScore(task.due_date, today);
      const reasons = [task.status === "in_progress" ? "already in progress" : null];
      if (task.priority === "high") reasons.push("high priority");
      if (due.reason) reasons.push(due.reason);
      if (ownerMatches(task, input.currentUserName)) reasons.push("owned by you");
      if (!task.owner && stringArray(task.owners).length === 0) {
        reasons.push("unassigned");
      }

      const score =
        Number(task.status === "in_progress") * 100 +
        priorityScore[task.priority] +
        due.score +
        Number(ownerMatches(task, input.currentUserName)) * 20 +
        Number(Boolean(task.owner || stringArray(task.owners).length)) * 5 -
        Number(task.inferred) * 5;
      return [
        {
          task,
          score,
          blockedBy,
          reasons: reasons.filter((reason): reason is string => Boolean(reason))
        }
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.task.position ?? 0) - (right.task.position ?? 0) ||
        left.task.created_at.localeCompare(right.task.created_at) ||
        left.task.id.localeCompare(right.task.id)
    );
}

export function selectNextBestTask(
  input: Parameters<typeof rankNextBestTasks>[0]
) {
  return rankNextBestTasks(input)[0] ?? null;
}

export function collectProjectPeople(
  commitments: MeetingCommitment[],
  tasks: MeetingTask[]
) {
  const people = new Map<string, string>();
  for (const item of [...commitments, ...tasks]) {
    for (const owner of [item.owner, ...stringArray(item.owners)]) {
      const trimmed = owner?.trim();
      if (trimmed) people.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return Array.from(people.values()).sort((left, right) =>
    left.localeCompare(right)
  );
}

export function groupCommitmentTasksByOwner(tasks: MeetingTask[]): OwnerTaskGroup[] {
  const groups = new Map<string, OwnerTaskGroup>();
  for (const task of tasks) {
    const owner = task.owner?.trim() || stringArray(task.owners)[0]?.trim() || null;
    const key = owner?.toLowerCase() ?? "__unassigned__";
    const group = groups.get(key) ?? { owner, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((left, right) => {
    if (left.owner === null) return 1;
    if (right.owner === null) return -1;
    return left.owner.localeCompare(right.owner);
  });
}

export function deriveCommitmentPeople(input: {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  participants?: CommitmentParticipant[];
}) {
  const people = new Map<string, string>();
  const add = (value?: string | null) => {
    const name = value?.trim();
    if (name) people.set(name.toLowerCase(), name);
  };
  add(input.commitment.lead_owner_name ?? input.commitment.owner);
  for (const owner of stringArray(input.commitment.owners)) add(owner);
  for (const task of input.tasks) {
    add(task.owner);
    for (const owner of stringArray(task.owners)) add(owner);
  }
  for (const participant of input.participants ?? []) add(participant.participant_name);
  return Array.from(people.values()).sort((left, right) =>
    left.localeCompare(right)
  );
}

export function buildCommitmentWorkspaceModel(input: {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  dependencies?: TaskDependency[];
  artifacts?: TaskArtifact[];
  participants?: CommitmentParticipant[];
  currentUserName?: string | null;
}): CommitmentWorkspaceModel {
  const tasks = input.tasks
    .filter((task) => task.commitment_id === input.commitment.id && isTaskCountedForProgress(task))
    .sort(
      (left, right) =>
        (left.position ?? 0) - (right.position ?? 0) ||
        left.created_at.localeCompare(right.created_at)
    );
  const taskIds = new Set(tasks.map((task) => task.id));
  const dependencies = (input.dependencies ?? []).filter(
    (dependency) =>
      taskIds.has(dependency.task_id) &&
      taskIds.has(dependency.depends_on_task_id)
  );
  const artifacts = (input.artifacts ?? []).filter((artifact) =>
    taskIds.has(artifact.task_id)
  );
  const evidenceSegmentIds = Array.from(
    new Set([
      ...stringArray(input.commitment.source_segment_ids),
      ...tasks.flatMap((task) => stringArray(task.source_segment_ids))
    ])
  );

  return {
    commitment: input.commitment,
    tasks,
    dependencies,
    artifacts,
    evidenceSegmentIds,
    progress: computeCommitmentProgress(input.commitment, tasks),
    taskGroups: groupCommitmentTasksByOwner(tasks),
    people: deriveCommitmentPeople({
      commitment: input.commitment,
      tasks,
      participants: input.participants
    }),
    nextBestTask: selectNextBestTask({
      tasks,
      dependencies,
      commitments: [input.commitment],
      currentUserName: input.currentUserName
    })
  };
}

export type ProjectExecutionModel = {
  project: Project;
  meetings: Meeting[];
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  progress: ExecutionProgress;
  people: string[];
  nextBestTask: RankedTask | null;
};

export function buildProjectExecutionModel(input: {
  project: Project;
  meetings: Meeting[];
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  dependencies?: TaskDependency[];
  currentUserName?: string | null;
}): ProjectExecutionModel {
  // A project aggregates commitments/tasks from multiple meetings, each with its own current
  // generation -- look each row's generation currency up against its own meeting so a stale
  // generation from one meeting can't leak into the project view alongside a newer one.
  const currentGenerationByMeetingId = new Map(
    input.meetings.map((meeting) => [meeting.id, meeting.execution_graph_generation ?? null])
  );
  const commitments = input.commitments.filter(
    (commitment) =>
      !commitment.converted_to_task_id &&
      isCommittedWork(commitment) &&
      isCommitmentCurrentGeneration(
        commitment,
        currentGenerationByMeetingId.get(commitment.meeting_id) ?? null
      )
  );
  const tasks = input.tasks.filter(
    (task) =>
      isCommittedWork(task) &&
      isTaskCountedForProgress(task) &&
      isTaskCurrentGeneration(task, currentGenerationByMeetingId.get(task.meeting_id) ?? null)
  );
  return {
    project: input.project,
    meetings: input.meetings,
    commitments,
    tasks,
    progress: computeProjectProgress({ commitments, tasks }),
    people: collectProjectPeople(commitments, tasks),
    nextBestTask: selectNextBestTask({
      tasks,
      dependencies: input.dependencies,
      commitments,
      currentUserName: input.currentUserName
    })
  };
}
