import assert from "node:assert/strict";
import test from "node:test";

import { isCommitmentCurrentGeneration, isTaskCurrentGeneration } from "../lib/execution-generation";
import { validateProposalTargets } from "../lib/project-brain/operations";
import type { MeetingCommitment, MeetingTask } from "../lib/types";

/**
 * These tests exercise the exact generation-currency logic buildProjectBrainContext
 * (lib/project-brain/context.ts) applies to meeting_commitments/meeting_tasks before handing them
 * to Project Brain -- isCommitmentCurrentGeneration/isTaskCurrentGeneration from
 * lib/execution-generation.ts, the same shared helpers the meeting UI and project execution
 * aggregation use. context.ts itself talks to Supabase directly and has no mocking harness in this
 * repo, so this is the faithful, DB-free way to prove the filtering behavior it composes.
 */

function commitment(overrides: Partial<MeetingCommitment> & { id: string }): MeetingCommitment {
  return {
    meeting_id: "meeting-a",
    project_id: "project-1",
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
    type: "personal",
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
    meeting_id: "meeting-a",
    project_id: "project-1",
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

const CURRENT_GENERATION = 14;

const gen4Commitment = commitment({ id: "c-gen4", metadata: { analysis_generation: 4 } });
const gen9Commitment = commitment({ id: "c-gen9", metadata: { analysis_generation: 9 } });
const gen14Commitment = commitment({ id: "c-gen14", metadata: { analysis_generation: 14 } });
const manualCommitment = commitment({
  id: "c-manual",
  metadata: { source_type: "project_chat", proposal_id: "p1" }
});

const staleTask = task({ id: "t-stale", extraction_metadata: { analysis_generation: 9 } });
const currentTask = task({ id: "t-current", extraction_metadata: { analysis_generation: 14 } });
const manualTask = task({ id: "t-manual", extraction_metadata: {} });

// ============================================================
// PROJECT BRAIN generation filtering (Part 8, items 13-18)
// ============================================================

test("13. a current-generation commitment is included in Project Brain's context", () => {
  assert.equal(isCommitmentCurrentGeneration(gen14Commitment, CURRENT_GENERATION), true);
});

test("14. a stale generated commitment (older generation) is excluded from Project Brain's context", () => {
  assert.equal(isCommitmentCurrentGeneration(gen4Commitment, CURRENT_GENERATION), false);
  assert.equal(isCommitmentCurrentGeneration(gen9Commitment, CURRENT_GENERATION), false);
});

test("15. a current-generation task is included in Project Brain's context", () => {
  assert.equal(isTaskCurrentGeneration(currentTask, CURRENT_GENERATION), true);
});

test("16. a stale generated task is excluded from Project Brain's context", () => {
  assert.equal(isTaskCurrentGeneration(staleTask, CURRENT_GENERATION), false);
});

test("17. an unstamped manual commitment (no analysis_generation at all) is preserved/visible to Project Brain", () => {
  assert.equal(isCommitmentCurrentGeneration(manualCommitment, CURRENT_GENERATION), true);
});

test("18. an unstamped manual task is preserved/visible to Project Brain", () => {
  assert.equal(isTaskCurrentGeneration(manualTask, CURRENT_GENERATION), true);
});

test("full Part 7 fixture shape: filtering [gen4, gen9, gen14, manual] commitments and [stale, current, manual] tasks yields exactly the expected included/excluded sets", () => {
  const allCommitments = [gen4Commitment, gen9Commitment, gen14Commitment, manualCommitment];
  const included = allCommitments.filter((c) => isCommitmentCurrentGeneration(c, CURRENT_GENERATION));
  assert.deepEqual(
    included.map((c) => c.id).sort(),
    ["c-gen14", "c-manual"]
  );

  const allTasks = [staleTask, currentTask, manualTask];
  const includedTasks = allTasks.filter((t) => isTaskCurrentGeneration(t, CURRENT_GENERATION));
  assert.deepEqual(
    includedTasks.map((t) => t.id).sort(),
    ["t-current", "t-manual"]
  );
});

// ============================================================
// PROJECT BRAIN write safety (Part 8, items 19-20)
// ============================================================

function brainContextFixture() {
  return {
    milestones: [{ id: "c-gen14" }, { id: "c-manual" }],
    tasks: [{ id: "t-current" }, { id: "t-manual" }],
    staleMilestoneIds: new Set(["c-gen4", "c-gen9"]),
    staleTaskIds: new Set(["t-stale"])
  };
}

test("19. a proposal targeting a stale generated commitment is rejected with stale_execution_target, row unchanged", () => {
  const operations = [{ type: "update_milestone", milestoneId: "c-gen9", changes: { title: "New title" } }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_execution_target");
});

test("19b. a proposal targeting a stale generated task is rejected with stale_execution_target", () => {
  const operations = [{ type: "update_task", taskId: "t-stale", changes: { status: "completed" } }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_execution_target");
});

test("20. a proposal targeting the current-generation commitment passes validation (normal mutation path still works)", () => {
  const operations = [{ type: "update_milestone", milestoneId: "c-gen14", changes: { title: "New title" } }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, true);
});

test("20b. a proposal targeting an unstamped manual commitment also passes validation", () => {
  const operations = [{ type: "update_milestone", milestoneId: "c-manual", changes: { title: "New title" } }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, true);
});

test("a proposal referencing an id from a genuinely different project (not stale, just foreign) is rejected as outside_project, not stale_execution_target", () => {
  const operations = [{ type: "update_milestone", milestoneId: "c-other-project" }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "outside_project");
});

test("create_milestone/create_task operations (no target id) are never affected by target validation", () => {
  const operations = [{ type: "create_milestone", title: "New milestone" }];
  const result = validateProposalTargets(operations, brainContextFixture());
  assert.equal(result.ok, true);
});

// ============================================================
// 21. preserve_on_reanalysis behavior is orthogonal / unchanged
// ============================================================

test("21. generation currency is independent of preserve_on_reanalysis -- a preserve_on_reanalysis=true row from an old generation is still excluded", () => {
  const projectBrainEdited = commitment({
    id: "c-gen9-edited",
    metadata: { analysis_generation: 9 },
    preserve_on_reanalysis: true,
    manual_override_fields: ["title", "owner"]
  });
  // Exactly the real-world shape: a Project Brain proposal renamed this row and set
  // preserve_on_reanalysis=true, but never touched metadata.analysis_generation -- it must still
  // read as stale.
  assert.equal(isCommitmentCurrentGeneration(projectBrainEdited, CURRENT_GENERATION), false);
});

test("21b. generation currency is independent of preserve_on_reanalysis -- a preserve_on_reanalysis=false current-generation row is still included", () => {
  const current = commitment({
    id: "c-gen14-unedited",
    metadata: { analysis_generation: 14 },
    preserve_on_reanalysis: false
  });
  assert.equal(isCommitmentCurrentGeneration(current, CURRENT_GENERATION), true);
});
