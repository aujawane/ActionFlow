import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleExecutionTree,
  isExecutionEligible,
  isFutureScopeItem
} from "../lib/execution-intelligence/execution-tree";
import { treeToExecutionGraph } from "../lib/execution-intelligence/execution-graph-v4";
import type {
  GroupProposal,
  RawWorkItem,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

/**
 * Regression guards for the Gen11 refinement pass (see execution-tree.ts's
 * recoverExplicitDeliverables / isEphemeralMeetingMomentEvidence, and execution-graph-v4.ts's
 * treeToExecutionGraph evidence union). Mirrors the builder pattern in
 * tests/completed-during-meeting-persistence.test.ts (not shared across files, by existing
 * convention).
 */

const segA = "11111111-1111-4111-8111-111111111111";
const segB = "22222222-2222-4222-8222-222222222222";
const segC = "33333333-3333-4333-8333-333333333333";
const segD = "44444444-4444-4444-8444-444444444444";
const segE = "55555555-5555-4555-8555-555555555555";

const transcript = `[${segA}] Note: fixture segment A.
[${segB}] Note: fixture segment B.
[${segC}] Note: fixture segment C.
[${segD}] Note: fixture segment D.
[${segE}] Note: fixture segment E.`;

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
// 1 & 2 -- existing-character ingestion stays current; new-character generation stays deferred.
// ---------------------------------------------------------------------------
test("[1] existing-character ingestion survives as current, eligible Phase-1 work", () => {
  const item = workItem({
    ref: "wi_ingest",
    title: "Ingest at least one of Kevin's existing predefined characters to match his persona",
    classification: "accepted_request",
    scope_state: "current_scope",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(item), true);
  const assembled = assemble([item]);
  const standaloneRefs = assembled.tree.standalone_tasks.map((task) => task.ref);
  const commitmentTaskRefs = assembled.tree.commitments.flatMap((c) => c.tasks.map((t) => t.ref));
  assert.ok(
    standaloneRefs.includes("wi_ingest") || commitmentTaskRefs.includes("wi_ingest"),
    "existing-character ingestion must remain active work, not excluded"
  );
});

test("[2] new-character generation remains deferred, never current/active work", () => {
  const item = workItem({
    ref: "wi_generate",
    title: "Generate brand-new characters beyond Kevin's existing set",
    classification: "open_task",
    scope_state: "future_scope",
    work_item_role: "future_feature"
  });
  assert.equal(isFutureScopeItem(item), true);
  assert.equal(isExecutionEligible(item), false);
  const assembled = assemble([item]);
  assert.equal(assembled.tree.standalone_tasks.length, 0);
  assert.equal(assembled.tree.commitments.length, 0);
  const decision = assembled.workItemDecisions.find((d) => d.work_item_ref === "wi_generate");
  assert.equal(decision?.disposition, "excluded_ineligible");
});

// ---------------------------------------------------------------------------
// 3 & 4 -- Kevin is not assigned implementation ownership for Try Again / script editing.
// ---------------------------------------------------------------------------
test("[3] Kevin is not assigned implementation ownership for Try Again acceptance criteria", () => {
  const task1 = workItem({
    ref: "wi_impl",
    title: "Implement the Try Again regeneration flow",
    owner: "Aditya",
    owners: ["Aditya"]
  });
  const task2 = workItem({
    ref: "wi_impl2",
    title: "Wire up the revised-prompt regeneration call",
    owner: "Aditya",
    owners: ["Aditya"],
    source_segment_ids: [segB]
  });
  const criterion = workItem({
    ref: "wi_criterion",
    title: "Try Again must regenerate with a revised prompt",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: [],
    source_segment_ids: [segC]
  });
  const verified = group({
    title: "Phase-1 generation experience",
    owner: "Aditya",
    group_basis: "multi_item_shared_purpose",
    member_refs: ["wi_impl", "wi_impl2"],
    acceptance_criteria_refs: ["wi_criterion"],
    explicit_outcome_evidence: null
  });
  const assembled = assemble([task1, task2, criterion], [], [verified]);
  assert.equal(assembled.tree.commitments.length, 1);
  assert.equal(assembled.tree.commitments[0].owner, "Aditya");
});

test("[4] Kevin is not assigned implementation ownership for script editing", () => {
  const task1 = workItem({
    ref: "wi_script1",
    title: "Edit the generated script for the Phase-1 demo",
    owner: "Aditya",
    owners: ["Aditya"]
  });
  const task2 = workItem({
    ref: "wi_script2",
    title: "Run human review on the edited script",
    owner: "Aditya",
    owners: ["Aditya"],
    source_segment_ids: [segB]
  });
  const verified = group({
    title: "Script editing and human review",
    owner: "Aditya",
    group_basis: "multi_item_shared_purpose",
    member_refs: ["wi_script1", "wi_script2"]
  });
  const assembled = assemble([task1, task2], [], [verified]);
  assert.equal(assembled.tree.commitments.length, 1);
  assert.equal(assembled.tree.commitments[0].owner, "Aditya");
});

// ---------------------------------------------------------------------------
// 5 -- weekly meeting setup stays Aditya-owned through deterministic recovery.
// ---------------------------------------------------------------------------
test("[5] weekly meeting setup remains Aditya-owned when recovered as a standalone deliverable", () => {
  const item = workItem({
    ref: "wi_weekly",
    title: "Set up the recurring weekly check-in meeting",
    classification: "accepted_request",
    owner: "Aditya",
    owners: ["Aditya"]
  });
  const assembled = assemble([item]);
  const recovered = assembled.tree.commitments.find((c) => c.member_refs.includes("wi_weekly"));
  assert.ok(recovered, "weekly meeting setup must be recovered as its own commitment");
  assert.equal(recovered?.owner, "Aditya");
});

// ---------------------------------------------------------------------------
// 6 -- the project-plan parent remains one coherent commitment.
// ---------------------------------------------------------------------------
test("[6] the project-plan parent remains one coherent commitment, not split", () => {
  const task1 = workItem({ ref: "wi_plan1", title: "Draft the project plan outline" });
  const task2 = workItem({
    ref: "wi_plan2",
    title: "Circulate the project plan for feedback",
    source_segment_ids: [segB]
  });
  const verified = group({
    title: "Finalize and circulate the project plan",
    owner: "Aditya",
    group_basis: "multi_item_shared_purpose",
    member_refs: ["wi_plan1", "wi_plan2"]
  });
  const assembled = assemble([task1, task2], [], [verified]);
  assert.equal(assembled.tree.commitments.length, 1);
  assert.equal(assembled.tree.commitments[0].tasks.length, 2);
});

// ---------------------------------------------------------------------------
// 7 -- near-duplicate project-plan documentation tasks collapse (issue #3 fix).
// ---------------------------------------------------------------------------
test("[7] near-duplicate project-plan documentation standalone items collapse to one recovery", () => {
  const item1 = workItem({
    ref: "wi_doc1",
    title: "Record the phase-one and conditional deliverables",
    classification: "accepted_request",
    source_quote: "I'll record the phase-one and conditional deliverables.",
    source_segment_ids: [segA]
  });
  const item2 = workItem({
    ref: "wi_doc2",
    title: "Write down the phase-one deliverables",
    classification: "accepted_request",
    source_quote: "I'll write down the phase-one deliverables.",
    source_segment_ids: [segB]
  });
  const assembled = assemble([item1, item2]);
  assert.equal(assembled.tree.commitments.length, 1, "near-duplicate siblings must collapse to one recovered commitment");
  const decisionForSecond = assembled.recoveryDecisions.find((d) => d.work_item_ref === "wi_doc2");
  assert.equal(decisionForSecond?.disposition, "already_equivalent");
});

test("[7b] genuinely distinct standalone deliverables both survive, unaffected by the dedup fix", () => {
  const item1 = workItem({
    ref: "wi_distinct1",
    title: "Record the phase-one and conditional deliverables",
    classification: "accepted_request",
    source_quote: "I'll record the phase-one and conditional deliverables.",
    source_segment_ids: [segA]
  });
  const item2 = workItem({
    ref: "wi_distinct2",
    title: "Secure sign-off from legal on the vendor contract",
    classification: "accepted_request",
    source_quote: "I'll secure sign-off from legal on the vendor contract.",
    source_segment_ids: [segB]
  });
  const assembled = assemble([item1, item2]);
  assert.equal(assembled.tree.commitments.length, 2, "unrelated deliverables must not be collapsed");
});

// ---------------------------------------------------------------------------
// 8 & 9 -- ephemeral meeting mechanics never survive as top-level commitments (issue #2 fix).
// ---------------------------------------------------------------------------
test("[8] 'open and review the project plan template' does not survive as a top-level commitment", () => {
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
  assert.equal(assembled.tree.commitments.length, 0, "ephemeral template-opening must not become a commitment");
  const decision = assembled.groupDecisions.find((d) => d.disposition !== "added" && d.disposition !== "kept");
  assert.ok(decision, "the group must be rejected with a logged, auditable reason");
  assert.equal(
    assembled.tree.completed_work?.length,
    1,
    "the underlying moment is preserved as lifecycle/completed history, not silently dropped"
  );
});

test("[9] 'describe intended workflow during the meeting' does not survive as a top-level commitment", () => {
  const narration = workItem({
    ref: "wi_described_workflow",
    title: "Describe the intended user workflow from Kevin's perspective",
    classification: "idea",
    scope_state: "informational",
    work_item_role: "status_update",
    source_segment_ids: [segA]
  });
  const zeroTaskGroup = group({
    title: "Describe the intended user workflow from Kevin's perspective",
    group_basis: "explicit_zero_task_outcome",
    member_refs: [],
    explicit_outcome_evidence: {
      source_quote: "So let me describe the intended user workflow from Kevin's perspective.",
      source_segment_ids: [segA]
    }
  });
  const assembled = assemble([narration], [], [zeroTaskGroup]);
  assert.equal(assembled.tree.commitments.length, 0);
});

// ---------------------------------------------------------------------------
// 10 -- legitimate completed/forward deliverables are never globally suppressed.
// ---------------------------------------------------------------------------
test("[10] a real zero-task deliverable with no completed/informational overlap still survives", () => {
  const openPromise = workItem({
    ref: "wi_open_promise",
    title: "Personally finalize the vendor renewal directly",
    classification: "promise",
    status: "open",
    source_segment_ids: [segA]
  });
  const zeroTaskGroup = group({
    title: "Finalize the vendor renewal directly",
    owner: "Aditya",
    group_basis: "explicit_zero_task_outcome",
    member_refs: [],
    explicit_outcome_evidence: {
      source_quote: "I'll just finalize the vendor renewal directly, no need to break it into tasks.",
      source_segment_ids: [segA]
    }
  });
  const assembled = assemble([openPromise], [], [zeroTaskGroup]);
  assert.equal(assembled.tree.commitments.length, 1, "a genuine forward-looking zero-task outcome must survive");
});

test("[10b] a zero-task outcome with a real due date survives even when it overlaps a completed item", () => {
  const completedMoment = workItem({
    ref: "wi_completed_but_dated",
    title: "Send the finished draft to the client",
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    source_segment_ids: [segA]
  });
  const zeroTaskGroup = group({
    title: "Send the finished draft to the client",
    owner: "Aditya",
    group_basis: "explicit_zero_task_outcome",
    member_refs: [],
    due_date: "2026-11-01",
    explicit_outcome_evidence: {
      source_quote: "I sent the finished draft to the client.",
      source_segment_ids: [segA]
    }
  });
  const assembled = assemble([completedMoment], [], [zeroTaskGroup]);
  assert.equal(assembled.tree.commitments.length, 1, "a resolved due date overrides the ephemeral-moment check");
});

// ---------------------------------------------------------------------------
// 11 -- the main Phase-1 commitment retains provenance for every material criterion (issue #4 fix).
// ---------------------------------------------------------------------------
test("[11] the main Phase-1 commitment retains traceable evidence for every acceptance criterion", () => {
  const mainTask = workItem({
    ref: "wi_main_task",
    title: "Build the 30-second talking-head generation pipeline",
    source_segment_ids: [segA]
  });
  const criterion1 = workItem({
    ref: "wi_crit_duration",
    title: "Output must be a 30-second talking-head clip",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: [],
    source_segment_ids: [segB]
  });
  const criterion2 = workItem({
    ref: "wi_crit_tryagain",
    title: "Try Again must regenerate with a revised prompt",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: [],
    source_segment_ids: [segC]
  });
  const criterion3 = workItem({
    ref: "wi_crit_cost",
    title: "Must surface a generation-cost estimate before retrying",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: [],
    source_segment_ids: [segD]
  });
  const verified = group({
    title: "Phase-1 talking-head generation product",
    owner: "Aditya",
    group_basis: "explicit_deliverable",
    member_refs: ["wi_main_task"],
    acceptance_criteria_refs: ["wi_crit_duration", "wi_crit_tryagain", "wi_crit_cost"],
    explicit_outcome_evidence: null
  });
  const assembled = assemble(
    [mainTask, criterion1, criterion2, criterion3],
    [],
    [verified]
  );
  assert.equal(assembled.tree.commitments.length, 1);
  const graph = treeToExecutionGraph(assembled.tree);
  const persisted = graph.commitments[0];
  assert.ok(persisted.source_segment_ids.includes(segA), "task evidence");
  assert.ok(persisted.source_segment_ids.includes(segB), "30-second duration criterion evidence");
  assert.ok(persisted.source_segment_ids.includes(segC), "Try Again criterion evidence");
  assert.ok(persisted.source_segment_ids.includes(segD), "cost-estimate criterion evidence");
  assert.ok(persisted.supporting_action_refs?.includes("wi_crit_duration"));
  assert.ok(persisted.supporting_action_refs?.includes("wi_crit_tryagain"));
  assert.ok(persisted.supporting_action_refs?.includes("wi_crit_cost"));
});

// ---------------------------------------------------------------------------
// 12 -- Kevin's lighting-control chip commitment remains intact.
// ---------------------------------------------------------------------------
test("[12] Kevin's lighting-control chip commitment remains intact and correctly owned", () => {
  const item = workItem({
    ref: "wi_lighting",
    title: "Source the lighting-control chip for the rig",
    classification: "accepted_request",
    owner: "Kevin",
    owners: ["Kevin"]
  });
  const assembled = assemble([item]);
  const recovered = assembled.tree.commitments.find((c) => c.member_refs.includes("wi_lighting"));
  assert.ok(recovered, "lighting-control chip must survive as its own commitment");
  assert.equal(recovered?.owner, "Kevin");
  const graph = treeToExecutionGraph(assembled.tree);
  const persisted = graph.commitments.find((c) => c.client_ref === recovered!.ref);
  assert.equal(persisted?.owner, "Kevin");
});
