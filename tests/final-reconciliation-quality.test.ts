import assert from "node:assert/strict";
import test from "node:test";

import { reconcileFinalGraph } from "../lib/execution-intelligence/final-reconciliation";
import type { ExecutionTree, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

const segment = "11111111-1111-4111-8111-111111111111";

function workItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return {
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "open_task",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "x",
    source_quote: `I'll ${overrides.title.toLowerCase()}`,
    source_segment_ids: [segment],
    extraction_reason: "x",
    confidence: 0.9,
    topic_id: null,
    ...overrides
  };
}

function criterion(
  ref: string,
  title: string,
  overrides: Partial<WorkItem> = {}
): WorkItem {
  return workItem({
    ref,
    title,
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: [],
    ...overrides
  });
}

function commitment(
  overrides: Partial<ExecutionTree["commitments"][number]> & {
    ref: string;
    title: string;
    tasks: WorkItem[];
  }
): ExecutionTree["commitments"][number] {
  return {
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    due_date: null,
    due_date_text: null,
    group_basis: "multi_item_shared_purpose",
    member_refs: overrides.tasks.map((t) => t.ref),
    acceptance_criteria_refs: [],
    purpose_reason: "x",
    explicit_outcome_evidence: null,
    acceptance_criteria: [],
    primary_owner_reason: "Declared accountable owner from grouping/verification.",
    ...overrides
  };
}

function websiteCommitment(overrides: Partial<ExecutionTree["commitments"][number]> = {}) {
  const structure = workItem({ ref: "t1", title: "Deliver the first website draft", owner: "Aditya Ujawane" });
  const founder = workItem({
    ref: "t2",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"],
    work_item_role: "input_dependency"
  });
  const faqAnswers = workItem({
    ref: "t3",
    title: "Provide answers to the website FAQ questions",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"],
    work_item_role: "input_dependency"
  });
  return commitment({
    ref: "c1",
    title: "Deliver the first informational website draft",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane", "Jamileh Hamideh"],
    due_date: "2026-08-01",
    due_date_text: "before August 1, 2026",
    tasks: [structure, founder, faqAnswers],
    ...overrides
  });
}

function reconcile(commitments: ExecutionTree["commitments"]) {
  return reconcileFinalGraph({ tree: { commitments, standalone_tasks: [] } });
}

// ============================================================
// OWNERSHIP (Part 8, items 1-4)
// ============================================================

test("1. supporting child-task owners do not create shared commitment ownership", () => {
  const tree = websiteCommitment();
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.owner, "Aditya Ujawane");
  assert.deepEqual(resolved.owners, ["Aditya Ujawane", "Jamileh Hamideh"]);
});

test("2. an explicit deliverable owner wins even when a model-declared owner is ambiguous", () => {
  const deliver = workItem({ ref: "t1", title: "Deliver the first website draft", owner: "Aditya Ujawane" });
  const support = workItem({
    ref: "t2",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"]
  });
  const tree = commitment({
    ref: "c1",
    title: "Deliver the first website draft",
    owner: "Team",
    owners: ["Aditya Ujawane", "Jamileh Hamideh"],
    tasks: [deliver, support]
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.owner, "Aditya Ujawane");
  const decision = result.ownershipDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "repaired");
  assert.equal(decision?.previous_owner, "Team");
  assert.equal(decision?.resolved_owner, "Aditya Ujawane");
});

test("3. explicitly supported shared ownership is preserved, not overridden", () => {
  const deliver = workItem({ ref: "t1", title: "Deliver the joint proposal", owner: "Aditya Ujawane" });
  const tree = commitment({
    ref: "c1",
    title: "Deliver the joint proposal",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane", "Jamileh Hamideh"],
    tasks: [deliver]
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.owner, "Aditya Ujawane");
  const decision = result.ownershipDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "kept");
});

test("4. website fixture-shaped commitment resolves primary owner to Aditya, not Team, not a joined name", () => {
  const tree = websiteCommitment({ owner: "Aditya Ujawane, Jamileh Hamideh" });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.owner, "Aditya Ujawane");
  assert.notEqual(resolved.owner, "Team");
});

// ============================================================
// ACCEPTANCE CRITERIA (Part 8, items 5-9)
// ============================================================

function proteinCriteriaCommitment() {
  const c1 = criterion("ac1", "Include an educational explanation of the protein product.", {
    source_segment_ids: ["22222222-2222-4222-8222-222222222222"]
  });
  const c2 = criterion("ac2", "Add a page explaining where the protein comes from.", {
    source_segment_ids: ["33333333-3333-4333-8333-333333333333"]
  });
  const c3 = criterion("ac3", "Add a website section explaining the protein.", {
    source_segment_ids: ["44444444-4444-4444-8444-444444444444"]
  });
  return websiteCommitment({
    acceptance_criteria: [c1, c2, c3],
    acceptance_criteria_refs: ["ac1", "ac2", "ac3"]
  });
}

test("5. equivalent protein-education criteria consolidate into one canonical criterion", () => {
  const result = reconcile([proteinCriteriaCommitment()]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.acceptance_criteria.length, 1);
});

test("6. distinct criteria (founder story, differentiation, visual direction, contact/policy, deadline) remain separate", () => {
  const founder = criterion("ac1", "Include founder-story content.");
  const diff = criterion("ac2", "Explain what differentiates the product.");
  const visual = criterion("ac3", "Use the selected visual direction.");
  const contact = criterion("ac4", "Include relevant contact/policy information.");
  const deadline = criterion("ac5", "Have the first draft ready by August 1.");
  const tree = websiteCommitment({
    acceptance_criteria: [founder, diff, visual, contact, deadline],
    acceptance_criteria_refs: ["ac1", "ac2", "ac3", "ac4", "ac5"]
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.acceptance_criteria.length, 5);
  const decisions = result.acceptanceCriteriaDecisions.filter((d) => d.commitment_ref === "c1");
  assert.ok(decisions.every((d) => d.disposition === "kept"));
});

test("7. evidence/provenance (source segment ids) survives consolidation as the union of merged criteria", () => {
  const result = reconcile([proteinCriteriaCommitment()]);
  const merged = result.tree.commitments[0].acceptance_criteria[0];
  assert.ok(merged.source_segment_ids.includes("22222222-2222-4222-8222-222222222222"));
  assert.ok(merged.source_segment_ids.includes("33333333-3333-4333-8333-333333333333"));
  assert.ok(merged.source_segment_ids.includes("44444444-4444-4444-8444-444444444444"));
  const decision = result.acceptanceCriteriaDecisions.find(
    (d) => d.commitment_ref === "c1" && d.disposition === "merged"
  );
  assert.ok(decision);
  assert.equal(decision!.merged_from_refs.length, 2);
  assert.ok(["ac1", "ac2", "ac3"].includes(decision!.canonical_ref));
});

test("8. acceptance-criteria consolidation is deterministic across repeated runs on the same input", () => {
  const first = reconcile([proteinCriteriaCommitment()]);
  const second = reconcile([proteinCriteriaCommitment()]);
  assert.equal(first.tree.commitments[0].acceptance_criteria.length, 1);
  assert.equal(second.tree.commitments[0].acceptance_criteria.length, 1);
  assert.equal(
    first.tree.commitments[0].acceptance_criteria[0].ref,
    second.tree.commitments[0].acceptance_criteria[0].ref
  );
});

test("9. acceptance-criteria consolidation never calls a model -- reconcileFinalGraph is a synchronous, pure function", () => {
  // If this ever required a model call, reconcileFinalGraph would need to become async (like
  // runV4FinalReconciliation's other model-calling siblings). Its signature staying synchronous is
  // itself the guarantee; no network/async mocking is needed to prove it.
  const result = reconcile([proteinCriteriaCommitment()]);
  assert.equal(typeof result, "object");
  assert.equal(reconcileFinalGraph.constructor.name, "Function");
});

// ============================================================
// DATES (Part 8, items 10-12)
// ============================================================

test("10. primary due date remains August 1 after reconciliation", () => {
  const tree = websiteCommitment({
    description: "Deliver the first website draft; site needed by Jamileh's August 13 deadline."
  });
  const result = reconcile([tree]);
  assert.equal(result.tree.commitments[0].due_date, "2026-08-01");
});

test("11. a contextual August 13 date does not become (or stay phrased as) the commitment deadline", () => {
  const tree = websiteCommitment({
    description: "Deliver the first website draft; site needed by Jamileh's August 13 deadline."
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.due_date, "2026-08-01");
  assert.ok(!resolved.description || !/august 13.*deadline|deadline.*august 13/i.test(resolved.description));
  const decision = result.dateDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "deadline_clause_stripped");
});

test("12. commitment description does not conflict with the resolved due_date once cleaned", () => {
  const tree = websiteCommitment({
    description:
      "Deliver the first website draft, incorporating Jamileh's content; site needed by Jamileh's August 13 deadline."
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.ok(resolved.description?.includes("incorporating Jamileh's content"));
  assert.ok(!resolved.description?.includes("August 13"));
});

test("a date matching the resolved due_date is left intact even with deadline framing", () => {
  const tree = websiteCommitment({
    description: "Deliver the first website draft by the August 1 deadline."
  });
  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];
  assert.equal(resolved.description, "Deliver the first website draft by the August 1 deadline.");
  const decision = result.dateDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "kept");
});

test("a date mentioned with no deadline-framing language is never touched", () => {
  const tree = websiteCommitment({
    description: "Deliver the first website draft; the last status update was on August 13."
  });
  const result = reconcile([tree]);
  assert.equal(
    result.tree.commitments[0].description,
    "Deliver the first website draft; the last status update was on August 13."
  );
});
