import assert from "node:assert/strict";
import test from "node:test";

import { partitionExecutionGraph } from "../lib/execution-display";
import { isCommitmentCurrentGeneration, isTaskCurrentGeneration } from "../lib/execution-generation";
import { buildProjectExecutionModel } from "../lib/project-execution";
import type { Meeting, MeetingCommitment, MeetingTask, Project } from "../lib/types";

function commitment(overrides: Partial<MeetingCommitment> & { id: string }): MeetingCommitment {
  return {
    meeting_id: "meeting-1",
    project_id: null,
    converted_to_task_id: null,
    topic_id: null,
    title: "Untitled commitment",
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: null,
    source_segment_ids: [],
    type: "assignment",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    preserve_on_reanalysis: false,
    manual_override_fields: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function task(overrides: Partial<MeetingTask> & { id: string }): MeetingTask {
  return {
    meeting_id: "meeting-1",
    project_id: null,
    topic_id: null,
    commitment_id: null,
    task: "Untitled task",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    inferred: false,
    extraction_metadata: {},
    preserve_on_reanalysis: false,
    manual_override_fields: [],
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    position: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function meeting(overrides: Partial<Meeting> & { id: string }): Meeting {
  return {
    user_id: "user-1",
    project_id: null,
    title: "A meeting",
    meeting_url: "https://example.com",
    platform: "zoom",
    recall_bot_id: null,
    status: "completed",
    is_pinned: false,
    deleted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function project(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: "A project",
    description: null,
    goal: null,
    status: "active",
    owner_id: "user-1",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

// ============================================================
// isCommitmentCurrentGeneration / isTaskCurrentGeneration
// ============================================================

test("isCommitmentCurrentGeneration: true when the row's stamped generation matches the meeting's current generation", () => {
  const c = commitment({ id: "c1", metadata: { analysis_generation: 14 } });
  assert.equal(isCommitmentCurrentGeneration(c, 14), true);
});

test("isCommitmentCurrentGeneration: false when the row's stamped generation is older than the meeting's current generation", () => {
  const c = commitment({ id: "c1", metadata: { analysis_generation: 9 } });
  assert.equal(isCommitmentCurrentGeneration(c, 14), false);
});

test("isCommitmentCurrentGeneration: a row with no analysis_generation stamp (e.g. created outside the analysis pipeline) is treated as current", () => {
  const c = commitment({ id: "c1", metadata: { source_type: "project_chat" } });
  assert.equal(isCommitmentCurrentGeneration(c, 14), true);
});

test("isCommitmentCurrentGeneration: no filtering occurs when the meeting's current generation is unknown (null)", () => {
  const c = commitment({ id: "c1", metadata: { analysis_generation: 4 } });
  assert.equal(isCommitmentCurrentGeneration(c, null), true);
});

test("isTaskCurrentGeneration: true when the task's stamped generation matches the current generation", () => {
  const t = task({ id: "t1", extraction_metadata: { analysis_generation: 14 } });
  assert.equal(isTaskCurrentGeneration(t, 14), true);
});

test("isTaskCurrentGeneration: false when the task's stamped generation is older than the current generation", () => {
  const t = task({ id: "t1", extraction_metadata: { analysis_generation: 4 } });
  assert.equal(isTaskCurrentGeneration(t, 14), false);
});

test("isTaskCurrentGeneration: a task with no extraction_metadata is treated as current", () => {
  const t = task({ id: "t1", extraction_metadata: null });
  assert.equal(isTaskCurrentGeneration(t, 14), true);
});

// ============================================================
// partitionExecutionGraph -- the exact reported bug (3 commitments shown, 1 expected)
// ============================================================

test("partitionExecutionGraph: reproduces and fixes the real staging bug -- two stale-generation commitments plus one current-generation commitment yields exactly one active commitment", () => {
  const correct = commitment({
    id: "gen-14-correct",
    title: "Deliver the first informational website draft",
    metadata: { analysis_generation: 14 }
  });
  const staleDomain = commitment({
    id: "gen-4-stale",
    title: "Link existing domain and email to new website deployment on Versa",
    metadata: { analysis_generation: 4 }
  });
  const staleRelease = commitment({
    id: "gen-9-stale",
    title: "Deliver Informational Website First Release",
    preserve_on_reanalysis: true,
    manual_override_fields: ["title", "owner"],
    metadata: { analysis_generation: 9 }
  });

  const result = partitionExecutionGraph({
    commitments: [correct, staleDomain, staleRelease],
    tasks: [],
    currentGeneration: 14
  });

  assert.equal(result.activeCommitments.length, 1);
  assert.equal(result.activeCommitments[0].id, "gen-14-correct");
});

test("partitionExecutionGraph: without a currentGeneration, behaves exactly as before (backward compatible, no filtering)", () => {
  const correct = commitment({ id: "gen-14-correct", metadata: { analysis_generation: 14 } });
  const stale = commitment({ id: "gen-4-stale", metadata: { analysis_generation: 4 } });

  const result = partitionExecutionGraph({ commitments: [correct, stale], tasks: [] });

  assert.equal(result.activeCommitments.length, 2);
});

test("partitionExecutionGraph: stale-generation tasks are excluded from executionTasks, linkedExecutionTasks, and standaloneTasks", () => {
  const currentCommitment = commitment({ id: "c-current", metadata: { analysis_generation: 14 } });
  const currentLinked = task({
    id: "t-current-linked",
    commitment_id: "c-current",
    extraction_metadata: { analysis_generation: 14 }
  });
  const staleLinked = task({
    id: "t-stale-linked",
    commitment_id: "c-current",
    extraction_metadata: { analysis_generation: 9 }
  });
  const staleStandalone = task({
    id: "t-stale-standalone",
    commitment_id: null,
    extraction_metadata: { analysis_generation: 4 }
  });

  const result = partitionExecutionGraph({
    commitments: [currentCommitment],
    tasks: [currentLinked, staleLinked, staleStandalone],
    currentGeneration: 14
  });

  assert.deepEqual(
    result.executionTasks.map((t) => t.id),
    ["t-current-linked"]
  );
  assert.deepEqual(
    result.linkedExecutionTasks.map((t) => t.id),
    ["t-current-linked"]
  );
  assert.equal(result.standaloneTasks.length, 0);
});

test("partitionExecutionGraph: a task orphaned from an older generation than its (current) parent commitment is excluded -- generations are never mixed on one page", () => {
  const currentCommitment = commitment({ id: "c-current", metadata: { analysis_generation: 14 } });
  const orphanTask = task({
    id: "t-old-gen",
    commitment_id: "c-current",
    extraction_metadata: { analysis_generation: 13 }
  });

  const result = partitionExecutionGraph({
    commitments: [currentCommitment],
    tasks: [orphanTask],
    currentGeneration: 14
  });

  assert.equal(result.linkedExecutionTasks.length, 0);
});

test("partitionExecutionGraph: a commitment/task with no generation stamp at all (e.g. manually created via Project Brain) stays visible", () => {
  const manuallyCreated = commitment({
    id: "c-manual",
    metadata: { source_type: "project_chat", proposal_id: "p1" }
  });

  const result = partitionExecutionGraph({
    commitments: [manuallyCreated],
    tasks: [],
    currentGeneration: 14
  });

  assert.equal(result.activeCommitments.length, 1);
});

test("partitionExecutionGraph: historical (stale) rows are excluded from the active view but the input list itself is untouched -- they remain stored, not deleted", () => {
  const stale = commitment({ id: "c-stale", metadata: { analysis_generation: 4 } });
  const input = [stale];

  const result = partitionExecutionGraph({ commitments: input, tasks: [], currentGeneration: 14 });

  assert.equal(result.activeCommitments.length, 0);
  assert.equal(input.length, 1);
  assert.equal(input[0].id, "c-stale");
});

test("partitionExecutionGraph: a dismissed-status task from the current generation is still excluded (generation currency and status filtering compose correctly)", () => {
  const currentCommitment = commitment({ id: "c-current", metadata: { analysis_generation: 14 } });
  const dismissedCurrentTask = task({
    id: "t-dismissed",
    commitment_id: "c-current",
    status: "dismissed",
    extraction_metadata: { analysis_generation: 14 }
  });

  const result = partitionExecutionGraph({
    commitments: [currentCommitment],
    tasks: [dismissedCurrentTask],
    currentGeneration: 14
  });

  assert.equal(result.linkedExecutionTasks.length, 0);
});

// ============================================================
// buildProjectExecutionModel -- cross-meeting generation currency
// ============================================================

test("buildProjectExecutionModel: a stale commitment from one meeting's older generation is excluded while a current commitment from a different meeting in the same project is kept", () => {
  const meetingA = meeting({ id: "meeting-a", project_id: "project-1", execution_graph_generation: 14 });
  const meetingB = meeting({ id: "meeting-b", project_id: "project-1", execution_graph_generation: 3 });

  const staleFromA = commitment({
    id: "c-stale-a",
    meeting_id: "meeting-a",
    project_id: "project-1",
    metadata: { analysis_generation: 9 }
  });
  const currentFromA = commitment({
    id: "c-current-a",
    meeting_id: "meeting-a",
    project_id: "project-1",
    metadata: { analysis_generation: 14 }
  });
  const currentFromB = commitment({
    id: "c-current-b",
    meeting_id: "meeting-b",
    project_id: "project-1",
    metadata: { analysis_generation: 3 }
  });

  const model = buildProjectExecutionModel({
    project: project({ id: "project-1" }),
    meetings: [meetingA, meetingB],
    commitments: [staleFromA, currentFromA, currentFromB],
    tasks: []
  });

  assert.deepEqual(
    model.commitments.map((c) => c.id).sort(),
    ["c-current-a", "c-current-b"]
  );
});

test("buildProjectExecutionModel: project-wide progress totals reflect only current-generation rows, not stale leftovers", () => {
  const currentMeeting = meeting({ id: "meeting-a", project_id: "project-1", execution_graph_generation: 14 });
  const staleCommitment = commitment({
    id: "c-stale",
    meeting_id: "meeting-a",
    project_id: "project-1",
    status: "completed",
    metadata: { analysis_generation: 4 }
  });
  const currentCommitment = commitment({
    id: "c-current",
    meeting_id: "meeting-a",
    project_id: "project-1",
    status: "pending",
    metadata: { analysis_generation: 14 }
  });

  const model = buildProjectExecutionModel({
    project: project({ id: "project-1" }),
    meetings: [currentMeeting],
    commitments: [staleCommitment, currentCommitment],
    tasks: []
  });

  assert.equal(model.progress.total, 1);
  assert.equal(model.progress.completed, 0);
});
