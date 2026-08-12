import assert from "node:assert/strict";
import test from "node:test";

import {
  isTaskCountedForProgress,
  isTaskExecutable,
  partitionExecutionGraph
} from "../lib/execution-display";
import {
  buildCommitmentWorkspaceModel,
  computeCommitmentProgress,
  computeProjectProgress
} from "../lib/project-execution";
import type { MeetingCommitment, MeetingTask, MeetingTaskStatus } from "../lib/types";

let counter = 0;
function task(overrides: Partial<MeetingTask> & { status: MeetingTaskStatus }): MeetingTask {
  counter += 1;
  return {
    id: `task-${counter}`,
    meeting_id: "meeting-1",
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
    created_at: new Date(2026, 0, counter).toISOString(),
    ...overrides
  };
}

function commitment(overrides: Partial<MeetingCommitment> = {}): MeetingCommitment {
  return {
    id: "commitment-1",
    meeting_id: "meeting-1",
    topic_id: null,
    title: "Deliver the first website draft",
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

// ============================================================
// isTaskExecutable / isTaskCountedForProgress -- the shared predicates every UI surface and
// count now goes through.
// ============================================================

test("10/12. isTaskExecutable is false for a dismissed task -- excluded from active rows and Execute Task", () => {
  const dismissed = task({ status: "dismissed" });
  assert.equal(isTaskExecutable(dismissed), false);
});

test("13. isTaskExecutable is true for a pending task -- still renders and remains executable", () => {
  const pending = task({ status: "pending" });
  assert.equal(isTaskExecutable(pending), true);
});

test("14. isTaskExecutable is true for an in-progress task -- still renders and remains executable", () => {
  const inProgress = task({ status: "in_progress" });
  assert.equal(isTaskExecutable(inProgress), true);
});

test("isTaskExecutable is true for a blocked task (part of the active allowlist)", () => {
  const blocked = task({ status: "blocked" });
  assert.equal(isTaskExecutable(blocked), true);
});

test("15. isTaskExecutable is false for a completed task -- already done, no Execute Task control", () => {
  const completed = task({ status: "completed" });
  assert.equal(isTaskExecutable(completed), false);
});

test("a completed task still counts toward progress; a dismissed task never does", () => {
  assert.equal(isTaskCountedForProgress(task({ status: "completed" })), true);
  assert.equal(isTaskCountedForProgress(task({ status: "dismissed" })), false);
  assert.equal(isTaskCountedForProgress(task({ status: "pending" })), true);
});

// ============================================================
// partitionExecutionGraph -- the Standalone Tasks source of truth
// ============================================================

test("10/11. dismissed standalone tasks are excluded from active rows and from the active standalone count", () => {
  const dismissed1 = task({ status: "dismissed" });
  const dismissed2 = task({ status: "dismissed" });
  const pending = task({ status: "pending" });
  const result = partitionExecutionGraph({ commitments: [], tasks: [dismissed1, dismissed2, pending] });
  assert.equal(result.standaloneTasks.length, 1);
  assert.equal(result.standaloneTasks[0].id, pending.id);
  assert.ok(!result.standaloneTasks.some((t) => t.status === "dismissed"));
});

test("13/14. pending and in-progress standalone tasks still render", () => {
  const pending = task({ status: "pending" });
  const inProgress = task({ status: "in_progress" });
  const result = partitionExecutionGraph({ commitments: [], tasks: [pending, inProgress] });
  assert.equal(result.standaloneTasks.length, 2);
});

test("15. a completed standalone task does not render as active (Standalone Tasks is 'still actionable' work)", () => {
  const completed = task({ status: "completed" });
  const result = partitionExecutionGraph({ commitments: [], tasks: [completed] });
  assert.equal(result.standaloneTasks.length, 0);
  // But it still counts toward the broader "execution tasks" total (progress-relevant), unlike
  // dismissed work -- proving completed and dismissed are deliberately treated differently.
  assert.equal(result.executionTasks.length, 1);
});

test("dismissed linked (child) tasks are excluded from executionTasks/linkedExecutionTasks too, not just standalone", () => {
  const dismissedChild = task({ status: "dismissed", commitment_id: "commitment-1" });
  const activeChild = task({ status: "in_progress", commitment_id: "commitment-1" });
  const result = partitionExecutionGraph({
    commitments: [commitment({ id: "commitment-1" })],
    tasks: [dismissedChild, activeChild]
  });
  assert.equal(result.linkedExecutionTasks.length, 1);
  assert.equal(result.linkedExecutionTasks[0].id, activeChild.id);
});

// ============================================================
// Progress/count totals -- dismissed tasks must not inflate denominators
// ============================================================

test("11. dismissed child tasks never inflate a commitment's progress total", () => {
  const parent = commitment({ id: "commitment-1" });
  const completedChild = task({ status: "completed", commitment_id: "commitment-1" });
  const dismissedChild = task({ status: "dismissed", commitment_id: "commitment-1" });
  const progress = computeCommitmentProgress(parent, [completedChild, dismissedChild]);
  assert.equal(progress.total, 1, "dismissed child must not count toward the total");
  assert.equal(progress.completed, 1);
  assert.equal(progress.percent, 100);
});

test("dismissed tasks never inflate project-level progress totals", () => {
  const parent = commitment({ id: "commitment-1" });
  const completedChild = task({ status: "completed", commitment_id: "commitment-1" });
  const dismissedChild = task({ status: "dismissed", commitment_id: "commitment-1" });
  const dismissedStandalone = task({ status: "dismissed" });
  const progress = computeProjectProgress({
    commitments: [parent],
    tasks: [completedChild, dismissedChild, dismissedStandalone]
  });
  assert.equal(progress.total, 1);
  assert.equal(progress.completed, 1);
});

test("9/17 (commitment workspace): a commitment whose only children are all dismissed falls back to the commitment's own status, not a permanently-0% progress bar", () => {
  const parent = commitment({ id: "commitment-1", status: "completed" });
  const dismissedChild = task({ status: "dismissed", commitment_id: "commitment-1" });
  const progress = computeCommitmentProgress(parent, [dismissedChild]);
  assert.equal(progress.total, 1);
  assert.equal(progress.completed, 1);
  assert.equal(progress.percent, 100);
});

// ============================================================
// Commitment Workspace progress reactivity -- regression coverage for the bug where completing
// a child task did not immediately move the parent commitment's progress indicator. The
// workspace's `progress` value is a useMemo over the same `tasks` array that `updateTask`
// replaces via `setTasks(current => current.map(...))`; these tests replay that exact
// replace-one-element-by-id update against computeCommitmentProgress to prove the recalculated
// total tracks the child task state on every toggle, not just on initial load.
// ============================================================

test("commitment workspace: completing one of 7 pending child tasks immediately moves progress from 0/7 (0%) to 1/7 (14%)", () => {
  const parent = commitment({ id: "commitment-1" });
  const children = Array.from({ length: 7 }, () =>
    task({ status: "pending", commitment_id: "commitment-1" })
  );

  const before = computeCommitmentProgress(parent, children);
  assert.deepEqual(before, { completed: 0, total: 7, percent: 0 });

  // Mirrors CommitmentWorkspace.updateTask's setTasks(current => current.map(...)) after a
  // successful PATCH response -- replace only the completed task, by id, in a new array.
  const targetId = children[0].id;
  const afterChildren = children.map((child) =>
    child.id === targetId ? { ...child, status: "completed" as const } : child
  );
  const after = computeCommitmentProgress(parent, afterChildren);
  assert.deepEqual(after, { completed: 1, total: 7, percent: 14 });
});

test("commitment workspace: completing another task moves progress from 3/7 to 4/7", () => {
  const parent = commitment({ id: "commitment-1" });
  const children = [
    ...Array.from({ length: 3 }, () => task({ status: "completed", commitment_id: "commitment-1" })),
    ...Array.from({ length: 4 }, () => task({ status: "pending", commitment_id: "commitment-1" }))
  ];
  assert.equal(computeCommitmentProgress(parent, children).completed, 3);

  const targetId = children[3].id;
  const afterChildren = children.map((child) =>
    child.id === targetId ? { ...child, status: "completed" as const } : child
  );
  const after = computeCommitmentProgress(parent, afterChildren);
  assert.equal(after.completed, 4);
  assert.equal(after.total, 7);
});

test("commitment workspace: reopening a completed task decrements progress (4/7 -> 3/7, and 7/7 -> 6/7)", () => {
  const parent = commitment({ id: "commitment-1" });
  const children = [
    ...Array.from({ length: 4 }, () => task({ status: "completed", commitment_id: "commitment-1" })),
    ...Array.from({ length: 3 }, () => task({ status: "pending", commitment_id: "commitment-1" }))
  ];
  const targetId = children[0].id;
  const reopened = children.map((child) =>
    child.id === targetId ? { ...child, status: "pending" as const } : child
  );
  const afterReopen = computeCommitmentProgress(parent, reopened);
  assert.equal(afterReopen.completed, 3);
  assert.equal(afterReopen.total, 7);

  const allCompleted = Array.from({ length: 7 }, () =>
    task({ status: "completed", commitment_id: "commitment-1" })
  );
  assert.equal(computeCommitmentProgress(parent, allCompleted).percent, 100);
  const oneReopened = allCompleted.map((child, index) =>
    index === 0 ? { ...child, status: "pending" as const } : child
  );
  const progress = computeCommitmentProgress(parent, oneReopened);
  assert.equal(progress.completed, 6);
  assert.equal(progress.total, 7);
});

test("commitment workspace: dismissed child tasks are excluded from the rendered task list and owner groups", () => {
  const parent = commitment({ id: "commitment-1" });
  const dismissedChild = task({ status: "dismissed", commitment_id: "commitment-1", owner: "Jamileh Hamideh" });
  const activeChild = task({ status: "pending", commitment_id: "commitment-1", owner: "Aditya Ujawane" });
  const model = buildCommitmentWorkspaceModel({ commitment: parent, tasks: [dismissedChild, activeChild] });
  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].id, activeChild.id);
  assert.equal(
    model.taskGroups.flatMap((g) => g.tasks).some((t) => t.status === "dismissed"),
    false
  );
});

// ============================================================
// 16. No generation-tracking mechanism is needed: the status filter alone is sufficient
// regardless of which analysis generation produced the row, since a dismissed task's status is
// preserved verbatim across regenerations by the existing manual_override_fields mechanism
// (see supabase/migrations/20260723130000_production_execution_graph_safety.sql). This test
// proves the filter is generation-agnostic -- it never needs to know which generation a task
// came from to correctly exclude it.
// ============================================================

test("16. filtering never depends on generation metadata -- a dismissed task from any generation is excluded purely by status", () => {
  const staleGenerationDismissed = task({
    status: "dismissed",
    extraction_metadata: { analysis_generation: 3 } as unknown as MeetingTask["extraction_metadata"]
  });
  const currentGenerationActive = task({
    status: "pending",
    extraction_metadata: { analysis_generation: 19 } as unknown as MeetingTask["extraction_metadata"]
  });
  const result = partitionExecutionGraph({
    commitments: [],
    tasks: [staleGenerationDismissed, currentGenerationActive]
  });
  assert.equal(result.standaloneTasks.length, 1);
  assert.equal(result.standaloneTasks[0].id, currentGenerationActive.id);
});
