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
    primary_owner_reason: "x",
    ...overrides
  };
}

function websiteTree(standaloneExtra: WorkItem[] = []): ExecutionTree {
  const structure = workItem({ ref: "t1", title: "Create the structured website using placeholders" });
  const faq = workItem({ ref: "t2", title: "Generate FAQ questions and send them to Jamileh" });
  const domainConnect = workItem({ ref: "t3", title: "Connect the existing Naviva Foods domain" });
  const presentDraft = workItem({ ref: "t4", title: "Present the first website draft" });
  const founderStory = workItem({
    ref: "t5",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"],
    work_item_role: "input_dependency"
  });
  return {
    commitments: [
      commitment({
        ref: "c1",
        title: "Deliver and present the first website draft",
        owner: "Aditya Ujawane",
        owners: ["Aditya Ujawane", "Jamileh Hamideh"],
        tasks: [structure, faq, domainConnect, presentDraft, founderStory]
      })
    ],
    standalone_tasks: standaloneExtra
  };
}

// ============================================================
// Unsupported-scope description validation (Part 5 / test 6, 20, 22)
// ============================================================

test("6/20/22. an email address mention does not survive as email-service scope in the surviving commitment's description", () => {
  const tree = websiteTree();
  tree.commitments[0] = {
    ...tree.commitments[0],
    description:
      "Deliver the first website draft. Also configure mail hosting and migrate the email provider since Jamileh's email is jamileh@navivafoods.com."
  };
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.commitments[0].description, null);
  const decision = result.commitmentDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "description_stripped");
});

test("21. a description that only discusses the supported domain-connection work is left intact", () => {
  const tree = websiteTree();
  tree.commitments[0] = {
    ...tree.commitments[0],
    description: "Deliver the first website draft, connecting the existing Naviva Foods domain to the deployment."
  };
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.commitments[0].description, tree.commitments[0].description);
  const decision = result.commitmentDecisions.find((d) => d.commitment_ref === "c1");
  assert.equal(decision?.disposition, "kept");
});

test("a description mentioning 'email' only to say a message was sent (not infrastructure) is not stripped", () => {
  const tree = websiteTree();
  tree.commitments[0] = {
    ...tree.commitments[0],
    description: "Deliver the first website draft; Aditya will email Jamileh once it is ready."
  };
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.commitments[0].description, tree.commitments[0].description);
});

// ============================================================
// Duplicate standalone absorption (Part 2 duplicate-standalone rule / tests 13, 14)
// ============================================================

test("13/14. a standalone 'present the draft asap' task duplicating the commitment is absorbed, and its evidence is preserved in the decision trace", () => {
  const duplicate = workItem({
    ref: "t9",
    title: "Present the first draft as soon as possible",
    source_quote: "I'll present the first draft as soon as possible",
    source_segment_ids: ["22222222-2222-4222-8222-222222222222"]
  });
  const tree = websiteTree([duplicate]);
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.standalone_tasks.length, 0);
  const decision = result.standaloneDecisions.find((d) => d.task_ref === "t9");
  assert.notEqual(decision?.disposition, "keep_standalone");
  assert.equal(decision?.removed_source_quote, "I'll present the first draft as soon as possible");
  assert.deepEqual(decision?.removed_source_segment_ids, ["22222222-2222-4222-8222-222222222222"]);
});

test("a standalone task duplicating a specific child task (not the commitment title) is absorbed into that child, merging segment ids", () => {
  const duplicate = workItem({
    ref: "t9",
    title: "Connect the domain to the deployment",
    source_segment_ids: ["33333333-3333-4333-8333-333333333333"]
  });
  const tree = websiteTree([duplicate]);
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.standalone_tasks.length, 0);
  const decision = result.standaloneDecisions.find((d) => d.task_ref === "t9");
  assert.equal(decision?.disposition, "duplicate_child");
  assert.equal(decision?.matched_ref, "t3");
  const survivingDomainTask = result.tree.commitments[0].tasks.find((t) => t.ref === "t3");
  assert.ok(survivingDomainTask?.source_segment_ids.includes("33333333-3333-4333-8333-333333333333"));
});

test("15. a genuinely distinct standalone task (Cursor follow-up) is kept, not absorbed", () => {
  const distinct = workItem({ ref: "t9", title: "Continue following up with Cursor support" });
  const tree = websiteTree([distinct]);
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "t9");
  const decision = result.standaloneDecisions.find((d) => d.task_ref === "t9");
  assert.equal(decision?.disposition, "keep_standalone");
});

test("zero standalone tasks is valid and produces zero decisions needing absorption", () => {
  const tree = websiteTree([]);
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.standaloneDecisions.length, 0);
});

test("commitment containment / structure is untouched by reconciliation when nothing is wrong", () => {
  const tree = websiteTree();
  const result = reconcileFinalGraph({ tree });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 5);
});
