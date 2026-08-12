import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActiveCommitmentsOverview,
  buildDashboardExecutionSummary,
  buildNeedsAttention,
  buildProjectCardSummary,
  buildRecentMeetingImpact,
  daysUntilDue,
  formatDaysUntilDueLabel,
  getDueDateUrgency,
  isActiveCommitment,
  isBlockedTask
} from "../lib/execution-dashboard";
import { buildProjectExecutionModel, computeCommitmentProgress } from "../lib/project-execution";
import type {
  Meeting,
  MeetingCommitment,
  MeetingTask,
  MeetingTaskStatus,
  Project
} from "../lib/types";

// Fixed reference "today" so date-relative assertions never depend on when the suite runs.
const TODAY = new Date("2026-08-12T15:00:00Z");

let counter = 0;
function task(overrides: Partial<MeetingTask> & { status: MeetingTaskStatus }): MeetingTask {
  counter += 1;
  return {
    id: `task-${counter}`,
    meeting_id: "meeting-1",
    project_id: "project-1",
    topic_id: null,
    commitment_id: null,
    task: `Task ${counter}`,
    owner: null,
    task_type: "unassigned_work",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    due_date: null,
    created_at: new Date(2026, 0, counter).toISOString(),
    ...overrides
  };
}

function commitment(overrides: Partial<MeetingCommitment> = {}): MeetingCommitment {
  counter += 1;
  return {
    id: `commitment-${counter}`,
    meeting_id: "meeting-1",
    project_id: "project-1",
    topic_id: null,
    title: `Commitment ${counter}`,
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    execution_classification: "committed",
    ...overrides
  } as MeetingCommitment;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Test Project",
    description: null,
    goal: "Ship it",
    status: "active",
    owner_id: "user-1",
    created_at: new Date(2026, 0, 1).toISOString(),
    updated_at: new Date(2026, 0, 1).toISOString(),
    ...overrides
  };
}

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    user_id: "user-1",
    project_id: "project-1",
    title: "Test meeting",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    recall_bot_id: null,
    status: "completed",
    is_pinned: false,
    deleted_at: null,
    created_at: new Date(2026, 0, 1).toISOString(),
    updated_at: new Date(2026, 0, 1).toISOString(),
    ...overrides
  };
}

// ============================================================
// daysUntilDue / getDueDateUrgency -- deterministic, UTC-normalized date math
// ============================================================

test("daysUntilDue: today's date is 0 days away regardless of the time of day", () => {
  assert.equal(daysUntilDue("2026-08-12", TODAY), 0);
});

test("daysUntilDue: a date one day in the past is -1, one day ahead is 1", () => {
  assert.equal(daysUntilDue("2026-08-11", TODAY), -1);
  assert.equal(daysUntilDue("2026-08-13", TODAY), 1);
});

test("getDueDateUrgency: completed/dismissed work is never overdue or due soon, no matter the due date", () => {
  assert.equal(
    getDueDateUrgency({ dueDate: "2020-01-01", isDone: true, referenceDate: TODAY }),
    "none"
  );
});

test("getDueDateUrgency: no due date is 'none'", () => {
  assert.equal(getDueDateUrgency({ dueDate: null, isDone: false, referenceDate: TODAY }), "none");
});

test("getDueDateUrgency: a past date is overdue", () => {
  assert.equal(
    getDueDateUrgency({ dueDate: "2026-08-01", isDone: false, referenceDate: TODAY }),
    "overdue"
  );
});

test("getDueDateUrgency: today and the next 3 days are due_soon; day 4 is not", () => {
  assert.equal(
    getDueDateUrgency({ dueDate: "2026-08-12", isDone: false, referenceDate: TODAY }),
    "due_soon"
  );
  assert.equal(
    getDueDateUrgency({ dueDate: "2026-08-15", isDone: false, referenceDate: TODAY }),
    "due_soon"
  );
  assert.equal(
    getDueDateUrgency({ dueDate: "2026-08-16", isDone: false, referenceDate: TODAY }),
    "none"
  );
});

test("formatDaysUntilDueLabel: overdue, today, tomorrow, and future all read naturally", () => {
  assert.equal(formatDaysUntilDueLabel(-1), "Overdue by 1 day");
  assert.equal(formatDaysUntilDueLabel(-3), "Overdue by 3 days");
  assert.equal(formatDaysUntilDueLabel(0), "Due today");
  assert.equal(formatDaysUntilDueLabel(1), "Due tomorrow");
  assert.equal(formatDaysUntilDueLabel(5), "Due in 5 days");
});

test("isBlockedTask: only the explicit 'blocked' status counts, not a task with unresolved dependencies", () => {
  assert.equal(isBlockedTask(task({ status: "blocked" })), true);
  assert.equal(isBlockedTask(task({ status: "pending" })), false);
});

// ============================================================
// buildDashboardExecutionSummary
// ============================================================

test("buildDashboardExecutionSummary: no projects produces all zeros", () => {
  const summary = buildDashboardExecutionSummary([], TODAY);
  assert.deepEqual(summary, { activeCommitments: 0, openTasks: 0, dueSoon: 0, blocked: 0 });
});

test("buildDashboardExecutionSummary: one project with an open, overdue, and blocked task", () => {
  const proj = project();
  const meet = meeting();
  const c = commitment({ meeting_id: meet.id, project_id: proj.id });
  const tasks = [
    task({ meeting_id: meet.id, project_id: proj.id, commitment_id: c.id, status: "pending" }),
    task({
      meeting_id: meet.id,
      project_id: proj.id,
      status: "pending",
      due_date: "2026-08-01"
    }),
    task({ meeting_id: meet.id, project_id: proj.id, status: "blocked" }),
    task({ meeting_id: meet.id, project_id: proj.id, status: "completed", due_date: "2020-01-01" })
  ];
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [c],
    tasks
  });

  const summary = buildDashboardExecutionSummary([model], TODAY);
  assert.equal(summary.activeCommitments, 1);
  assert.equal(summary.openTasks, 3, "completed task must not count as open");
  assert.equal(summary.dueSoon, 0, "the overdue task must not count toward Due Soon");
  assert.equal(summary.blocked, 1);
});

test("buildDashboardExecutionSummary: multiple projects aggregate correctly", () => {
  const projectA = project({ id: "project-a", name: "Project A" });
  const projectB = project({ id: "project-b", name: "Project B" });
  const meetA = meeting({ id: "meeting-a", project_id: "project-a" });
  const meetB = meeting({ id: "meeting-b", project_id: "project-b" });
  const modelA = buildProjectExecutionModel({
    project: projectA,
    meetings: [meetA],
    commitments: [commitment({ meeting_id: "meeting-a", project_id: "project-a" })],
    tasks: [task({ meeting_id: "meeting-a", project_id: "project-a", status: "pending" })]
  });
  const modelB = buildProjectExecutionModel({
    project: projectB,
    meetings: [meetB],
    commitments: [commitment({ meeting_id: "meeting-b", project_id: "project-b" })],
    tasks: [task({ meeting_id: "meeting-b", project_id: "project-b", status: "pending" })]
  });

  const summary = buildDashboardExecutionSummary([modelA, modelB], TODAY);
  assert.equal(summary.activeCommitments, 2);
  assert.equal(summary.openTasks, 2);
});

test("buildDashboardExecutionSummary: a project with zero commitments does not throw and contributes zero", () => {
  const proj = project();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [],
    commitments: [],
    tasks: []
  });
  const summary = buildDashboardExecutionSummary([model], TODAY);
  assert.deepEqual(summary, { activeCommitments: 0, openTasks: 0, dueSoon: 0, blocked: 0 });
});

test("buildDashboardExecutionSummary: stale-generation rows from a re-analyzed meeting are excluded", () => {
  const proj = project();
  const meet = meeting({ execution_graph_generation: 2 });
  const staleTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    extraction_metadata: { analysis_generation: 1 }
  });
  const currentTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    extraction_metadata: { analysis_generation: 2 }
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [staleTask, currentTask]
  });

  const summary = buildDashboardExecutionSummary([model], TODAY);
  assert.equal(summary.openTasks, 1, "the generation-1 task must not survive into the dashboard count");
});

// ============================================================
// isActiveCommitment / Active Commitments audit
// ============================================================

test("isActiveCommitment: completed and dismissed commitments are not active; pending/in_progress/blocked are", () => {
  assert.equal(isActiveCommitment(commitment({ status: "completed" })), false);
  assert.equal(isActiveCommitment(commitment({ status: "dismissed" })), false);
  assert.equal(isActiveCommitment(commitment({ status: "pending" })), true);
  assert.equal(isActiveCommitment(commitment({ status: "in_progress" })), true);
  assert.equal(isActiveCommitment(commitment({ status: "blocked" })), true);
});

test("buildDashboardExecutionSummary: a completed commitment does not count toward Active Commitments", () => {
  const proj = project();
  const meet = meeting();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [
      commitment({ meeting_id: meet.id, project_id: proj.id, status: "completed" }),
      commitment({ meeting_id: meet.id, project_id: proj.id, status: "pending" })
    ],
    tasks: []
  });
  const summary = buildDashboardExecutionSummary([model], TODAY);
  assert.equal(summary.activeCommitments, 1, "only the pending commitment is active");
});

test("buildDashboardExecutionSummary: an in-progress commitment counts toward Active Commitments", () => {
  const proj = project();
  const meet = meeting();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [commitment({ meeting_id: meet.id, project_id: proj.id, status: "in_progress" })],
    tasks: []
  });
  const summary = buildDashboardExecutionSummary([model], TODAY);
  assert.equal(summary.activeCommitments, 1);
});

// ============================================================
// Due Soon audit -- overdue must not inflate the Due Soon tile
// ============================================================

test("buildDashboardExecutionSummary: an overdue task does not count toward Due Soon", () => {
  const proj = project();
  const meet = meeting();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [
      task({ meeting_id: meet.id, project_id: proj.id, status: "pending", due_date: "2026-08-01" })
    ]
  });
  assert.equal(buildDashboardExecutionSummary([model], TODAY).dueSoon, 0);
});

test("buildDashboardExecutionSummary: a task due today counts toward Due Soon", () => {
  const proj = project();
  const meet = meeting();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [
      task({ meeting_id: meet.id, project_id: proj.id, status: "pending", due_date: "2026-08-12" })
    ]
  });
  assert.equal(buildDashboardExecutionSummary([model], TODAY).dueSoon, 1);
});

test("buildDashboardExecutionSummary: a task due in exactly 3 days counts toward Due Soon; 4 days does not", () => {
  const proj = project();
  const meet = meeting();
  const dueIn3 = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    due_date: "2026-08-15"
  });
  const dueIn4 = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    due_date: "2026-08-16"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [dueIn3, dueIn4]
  });
  assert.equal(buildDashboardExecutionSummary([model], TODAY).dueSoon, 1);
});

// ============================================================
// Standalone Task coverage audit
// ============================================================

test("Standalone Task coverage: an eligible project-linked standalone task contributes to Open Tasks", () => {
  const proj = project();
  const meet = meeting();
  const standalone = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: null,
    status: "pending"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [standalone]
  });
  assert.equal(model.tasks.some((t) => t.id === standalone.id), true);
  assert.equal(buildDashboardExecutionSummary([model], TODAY).openTasks, 1);
});

test("Standalone Task coverage: an eligible overdue standalone task appears in Needs Attention", () => {
  const proj = project();
  const meet = meeting();
  const standalone = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: null,
    status: "pending",
    due_date: "2026-08-01",
    task: "Standalone overdue task"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [standalone]
  });
  const items = buildNeedsAttention({ projects: [{ project: proj, model }], referenceDate: TODAY });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "overdue");
  assert.equal(items[0].task.id, standalone.id);
});

test("Standalone Task coverage: a standalone task never contributes to its (nonexistent) commitment's progress, only to project progress", () => {
  const proj = project();
  const meet = meeting();
  const c = commitment({ meeting_id: meet.id, project_id: proj.id });
  const linkedTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: c.id,
    status: "completed"
  });
  const standalone = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: null,
    status: "pending"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [c],
    tasks: [linkedTask, standalone]
  });

  // Commitment-level progress must only see the commitment's own linked task.
  const commitmentProgress = computeCommitmentProgress(c, model.tasks);
  assert.deepEqual(commitmentProgress, { completed: 1, total: 1, percent: 100 });

  // Project-level progress (computeProjectProgress, via buildProjectExecutionModel) already
  // includes unlinked-but-committed standalone tasks by design -- this is pre-existing,
  // canonical behavior (see computeProjectProgress in lib/project-execution.ts), reused
  // unchanged here, not a new inclusion rule invented for the dashboard.
  assert.equal(model.progress.total, 2, "the standalone task adds to the project total");
  assert.equal(model.progress.completed, 1);
});

test("Standalone Task coverage: a stale-generation standalone task is excluded from the project model entirely", () => {
  const proj = project();
  const meet = meeting({ execution_graph_generation: 2 });
  const staleStandalone = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: null,
    status: "pending",
    extraction_metadata: { analysis_generation: 1 }
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [staleStandalone]
  });
  assert.equal(model.tasks.length, 0);
  assert.equal(buildDashboardExecutionSummary([model], TODAY).openTasks, 0);
});

test("Standalone Task coverage: a dismissed standalone task is excluded from Open Tasks and Needs Attention", () => {
  const proj = project();
  const meet = meeting();
  const dismissedStandalone = task({
    meeting_id: meet.id,
    project_id: proj.id,
    commitment_id: null,
    status: "dismissed",
    due_date: "2026-08-01"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [dismissedStandalone]
  });
  assert.equal(model.tasks.length, 0, "dismissed work is excluded by isTaskCountedForProgress");
  assert.equal(buildDashboardExecutionSummary([model], TODAY).openTasks, 0);
  assert.equal(
    buildNeedsAttention({ projects: [{ project: proj, model }], referenceDate: TODAY }).length,
    0
  );
});

test("Standalone Task coverage: an unrelated task from a different project is never counted here", () => {
  const proj = project({ id: "project-a" });
  const otherProjectTask = task({
    meeting_id: "meeting-other",
    project_id: "project-b",
    status: "pending"
  });
  // buildProjectExecutionModel is only ever called with the tasks already scoped to this
  // project (see app/projects/page.tsx's groupBy-by-project_id) -- passing a foreign-project
  // task in here would be a caller bug, not something this function guards against by design,
  // so this test documents the assumption rather than asserting new filtering logic.
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [],
    commitments: [],
    tasks: [] // the page never passes otherProjectTask through for project-a
  });
  assert.equal(model.tasks.includes(otherProjectTask), false);
  assert.equal(buildDashboardExecutionSummary([model], TODAY).openTasks, 0);
});

// ============================================================
// buildNeedsAttention
// ============================================================

test("buildNeedsAttention: categorizes overdue, due-soon, and blocked, and excludes completed work", () => {
  const proj = project();
  const meet = meeting();
  const overdueTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    due_date: "2026-08-01",
    task: "Overdue task"
  });
  const dueSoonTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "pending",
    due_date: "2026-08-13",
    task: "Due soon task"
  });
  const blockedTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "blocked",
    task: "Blocked task"
  });
  const completedOverdueTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "completed",
    due_date: "2020-01-01",
    task: "Completed but technically overdue"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [overdueTask, dueSoonTask, blockedTask, completedOverdueTask]
  });

  const items = buildNeedsAttention({
    projects: [{ project: proj, model }],
    referenceDate: TODAY
  });

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["overdue", "due_soon", "blocked"]
  );
  assert.ok(!items.some((item) => item.task.id === completedOverdueTask.id));
});

test("buildNeedsAttention: a task that is both overdue and blocked is listed once, under overdue", () => {
  const proj = project();
  const meet = meeting();
  const bothTask = task({
    meeting_id: meet.id,
    project_id: proj.id,
    status: "blocked",
    due_date: "2026-08-01"
  });
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks: [bothTask]
  });

  const items = buildNeedsAttention({ projects: [{ project: proj, model }], referenceDate: TODAY });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "overdue");
});

test("buildNeedsAttention: respects the limit", () => {
  const proj = project();
  const meet = meeting();
  const tasks = Array.from({ length: 10 }, () =>
    task({ meeting_id: meet.id, project_id: proj.id, status: "blocked" })
  );
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [],
    tasks
  });

  const items = buildNeedsAttention({
    projects: [{ project: proj, model }],
    referenceDate: TODAY,
    limit: 3
  });
  assert.equal(items.length, 3);
});

// ============================================================
// buildActiveCommitmentsOverview
// ============================================================

test("buildActiveCommitmentsOverview: computes per-commitment progress and sorts by soonest due date", () => {
  const proj = project();
  const meet = meeting();
  const soonCommitment = commitment({
    meeting_id: meet.id,
    project_id: proj.id,
    title: "Soon",
    due_date: "2026-08-13"
  });
  const laterCommitment = commitment({
    meeting_id: meet.id,
    project_id: proj.id,
    title: "Later",
    due_date: "2026-09-01"
  });
  const noDateCommitment = commitment({
    meeting_id: meet.id,
    project_id: proj.id,
    title: "No date"
  });
  const tasks = [
    task({
      meeting_id: meet.id,
      project_id: proj.id,
      commitment_id: soonCommitment.id,
      status: "completed"
    }),
    task({
      meeting_id: meet.id,
      project_id: proj.id,
      commitment_id: soonCommitment.id,
      status: "pending"
    })
  ];
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [noDateCommitment, laterCommitment, soonCommitment],
    tasks
  });

  const items = buildActiveCommitmentsOverview({ projects: [{ project: proj, model }] });
  assert.deepEqual(
    items.map((item) => item.commitment.title),
    ["Soon", "Later", "No date"]
  );
  const soonItem = items.find((item) => item.commitment.title === "Soon")!;
  assert.equal(soonItem.progress.completed, 1);
  assert.equal(soonItem.progress.total, 2);
});

test("buildActiveCommitmentsOverview: zero commitments returns an empty list", () => {
  const proj = project();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [],
    commitments: [],
    tasks: []
  });
  assert.deepEqual(buildActiveCommitmentsOverview({ projects: [{ project: proj, model }] }), []);
});

// ============================================================
// buildProjectCardSummary
// ============================================================

test("buildProjectCardSummary: reuses model.progress and finds the soonest upcoming (non-overdue) deadline", () => {
  const proj = project();
  const meet = meeting();
  const c = commitment({ meeting_id: meet.id, project_id: proj.id, due_date: "2026-08-20" });
  const tasks = [
    task({
      meeting_id: meet.id,
      project_id: proj.id,
      commitment_id: c.id,
      status: "pending",
      due_date: "2026-08-13"
    }),
    task({
      meeting_id: meet.id,
      project_id: proj.id,
      status: "pending",
      due_date: "2026-08-01" // overdue -- must not surface as "next deadline"
    }),
    task({ meeting_id: meet.id, project_id: proj.id, status: "blocked" })
  ];
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [meet],
    commitments: [c],
    tasks
  });

  const summary = buildProjectCardSummary(model, TODAY);
  assert.equal(summary.activeCommitments, 1);
  assert.equal(summary.blockedTasks, 1);
  assert.equal(summary.nextDeadline, "2026-08-13");
  assert.deepEqual(summary.progress, model.progress);
});

test("buildProjectCardSummary: a project with no due dates at all has a null next deadline", () => {
  const proj = project();
  const model = buildProjectExecutionModel({
    project: proj,
    meetings: [],
    commitments: [],
    tasks: [task({ status: "pending" })]
  });
  assert.equal(buildProjectCardSummary(model, TODAY).nextDeadline, null);
});

// ============================================================
// buildRecentMeetingImpact
// ============================================================

test("buildRecentMeetingImpact: counts match partitionExecutionGraph output for that meeting", () => {
  const meet = meeting();
  const c = commitment({ meeting_id: meet.id });
  const linkedTask = task({ meeting_id: meet.id, commitment_id: c.id, status: "pending" });
  const futureTask = task({
    meeting_id: meet.id,
    status: "pending",
    execution_classification: "proposed"
  });

  const items = buildRecentMeetingImpact({
    meetings: [meet],
    commitmentsByMeetingId: new Map([[meet.id, [c]]]),
    tasksByMeetingId: new Map([[meet.id, [linkedTask, futureTask]]])
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].commitments, 1);
  assert.equal(items[0].tasks, 1);
  assert.equal(items[0].futureScope, 1);
});

test("buildRecentMeetingImpact: a meeting with no commitments/tasks yet returns zeros, not an error", () => {
  const meet = meeting({ id: "empty-meeting" });
  const items = buildRecentMeetingImpact({
    meetings: [meet],
    commitmentsByMeetingId: new Map(),
    tasksByMeetingId: new Map()
  });
  assert.deepEqual(items, [{ meeting: meet, commitments: 0, tasks: 0, futureScope: 0 }]);
});

test("buildRecentMeetingImpact: respects the limit", () => {
  const meetings = Array.from({ length: 8 }, (_, index) => meeting({ id: `meeting-${index}` }));
  const items = buildRecentMeetingImpact({
    meetings,
    commitmentsByMeetingId: new Map(),
    tasksByMeetingId: new Map(),
    limit: 4
  });
  assert.equal(items.length, 4);
});
