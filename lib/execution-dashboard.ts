import {
  computeCommitmentProgress,
  type ExecutionProgress,
  type ProjectExecutionModel
} from "@/lib/project-execution";
import { partitionExecutionGraph } from "@/lib/execution-display";
import { getEffectiveDisplayGeneration } from "@/lib/execution-generation";
import type { Meeting, MeetingCommitment, MeetingTask, Project } from "@/lib/types";

const DAY_MS = 86_400_000;
/** Today through 3 days out counts as "due soon" -- the same near-term window
 * rankNextBestTasks already treats as urgent (see dueDateScore in project-execution.ts). */
const DUE_SOON_WINDOW_DAYS = 3;
/** Cross-project lists on the dashboard are summaries, not full listings -- each has its own
 * default cap so no single section can dominate the page. */
const DEFAULT_NEEDS_ATTENTION_LIMIT = 6;
const DEFAULT_ACTIVE_COMMITMENTS_LIMIT = 6;
const DEFAULT_RECENT_MEETINGS_LIMIT = 5;

/** due_date is stored as a plain "YYYY-MM-DD" string (see the zod validation on the tasks/
 * commitments PATCH routes). Parsed as UTC midnight, and compared against a UTC-midnight
 * "today", so this never depends on the server's local timezone or the time of day the page
 * happens to render. */
function parseDueDateUtc(dueDate: string): number {
  const [year, month, day] = dueDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function todayUtcMidnight(referenceDate: Date): number {
  return Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
}

export function daysUntilDue(dueDate: string, referenceDate: Date = new Date()): number {
  return Math.round((parseDueDateUtc(dueDate) - todayUtcMidnight(referenceDate)) / DAY_MS);
}

/** Human-readable relative label for a day offset from daysUntilDue -- shared so "Needs
 * Attention" and any other due-date list phrase things the same way. */
export function formatDaysUntilDueLabel(days: number): string {
  if (days < 0) {
    const overdueBy = Math.abs(days);
    return `Overdue by ${overdueBy} day${overdueBy === 1 ? "" : "s"}`;
  }
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

export type DueDateUrgency = "overdue" | "due_soon" | "none";

/** isDone must be true for completed (or dismissed) work -- finished work is never overdue or
 * due soon, regardless of what its stored due date says. */
export function getDueDateUrgency(input: {
  dueDate: string | null | undefined;
  isDone: boolean;
  referenceDate?: Date;
}): DueDateUrgency {
  if (input.isDone || !input.dueDate) return "none";
  const days = daysUntilDue(input.dueDate, input.referenceDate ?? new Date());
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "none";
}

/** The one reliable "blocked" signal in the product today: the explicit Blocked task status.
 * Deliberately does not infer blocking from unresolved dependencies -- that is a different,
 * unconfirmed signal (see Phase 5 blocker-logic constraints). */
export function isBlockedTask(task: Pick<MeetingTask, "status">): boolean {
  return task.status === "blocked";
}

/** "Active" for a dashboard metric/list literally labeled "Active Commitments" means still-open
 * committed work: not completed, not dismissed. This is deliberately narrower than
 * model.commitments itself -- buildProjectExecutionModel/computeProjectProgress intentionally
 * keep completed (and even dismissed, via isCommittedWork alone) commitments in their own
 * outputs because progress math needs completed rows to compute a percentage, and other
 * consumers may legitimately want the full set. Filtering happens only here, at the
 * dashboard-labeling layer, so buildProjectExecutionModel and progress semantics are untouched. */
export function isActiveCommitment(commitment: Pick<MeetingCommitment, "status">): boolean {
  return commitment.status !== "completed" && commitment.status !== "dismissed";
}

export type DashboardExecutionSummary = {
  activeCommitments: number;
  openTasks: number;
  dueSoon: number;
  blocked: number;
};

/** Each model must already come from buildProjectExecutionModel (or equivalent), so
 * generation-currency and committed-work filtering are already applied -- this function only
 * aggregates, it never re-derives what counts as active execution work.
 *
 * model.tasks already includes project-linked Standalone Tasks alongside commitment-linked
 * tasks -- buildProjectExecutionModel's task filter (committed + counted-for-progress +
 * current-generation) never checks commitment_id, so no extra handling is needed here to
 * include them in Open Tasks / Due Soon / Blocked.
 *
 * Due Soon counts only urgency === "due_soon" (today through the near-term window) -- overdue
 * work is deliberately excluded from this tile so the label matches what it counts; overdue
 * items remain visible through Needs Attention. */
export function buildDashboardExecutionSummary(
  models: ProjectExecutionModel[],
  referenceDate: Date = new Date()
): DashboardExecutionSummary {
  let activeCommitments = 0;
  let openTasks = 0;
  let dueSoon = 0;
  let blocked = 0;

  for (const model of models) {
    activeCommitments += model.commitments.filter(isActiveCommitment).length;
    for (const task of model.tasks) {
      const isDone = task.status === "completed";
      if (!isDone) openTasks += 1;
      if (isBlockedTask(task)) blocked += 1;

      const urgency = getDueDateUrgency({
        dueDate: task.due_date ?? null,
        isDone,
        referenceDate
      });
      if (urgency === "due_soon") dueSoon += 1;
    }
  }

  return { activeCommitments, openTasks, dueSoon, blocked };
}

export type NeedsAttentionItem = {
  kind: "overdue" | "due_soon" | "blocked";
  task: MeetingTask;
  projectId: string;
  projectName: string;
};

/** A task that is both overdue/due-soon and blocked is reported once, under the date bucket --
 * date urgency is the more actionable signal, and double-listing the same task would inflate
 * "Needs Attention" without adding information. */
export function buildNeedsAttention(input: {
  projects: Array<{ project: Pick<Project, "id" | "name">; model: ProjectExecutionModel }>;
  referenceDate?: Date;
  limit?: number;
}): NeedsAttentionItem[] {
  const referenceDate = input.referenceDate ?? new Date();
  const items: NeedsAttentionItem[] = [];

  for (const { project, model } of input.projects) {
    for (const task of model.tasks) {
      const isDone = task.status === "completed";
      if (isDone) continue;

      const urgency = getDueDateUrgency({ dueDate: task.due_date ?? null, isDone, referenceDate });
      if (urgency === "overdue") {
        items.push({ kind: "overdue", task, projectId: project.id, projectName: project.name });
      } else if (urgency === "due_soon") {
        items.push({ kind: "due_soon", task, projectId: project.id, projectName: project.name });
      } else if (isBlockedTask(task)) {
        items.push({ kind: "blocked", task, projectId: project.id, projectName: project.name });
      }
    }
  }

  const kindOrder: Record<NeedsAttentionItem["kind"], number> = {
    overdue: 0,
    due_soon: 1,
    blocked: 2
  };
  items.sort((a, b) => {
    const kindDelta = kindOrder[a.kind] - kindOrder[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const aDate = a.task.due_date ?? "";
    const bDate = b.task.due_date ?? "";
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    return a.task.task.localeCompare(b.task.task);
  });

  return items.slice(0, input.limit ?? DEFAULT_NEEDS_ATTENTION_LIMIT);
}

export type ActiveCommitmentOverviewItem = {
  commitment: MeetingCommitment;
  progress: ExecutionProgress;
  projectId: string;
  projectName: string;
};

export function buildActiveCommitmentsOverview(input: {
  projects: Array<{ project: Pick<Project, "id" | "name">; model: ProjectExecutionModel }>;
  limit?: number;
}): ActiveCommitmentOverviewItem[] {
  const items: ActiveCommitmentOverviewItem[] = [];
  for (const { project, model } of input.projects) {
    for (const commitment of model.commitments.filter(isActiveCommitment)) {
      items.push({
        commitment,
        progress: computeCommitmentProgress(commitment, model.tasks),
        projectId: project.id,
        projectName: project.name
      });
    }
  }

  items.sort((a, b) => {
    const aDate = a.commitment.due_date ?? "";
    const bDate = b.commitment.due_date ?? "";
    if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate);
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return a.commitment.title.localeCompare(b.commitment.title);
  });

  return items.slice(0, input.limit ?? DEFAULT_ACTIVE_COMMITMENTS_LIMIT);
}

export type ProjectCardSummary = {
  activeCommitments: number;
  openTasks: number;
  blockedTasks: number;
  progress: ExecutionProgress;
  /** Soonest upcoming (today or later) due date across this project's active commitments and
   * open tasks. Overdue dates are intentionally excluded here -- those are surfaced through
   * Needs Attention instead, so a card never has to label a past date as "next deadline". */
  nextDeadline: string | null;
};

export function buildProjectCardSummary(
  model: ProjectExecutionModel,
  referenceDate: Date = new Date()
): ProjectCardSummary {
  const activeCommitments = model.commitments.filter(isActiveCommitment);
  const openTasks = model.tasks.filter((task) => task.status !== "completed").length;
  const blockedTasks = model.tasks.filter(isBlockedTask).length;

  const upcomingDueDates: string[] = [];
  for (const commitment of activeCommitments) {
    if (commitment.due_date && daysUntilDue(commitment.due_date, referenceDate) >= 0) {
      upcomingDueDates.push(commitment.due_date);
    }
  }
  for (const task of model.tasks) {
    if (
      task.status !== "completed" &&
      task.due_date &&
      daysUntilDue(task.due_date, referenceDate) >= 0
    ) {
      upcomingDueDates.push(task.due_date);
    }
  }
  upcomingDueDates.sort();

  return {
    activeCommitments: activeCommitments.length,
    openTasks,
    blockedTasks,
    progress: model.progress,
    nextDeadline: upcomingDueDates[0] ?? null
  };
}

export type RecentMeetingImpact = {
  meeting: Meeting;
  commitments: number;
  tasks: number;
  futureScope: number;
};

/** Reuses partitionExecutionGraph -- the same function Meeting Detail (Phase 2) uses for its own
 * counts -- so a meeting's numbers here are always identical to what its own page shows. */
export function buildRecentMeetingImpact(input: {
  meetings: Meeting[];
  commitmentsByMeetingId: Map<string, MeetingCommitment[]>;
  tasksByMeetingId: Map<string, MeetingTask[]>;
  limit?: number;
}): RecentMeetingImpact[] {
  return input.meetings
    .slice(0, input.limit ?? DEFAULT_RECENT_MEETINGS_LIMIT)
    .map((meeting) => {
      const partitioned = partitionExecutionGraph({
        commitments: input.commitmentsByMeetingId.get(meeting.id) ?? [],
        tasks: input.tasksByMeetingId.get(meeting.id) ?? [],
        currentGeneration: getEffectiveDisplayGeneration(meeting)
      });
      return {
        meeting,
        commitments: partitioned.activeCommitments.length,
        tasks: partitioned.executionTasks.length,
        futureScope: partitioned.ideaCommitments.length + partitioned.ideaTasks.length
      };
    });
}
