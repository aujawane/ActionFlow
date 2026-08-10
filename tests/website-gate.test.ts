import assert from "node:assert/strict";
import test from "node:test";

import { evaluateWebsiteGate } from "../lib/execution-intelligence/gates/website-gate";
import type { ExecutionTree, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

const segment = "11111111-1111-4111-8111-111111111111";

function task(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
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
    source_quote: "x",
    source_segment_ids: [segment],
    extraction_reason: "x",
    confidence: 0.9,
    topic_id: null,
    ...overrides
  };
}

function criterion(ref: string, title: string): WorkItem {
  return task({ ref, title, work_item_role: "acceptance_criterion", owner: null, owners: [] });
}

function validTree(): ExecutionTree {
  const aditya = [
    task({ ref: "t1", title: "Create the initial informational website structure using placeholders" }),
    task({ ref: "t2", title: "Generate FAQ questions and send them to Jamileh" }),
    task({ ref: "t3", title: "Connect the existing domain to the new deployment" }),
    task({ ref: "t4", title: "Present the first website draft before August 1" })
  ];
  const jamileh = [
    task({ ref: "t5", title: "Draft the founder story", owner: "Jamileh Hamideh", owners: ["Jamileh Hamideh"] }),
    task({
      ref: "t6",
      title: "Answer the FAQ questions supplied by Aditya",
      owner: "Jamileh Hamideh",
      owners: ["Jamileh Hamideh"],
      work_item_role: "input_dependency"
    })
  ];
  return {
    commitments: [
      {
        ref: "c1",
        title: "Build and present the first informational website draft before August 1",
        description: null,
        owner: "Aditya Ujawane",
        owners: ["Aditya Ujawane", "Jamileh Hamideh"],
        due_date: null,
        due_date_text: "before August 1",
        group_basis: "multi_item_shared_purpose",
        member_refs: [...aditya, ...jamileh].map((t) => t.ref),
        acceptance_criteria_refs: ["ac1", "ac2"],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [...aditya, ...jamileh],
        acceptance_criteria: [
          criterion("ac1", "Present protein bars and protein powder"),
          criterion("ac2", "Use the discussed pastel green and violet visual direction")
        ],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };
}

function gate(tree: ExecutionTree) {
  return evaluateWebsiteGate({ tree, futureScopeItems: [], excludedWorkItems: [] });
}

test("Website gate: passes on a well-formed tree with one commitment, correct owners, and acceptance criteria", () => {
  const result = gate(validTree());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("Website gate: fails when there is more than one active commitment", () => {
  const tree = validTree();
  tree.commitments.push({ ...tree.commitments[0], ref: "c2", title: "Connect the domain" });
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "one_primary_commitment"));
});

test("Website gate: fails when the owner is Team instead of Aditya", () => {
  const tree = validTree();
  tree.commitments[0] = { ...tree.commitments[0], owner: "Team" };
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "owner_not_team"));
  assert.ok(result.failures.some((f) => f.rule === "primary_owner_aditya"));
});

test("Website gate: fails when Jamileh has no child tasks under the commitment", () => {
  const tree = validTree();
  tree.commitments[0] = {
    ...tree.commitments[0],
    tasks: tree.commitments[0].tasks.filter((t) => t.owner !== "Jamileh Hamideh")
  };
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "jamileh_child_tasks_present"));
});

test("Website gate: fails when there are zero acceptance criteria", () => {
  const tree = validTree();
  tree.commitments[0] = { ...tree.commitments[0], acceptance_criteria: [] };
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "acceptance_criteria_present"));
});

test("Website gate: fails when domain connection becomes its own peer commitment", () => {
  const tree = validTree();
  tree.commitments.push({
    ...tree.commitments[0],
    ref: "c-domain",
    title: "Connect the domain to the new deployment",
    tasks: []
  });
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_peer_commitment_for_component"));
});

test("Website gate: fails when FAQ preparation becomes its own peer commitment", () => {
  const tree = validTree();
  tree.commitments.push({ ...tree.commitments[0], ref: "c-faq", title: "Prepare the FAQ content", tasks: [] });
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_peer_commitment_for_component"));
});

test("Website gate: fails when e-commerce checkout leaks into the active tree", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Build full e-commerce checkout and ordering" }));
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "future_scope_not_active"));
});

test("Website gate: fails when customer accounts/login leaks into the active tree", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Add customer accounts and login/signup" }));
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "future_scope_not_active"));
});

test("Website gate: fails on the manufactured 'Use an ecommerce website' task", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Use an ecommerce website" }));
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_use_an_ecommerce_website_task"));
});

test("Website gate: fails on an unsupported email migration task", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Migrate the email service to a new provider" }));
  const result = gate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_unsupported_email_migration"));
});

test("Website gate: zero standalone tasks is valid and produces no failures or required notes", () => {
  const result = gate(validTree());
  assert.equal(result.ok, true);
  assert.equal(result.notes.some((n) => n.includes("standalone task(s) present")), false);
});
