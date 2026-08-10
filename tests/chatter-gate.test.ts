import assert from "node:assert/strict";
import test from "node:test";

import { evaluateChatterGate } from "../lib/execution-intelligence/gates/chatter-gate";
import type { ExecutionTree, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

const segment = "11111111-1111-4111-8111-111111111111";

function task(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return {
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
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

function commitment(
  overrides: Partial<ExecutionTree["commitments"][number]> & {
    ref: string;
    title: string;
    tasks: WorkItem[];
  }
): ExecutionTree["commitments"][number] {
  return {
    description: null,
    owner: null,
    owners: [],
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

function validTree(): ExecutionTree {
  const vercelTask = task({ ref: "t1", title: "Deploy Parfait to Vercel before next Tuesday" });
  const chatterTask1 = task({ ref: "t2", title: "Create initial Chatter session using last week's transcript", owner: "Laura" });
  const chatterTask2 = task({ ref: "t3", title: "Test whether Chatter can process transcript/CSV input", owner: "Laura" });
  const enterpriseTask = task({ ref: "t4", title: "Contact OpenAI sales about enterprise account" });
  return {
    commitments: [
      commitment({
        ref: "c1",
        title: "Deliver Parfait for internal team use before next Tuesday",
        group_basis: "explicit_deliverable",
        tasks: [vercelTask]
      }),
      commitment({
        ref: "c2",
        title: "Validate Chatter using real Parfait meeting context",
        tasks: [chatterTask1, chatterTask2]
      }),
      commitment({
        ref: "c3",
        title: "Establish or clarify enterprise OpenAI/Codex access",
        tasks: [enterpriseTask]
      })
    ],
    standalone_tasks: [task({ ref: "t5", title: "Continue following up with Cursor support" })]
  };
}

test("Chatter gate: passes on a well-formed tree with the three required commitments", () => {
  const result = evaluateChatterGate(validTree());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("Chatter gate: fails when a required commitment is missing entirely", () => {
  const tree = validTree();
  tree.commitments = tree.commitments.filter((c) => c.ref !== "c3");
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "required_commitment_present" && /enterprise/i.test(f.detail)));
});

test("Chatter gate: fails when Vercel and Chatter are conflated into one commitment", () => {
  const tree = validTree();
  const merged = {
    ...tree.commitments[0],
    title: "Deliver Parfait before next Tuesday and validate Chatter using real Parfait meeting context",
    tasks: [...tree.commitments[0].tasks, ...tree.commitments[1].tasks]
  };
  tree.commitments = [merged, tree.commitments[2]];
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "commitments_not_conflated"));
});

test("Chatter gate: fails on an unsupported AI loop-engineering commitment with no accepted-deliverable evidence", () => {
  const tree = validTree();
  tree.commitments.push(
    commitment({
      ref: "c4",
      title: "Build development capability through AI loop-engineering experiments",
      tasks: [
        task({
          ref: "t9",
          title: "Explore loop-engineering patterns",
          work_item_role: "idea",
          acceptance_state: "proposed",
          execution_scope: "informational"
        })
      ]
    })
  );
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_unsupported_strategic_commitment"));
});

test("Chatter gate: allows a strategic-sounding commitment when it has real accepted-deliverable evidence", () => {
  const tree = validTree();
  tree.commitments.push(
    commitment({
      ref: "c4",
      title: "Build and demonstrate a ticket-to-review agent loop",
      tasks: [
        task({
          ref: "t9",
          title: "Ship the ticket-to-review agent loop demo by Friday",
          work_item_role: "action",
          acceptance_state: "accepted",
          execution_scope: "project_work"
        })
      ]
    })
  );
  const result = evaluateChatterGate(tree);
  assert.equal(
    result.failures.some((f) => f.rule === "no_unsupported_strategic_commitment"),
    false
  );
});

test("Chatter gate: fails when a task appears as both a commitment child and standalone", () => {
  const tree = validTree();
  tree.standalone_tasks.push(tree.commitments[1].tasks[0]);
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_child_also_standalone"));
});

test("Chatter gate: fails when the Vercel explicit_deliverable commitment loses its only child", () => {
  const tree = validTree();
  tree.commitments[0] = { ...tree.commitments[0], tasks: [] };
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "vercel_commitment_not_emptied"));
});

test("Chatter gate: fails when personal logistics (Laura's birthday) leaks into the active tree", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Plan Laura's 21st birthday family party" }));
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_personal_logistics"));
});

test("Chatter gate: fails when already-completed work appears as a pending item", () => {
  const tree = validTree();
  tree.standalone_tasks.push(task({ ref: "t9", title: "Craig gave you credentials for the deployment" }));
  const result = evaluateChatterGate(tree);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.rule === "no_completed_work_as_pending"));
});
