import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildMeetingGenerationMap,
  canDemoteCommitmentToFutureScope,
  filterEligibleMoveDestinations,
  getActiveChildTasks,
  isEligibleMoveDestination,
  logCorrectionEvent
} from "../lib/execution-corrections";
import {
  computeCommitmentProgress,
  computeProjectProgress,
  mergeProjectPeople,
  shouldPromptForCommitmentCompletion
} from "../lib/project-execution";
import { isCommittedWork, partitionExecutionGraph } from "../lib/execution-display";
import type {
  Meeting,
  MeetingCommitment,
  MeetingTask,
  MeetingTaskStatus
} from "../lib/types";

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
    source_quote: null,
    source_segment_ids: [],
    ...overrides
  } as MeetingCommitment;
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
// isEligibleMoveDestination / filterEligibleMoveDestinations
// ============================================================

test("isEligibleMoveDestination: a current-generation, committed, non-dismissed commitment in the same project is eligible", () => {
  const destination = commitment({ project_id: "project-1", meeting_id: "meeting-2" });
  const eligible = isEligibleMoveDestination({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    destination,
    destinationMeetingGeneration: null
  });
  assert.equal(eligible, true);
});

test("isEligibleMoveDestination: rejects a dismissed commitment", () => {
  const destination = commitment({ project_id: "project-1", status: "dismissed" });
  const eligible = isEligibleMoveDestination({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    destination,
    destinationMeetingGeneration: null
  });
  assert.equal(eligible, false);
});

test("isEligibleMoveDestination: rejects a Future Scope (non-committed) commitment", () => {
  const destination = commitment({ project_id: "project-1", execution_classification: "future_consideration" });
  const eligible = isEligibleMoveDestination({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    destination,
    destinationMeetingGeneration: null
  });
  assert.equal(eligible, false);
});

test("isEligibleMoveDestination: rejects a commitment from a stale analysis generation", () => {
  const destination = commitment({
    project_id: "project-1",
    meeting_id: "meeting-2",
    metadata: { analysis_generation: 1 }
  });
  const eligible = isEligibleMoveDestination({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    destination,
    destinationMeetingGeneration: 2
  });
  assert.equal(eligible, false);
});

test("isEligibleMoveDestination: rejects a commitment from a different project when the task is project-linked", () => {
  const destination = commitment({ project_id: "project-2" });
  const eligible = isEligibleMoveDestination({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    destination,
    destinationMeetingGeneration: null
  });
  assert.equal(eligible, false);
});

test("isEligibleMoveDestination: a task with no project falls back to same-meeting scoping", () => {
  const sameMeeting = commitment({ project_id: null, meeting_id: "meeting-1" });
  const otherMeeting = commitment({ project_id: null, meeting_id: "meeting-9" });
  const task_ = { meeting_id: "meeting-1", project_id: null };
  assert.equal(
    isEligibleMoveDestination({ task: task_, destination: sameMeeting, destinationMeetingGeneration: null }),
    true
  );
  assert.equal(
    isEligibleMoveDestination({ task: task_, destination: otherMeeting, destinationMeetingGeneration: null }),
    false
  );
});

test("filterEligibleMoveDestinations: filters a mixed candidate list down to only eligible commitments", () => {
  const eligible = commitment({ project_id: "project-1", meeting_id: "meeting-2" });
  const dismissed = commitment({ project_id: "project-1", status: "dismissed" });
  const otherProject = commitment({ project_id: "project-9" });
  const result = filterEligibleMoveDestinations({
    task: { meeting_id: "meeting-1", project_id: "project-1" },
    candidates: [eligible, dismissed, otherProject],
    meetingGenerationById: buildMeetingGenerationMap([meeting({ id: "meeting-2" })])
  });
  assert.deepEqual(result.map((item) => item.id), [eligible.id]);
});

// ============================================================
// Commitment demotion safety (Future Scope orphaning guard)
// ============================================================

test("getActiveChildTasks / canDemoteCommitmentToFutureScope: a commitment with an active child task cannot be demoted", () => {
  const parent = commitment({ id: "commitment-1" });
  const child = task({ commitment_id: "commitment-1", status: "pending" });
  assert.equal(getActiveChildTasks(parent, [child]).length, 1);
  assert.equal(canDemoteCommitmentToFutureScope(parent, [child]), false);
});

test("canDemoteCommitmentToFutureScope: a commitment with zero children can be demoted", () => {
  const parent = commitment({ id: "commitment-1" });
  assert.equal(canDemoteCommitmentToFutureScope(parent, []), true);
});

test("canDemoteCommitmentToFutureScope: dismissed and completed children do not block demotion by themselves, but a completed child still counts as an active child (it is committed work)", () => {
  const parent = commitment({ id: "commitment-1" });
  const dismissedChild = task({ commitment_id: "commitment-1", status: "dismissed" });
  assert.equal(canDemoteCommitmentToFutureScope(parent, [dismissedChild]), true);

  const completedChild = task({ commitment_id: "commitment-1", status: "completed" });
  assert.equal(
    canDemoteCommitmentToFutureScope(parent, [completedChild]),
    false,
    "completed work still belongs to the commitment for progress purposes, so it still blocks demotion"
  );
});

test("canDemoteCommitmentToFutureScope: a child that already moved to Future Scope does not block demotion", () => {
  const parent = commitment({ id: "commitment-1" });
  const futureChild = task({
    commitment_id: "commitment-1",
    status: "pending",
    execution_classification: "future_consideration"
  });
  assert.equal(canDemoteCommitmentToFutureScope(parent, [futureChild]), true);
});

// ============================================================
// End-to-end progress effects of a correction (pure-function simulation of what the API routes do)
// ============================================================

test("moving a child task from commitment A to commitment B decreases A's progress and increases B's", () => {
  const commitmentA = commitment({ id: "commitment-a" });
  const commitmentB = commitment({ id: "commitment-b" });
  const movingTask = task({ commitment_id: "commitment-a", status: "pending" });
  const otherATask = task({ commitment_id: "commitment-a", status: "completed" });
  const tasksBefore = [movingTask, otherATask];

  const progressABefore = computeCommitmentProgress(commitmentA, tasksBefore);
  const progressBBefore = computeCommitmentProgress(commitmentB, tasksBefore);
  assert.deepEqual(progressABefore, { completed: 1, total: 2, percent: 50 });
  assert.deepEqual(progressBBefore, { completed: 0, total: 1, percent: 0 });

  // Simulate the API route's field change: commitment_id A -> B.
  const tasksAfter = tasksBefore.map((item) =>
    item.id === movingTask.id ? { ...item, commitment_id: "commitment-b" } : item
  );
  const progressAAfter = computeCommitmentProgress(commitmentA, tasksAfter);
  const progressBAfter = computeCommitmentProgress(commitmentB, tasksAfter);
  assert.deepEqual(progressAAfter, { completed: 1, total: 1, percent: 100 });
  assert.deepEqual(progressBAfter, { completed: 0, total: 1, percent: 0 });
});

test("commitment completion prompt requires non-empty, 100% child progress and an open commitment", () => {
  const parent = commitment({ id: "commitment-1" });
  const complete = task({ commitment_id: parent.id, status: "completed" });
  const pending = task({ commitment_id: parent.id, status: "pending" });
  assert.equal(shouldPromptForCommitmentCompletion(parent, []), false);
  assert.equal(shouldPromptForCommitmentCompletion(parent, [complete]), true);
  assert.equal(shouldPromptForCommitmentCompletion(parent, [complete, pending]), false);
  assert.equal(
    shouldPromptForCommitmentCompletion(
      commitment({ id: parent.id, status: "completed", completion_state: "completed" }),
      [complete]
    ),
    false
  );
  assert.equal(
    shouldPromptForCommitmentCompletion(
      commitment({ id: parent.id, status: "dismissed", completion_state: "cancelled" }),
      [complete]
    ),
    false
  );
});

test("standalone and Future Scope tasks never trigger commitment completion", () => {
  const parent = commitment({ id: "commitment-1" });
  const standalone = task({ commitment_id: null, status: "completed" });
  const future = task({
    commitment_id: parent.id,
    status: "completed",
    execution_classification: "future_consideration"
  });
  assert.equal(shouldPromptForCommitmentCompletion(parent, [standalone, future]), false);
});

test("reopening a child does not implicitly reopen a completed commitment", () => {
  const parent = commitment({
    id: "commitment-1",
    status: "completed",
    completion_state: "completed"
  });
  const reopened = task({ commitment_id: parent.id, status: "in_progress" });
  assert.equal(shouldPromptForCommitmentCompletion(parent, [reopened]), false);
  assert.equal(parent.status, "completed");
});

test("Project People deduplicates corrected identities and prefers resolved individuals over combined labels", () => {
  assert.deepEqual(
    mergeProjectPeople([
      "Aditya Ujawane",
      "aditya ujawane",
      "Craig Lauer",
      "Laura Wetherhold",
      "Craig Lauer and Laura Wetherhold"
    ]),
    ["Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"]
  );
  assert.deepEqual(
    mergeProjectPeople(["Unresolved One and Unresolved Two"]),
    ["Unresolved One and Unresolved Two"]
  );
  assert.deepEqual(mergeProjectPeople(["Aditya Ujawane"]), ["Aditya Ujawane"]);
});

test("commitment workspace offers modal and load-time completion confirmation through the canonical status route", async () => {
  const component = await readFile(
    new URL("../components/commitment-workspace.tsx", import.meta.url),
    "utf8"
  );
  assert.match(component, /All tasks are complete/);
  assert.match(component, /Is this commitment complete\?/);
  assert.match(component, /Ready to close this commitment\?/);
  assert.match(component, /Mark commitment complete/);
  assert.match(component, /status: "completed"/);
  assert.match(component, /completion_state: "completed"/);
  assert.match(component, /\/api\/commitments\/\$\{commitment\.id\}/);
  assert.doesNotMatch(component, /window\.location\.reload/);
});

test("making a task standalone removes it from its old commitment's progress and it still counts toward project progress", () => {
  const parent = commitment({ id: "commitment-1" });
  const child = task({ commitment_id: "commitment-1", status: "pending" });
  const before = computeCommitmentProgress(parent, [child]);
  assert.equal(before.total, 1);

  const detached = { ...child, commitment_id: null };
  const after = computeCommitmentProgress(parent, [detached]);
  assert.deepEqual(after, { completed: 0, total: 1, percent: 0 }, "falls back to the commitment's own status with zero real children");

  const projectProgress = computeProjectProgress({ commitments: [parent], tasks: [detached] });
  assert.equal(
    projectProgress.total,
    2,
    "the now-standalone task still counts toward project-wide progress alongside the (childless) commitment's own unit"
  );
});

test("moving a task to Future Scope removes it from partitionExecutionGraph's active/standalone/linked sets", () => {
  const parent = commitment({ id: "commitment-1" });
  const linkedTask = task({ commitment_id: "commitment-1", status: "pending" });
  const before = partitionExecutionGraph({ commitments: [parent], tasks: [linkedTask] });
  assert.equal(before.linkedExecutionTasks.length, 1);

  const movedToFutureScope = { ...linkedTask, execution_classification: "future_consideration" as const };
  const after = partitionExecutionGraph({ commitments: [parent], tasks: [movedToFutureScope] });
  assert.equal(after.linkedExecutionTasks.length, 0);
  assert.equal(after.ideaTasks.length, 1);
  assert.equal(isCommittedWork(movedToFutureScope), false);
});

test("promoting a Future Scope task back to active makes it a standalone task again", () => {
  const futureTask = task({ status: "pending", execution_classification: "future_consideration" });
  const before = partitionExecutionGraph({ commitments: [], tasks: [futureTask] });
  assert.equal(before.standaloneTasks.length, 0);
  assert.equal(before.ideaTasks.length, 1);

  const promoted = { ...futureTask, execution_classification: "committed" as const };
  const after = partitionExecutionGraph({ commitments: [], tasks: [promoted] });
  assert.equal(after.standaloneTasks.length, 1);
  assert.equal(after.ideaTasks.length, 0);
});

// ============================================================
// logCorrectionEvent
// ============================================================

test("logCorrectionEvent: does not attempt to write when there is no project (nothing to scope the event to)", async () => {
  let insertCalled = false;
  const fakeClient = {
    from: () => ({
      insert: async () => {
        insertCalled = true;
        return { error: null };
      }
    })
  } as unknown as Parameters<typeof logCorrectionEvent>[0];

  await logCorrectionEvent(fakeClient, {
    projectId: null,
    actorId: "user-1",
    eventType: "task_made_standalone",
    entityType: "task",
    entityId: "task-1"
  });
  assert.equal(insertCalled, false);
});

test("logCorrectionEvent: writes a structured event when a project is present", async () => {
  let insertedRow: Record<string, unknown> | null = null;
  const fakeClient = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        assert.equal(table, "project_change_events");
        insertedRow = row;
        return { error: null };
      }
    })
  } as unknown as Parameters<typeof logCorrectionEvent>[0];

  await logCorrectionEvent(fakeClient, {
    projectId: "project-1",
    actorId: "user-1",
    eventType: "task_moved_commitment",
    entityType: "task",
    entityId: "task-1",
    beforeState: { commitment_id: "commitment-a" },
    afterState: { commitment_id: "commitment-b" }
  });

  assert.ok(insertedRow);
  assert.equal((insertedRow as Record<string, unknown>).project_id, "project-1");
  assert.equal((insertedRow as Record<string, unknown>).actor_type, "user");
  assert.equal((insertedRow as Record<string, unknown>).source_type, "manual");
});

test("logCorrectionEvent: a write failure never throws (telemetry must not block the correction)", async () => {
  const fakeClient = {
    from: () => ({
      insert: async () => {
        throw new Error("network error");
      }
    })
  } as unknown as Parameters<typeof logCorrectionEvent>[0];

  await assert.doesNotReject(
    logCorrectionEvent(fakeClient, {
      projectId: "project-1",
      actorId: "user-1",
      eventType: "extraction_reported",
      entityType: "task",
      entityId: "task-1"
    })
  );
});
