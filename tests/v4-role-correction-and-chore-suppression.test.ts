import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleExecutionTree,
  isEligibleAcceptanceCriterion,
  isEphemeralCompletedMeetingAction,
  isExecutionEligible
} from "../lib/execution-intelligence/execution-tree";
import { treeToExecutionGraph } from "../lib/execution-intelligence/execution-graph-v4";
import type {
  GroupProposal,
  RawWorkItem,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

/**
 * Focused regression tests for the final narrow V4 refinement:
 *   1. Try Again / in-scope-behavior decisions can attach as acceptance criteria (role fix,
 *      prompt-only -- see work-item-prompts.ts) without being promoted to an action/promise.
 *   2. Ephemeral completed meeting-process chores (opening a template, asking someone their goal)
 *      no longer persist as their own top-level completed commitment (see
 *      isEphemeralCompletedMeetingAction / execution-graph-v4.ts).
 * Mirrors the builder pattern in tests/v4-extraction-refinement-gen11.test.ts (not shared across
 * files, by existing convention).
 */

const segA = "11111111-1111-4111-8111-111111111111";
const segB = "22222222-2222-4222-8222-222222222222";
const segC = "33333333-3333-4333-8333-333333333333";

const transcript = `[${segA}] Note: fixture segment A.
[${segB}] Note: fixture segment B.
[${segC}] Note: fixture segment C.`;

function rawItem(overrides: Partial<RawWorkItem> & { title: string }): RawWorkItem {
  return {
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "Fixture classification.",
    source_quote: overrides.title,
    source_segment_ids: [segA],
    extraction_reason: "Fixture classification.",
    confidence: 0.9,
    ...overrides
  };
}

function workItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
}

function group(overrides: Partial<VerifiedGroup> & { title: string }): VerifiedGroup {
  return {
    ref: null,
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    group_basis: "multi_item_shared_purpose",
    member_refs: [],
    acceptance_criteria_refs: [],
    purpose_reason: "Fixture group.",
    explicit_outcome_evidence: null,
    ...overrides
  };
}

function assemble(
  workItems: WorkItem[],
  draftGroups: GroupProposal[] = [],
  verifiedGroups: VerifiedGroup[] = []
) {
  return assembleExecutionTree({ transcript, workItems, draftGroups, verifiedGroups });
}

// ---------------------------------------------------------------------------
// TRY AGAIN / in-scope-behavior role correction (Fix 1)
// ---------------------------------------------------------------------------

test("[1] a current-scope UX/behavior decision attaches as an acceptance criterion once role=acceptance_criterion", () => {
  const tryAgain = workItem({
    ref: "wi_tryagain",
    title: "Retry generation instead of editing a visually incorrect video",
    classification: "decision",
    status: "non_execution",
    scope_state: "current_scope",
    acceptance_state: "none",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: []
  });
  assert.equal(isEligibleAcceptanceCriterion(tryAgain), true);

  const mainTask = workItem({ ref: "wi_main", title: "Build the video-generation pipeline" });
  const verified = group({
    title: "Deliver the video-generation workflow",
    owner: "Aditya",
    group_basis: "explicit_deliverable",
    member_refs: ["wi_main"],
    acceptance_criteria_refs: ["wi_tryagain"],
    explicit_outcome_evidence: null
  });
  const assembled = assemble([mainTask, tryAgain], [], [verified]);
  assert.equal(assembled.tree.commitments.length, 1);
  assert.deepEqual(assembled.tree.commitments[0].acceptance_criteria_refs, ["wi_tryagain"]);
});

test("[2] a genuine phase/scope statement remains scope_decision and stays ineligible", () => {
  const scopeDecision = workItem({
    ref: "wi_scope",
    title: "Defer character generation to phase three",
    classification: "decision",
    status: "non_execution",
    scope_state: "current_scope",
    acceptance_state: "none",
    work_item_role: "scope_decision",
    owner: null,
    owners: []
  });
  assert.equal(isEligibleAcceptanceCriterion(scopeDecision), false);
  assert.equal(isExecutionEligible(scopeDecision), false);
  const assembled = assemble([scopeDecision]);
  const decision = assembled.workItemDecisions.find((d) => d.work_item_ref === "wi_scope");
  assert.equal(decision?.disposition, "excluded_ineligible");
});

test("[3] the UX decision is never treated as an action/promise merely to gain eligibility", () => {
  const tryAgain = workItem({
    ref: "wi_tryagain2",
    title: "Retry generation instead of editing a visually incorrect video",
    classification: "decision",
    status: "non_execution",
    scope_state: "current_scope",
    acceptance_state: "none",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: []
  });
  assert.equal(isExecutionEligible(tryAgain), false, "must never be active/execution-eligible work");
  assert.equal(isEligibleAcceptanceCriterion(tryAgain), true, "but must be attachable as a criterion");
});

test("[4] the criterion's null owner never overrides the commitment's resolved owner", () => {
  const tryAgain = workItem({
    ref: "wi_tryagain3",
    title: "Retry generation instead of editing a visually incorrect video",
    classification: "decision",
    status: "non_execution",
    scope_state: "current_scope",
    acceptance_state: "none",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: []
  });
  const mainTask = workItem({ ref: "wi_main2", title: "Build the video-generation pipeline", owner: "Aditya" });
  const verified = group({
    title: "Deliver the video-generation workflow",
    group_basis: "explicit_deliverable",
    member_refs: ["wi_main2"],
    acceptance_criteria_refs: ["wi_tryagain3"],
    explicit_outcome_evidence: null
    // no declared owner -- forces owner inference from member tasks only
  });
  const assembled = assemble([mainTask, tryAgain], [], [verified]);
  assert.equal(assembled.tree.commitments[0].owner, "Aditya");
});

// ---------------------------------------------------------------------------
// Ephemeral completed-chore suppression (Fix 2)
// ---------------------------------------------------------------------------

function completedItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return workItem({
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    work_item_role: "action",
    ...overrides
  });
}

test("[5] 'open a project plan template and review the bullet points' does not persist as a top-level completed commitment", () => {
  const item = completedItem({
    ref: "wi_template",
    title: "Open a project plan template and review the bullet points"
  });
  assert.equal(isEphemeralCompletedMeetingAction(item), true);
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length, 1, "still recorded as completed history");
  const graph = treeToExecutionGraph(assembled.tree);
  assert.equal(
    graph.commitments.find((c) => c.client_ref === "wi_template"),
    undefined,
    "must not become a persisted top-level completed commitment"
  );
});

test("[6] 'ask Kevin what his project goal is' does not persist as a top-level completed commitment", () => {
  const item = completedItem({
    ref: "wi_goal",
    title: "Ask Kevin what his project goal is",
    source_quote: "yeah what's your goal basically"
  });
  assert.equal(isEphemeralCompletedMeetingAction(item), true);
  const assembled = assemble([item]);
  const graph = treeToExecutionGraph(assembled.tree);
  assert.equal(graph.commitments.find((c) => c.client_ref === "wi_goal"), undefined);
});

test("[7] a meaningful completed deliverable still persists as its own completed commitment", () => {
  const item = completedItem({
    ref: "wi_sent",
    title: "Send the finalized project plan to the team",
    source_quote: "I already sent the finalized project plan to everyone"
  });
  assert.equal(isEphemeralCompletedMeetingAction(item), false);
  const assembled = assemble([item]);
  const graph = treeToExecutionGraph(assembled.tree);
  const persisted = graph.commitments.find((c) => c.client_ref === "wi_sent");
  assert.ok(persisted, "a real completed deliverable must still persist");
  assert.equal(persisted?.completion_state, "completed");
});

test("[8] active commitments and tasks are unaffected by the completed-chore filter", () => {
  const activeTask = workItem({ ref: "wi_active", title: "Build the video-generation pipeline", owner: "Aditya" });
  const ephemeral = completedItem({
    ref: "wi_template2",
    title: "Open a project plan template and review the bullet points"
  });
  const verified = group({
    title: "Deliver the video-generation workflow",
    owner: "Aditya",
    group_basis: "explicit_deliverable",
    member_refs: ["wi_active"],
    explicit_outcome_evidence: null
  });
  const assembled = assemble([activeTask, ephemeral], [], [verified]);
  const graph = treeToExecutionGraph(assembled.tree);
  assert.equal(graph.commitments.filter((c) => c.completion_state === "open").length, 1);
  assert.equal(graph.tasks.length, 1);
  assert.equal(graph.commitments.find((c) => c.client_ref === "wi_template2"), undefined);
});

test("[9] explicit_zero_task_outcome ephemeral-evidence suppression is unaffected by the new completed-work guard", () => {
  const completedMoment = workItem({
    ref: "wi_opened_template",
    title: "Open and review the project plan template",
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    source_segment_ids: [segA]
  });
  const zeroTaskGroup = group({
    title: "Open and review the project plan template",
    group_basis: "explicit_zero_task_outcome",
    member_refs: [],
    explicit_outcome_evidence: {
      source_quote: "Let's open and review the project plan template.",
      source_segment_ids: [segA]
    }
  });
  const assembled = assemble([completedMoment], [], [zeroTaskGroup]);
  assert.equal(assembled.tree.commitments.length, 0, "the zero-task-outcome group is still rejected as before");
  assert.equal(assembled.tree.completed_work?.length, 1, "the underlying moment is still preserved as history");
});
