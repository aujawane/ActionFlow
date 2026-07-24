import assert from "node:assert/strict";
import test from "node:test";

import { normalizeExecutionGraphQuality } from "../lib/execution-intelligence/normalization";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";

const segmentA = "11111111-1111-4111-8111-111111111111";
const segmentB = "22222222-2222-4222-8222-222222222222";

function commitment(
  overrides: Partial<CommitmentCandidate> = {}
): CommitmentCandidate {
  return {
    client_ref: "c1",
    topic_id: null,
    title: "Launch AI search",
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: "We should launch AI search.",
    source_segment_ids: [segmentA],
    evidence_source: "transcript",
    type: "team",
    completion_state: "open",
    ...overrides
  };
}

function task(overrides: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    client_ref: "t1",
    commitment_ref: "c1",
    topic_id: null,
    title: "Implement AI search",
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: "We should launch AI search.",
    source_segment_ids: [segmentA],
    evidence_source: "transcript",
    inferred: false,
    task_type: "commitment",
    workspace_type: "coding",
    suggested_steps: [],
    ...overrides
  };
}

test("merges cross-topic ownership clarification into broad commitment", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({ title: "Launch AI search project" }),
      commitment({
        client_ref: "c2",
        title: "Own backend development for AI search",
        owner: "B",
        owners: ["B"],
        source_quote: "I'll own the backend for that.",
        source_segment_ids: [segmentB],
        type: "personal"
      })
    ],
    tasks: [
      task({
        client_ref: "t2",
        commitment_ref: "c2",
        title: "Own backend development for AI search",
        owner: "B",
        owners: ["B"],
        source_quote: "I'll own the backend for that.",
        source_segment_ids: [segmentB]
      })
    ]
  };

  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.commitments[0].title, "Launch AI search project");
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, "c1");
  assert.match(result.graph.tasks[0].title, /^Implement .*backend/i);
  assert.equal(result.graph.tasks[0].owner, "B");
  assert.equal(result.graph.tasks[0].inferred, true);
});

test("merges one shared action into one multi-owner task", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        title: "Review the PR",
        owner: "Alex",
        owners: ["Alex", "Priya"],
        source_quote: "Priya and I will review the PR."
      })
    ],
    tasks: [
      task({
        title: "Review the PR by Alex",
        owner: "Alex",
        owners: ["Alex"],
        source_quote: "Priya and I will review the PR."
      }),
      task({
        client_ref: "t2",
        title: "Review the PR by Priya",
        owner: "Priya",
        owners: ["Priya"],
        source_quote: "Priya and I will review the PR."
      })
    ]
  };

  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].title, "Review the PR");
  assert.equal(result.graph.tasks[0].owner, "Alex");
  assert.deepEqual(result.graph.tasks[0].owners, ["Alex", "Priya"]);
  assert.equal(result.mergedGroupTasks, 1);
});

test("rejects an ownership restatement when no safe task can be inferred", () => {
  const graph: ExecutionGraph = {
    commitments: [commitment({ title: "Own customer success" })],
    tasks: [task({ title: "Take ownership of customer success" })]
  };
  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 0);
  assert.equal(result.removedOwnershipTasks, 1);
});

test("converts QA ownership restatement to concrete inferred work", () => {
  const graph: ExecutionGraph = {
    commitments: [commitment({ title: "Assign QA ownership to Jordan" })],
    tasks: [
      task({
        title: "Jordan to assume QA responsibilities",
        owner: "Jordan",
        owners: ["Jordan"]
      })
    ]
  };
  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.tasks[0].title, "Run QA");
  assert.equal(result.graph.tasks[0].inferred, true);
  assert.equal(result.graph.tasks[0].evidence_source, "inferred");
});

test("preserves event-relative timing on linked tasks", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        title: "Publish after launch",
        due_date_text: "after launch",
        source_quote: "I'll publish it after launch."
      })
    ],
    tasks: [
      task({
        title: "Publish it",
        due_date_text: null,
        source_quote: "I'll publish it after launch."
      })
    ]
  };
  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.tasks[0].due_date_text, "after launch");
  assert.equal(result.graph.tasks[0].title, "Publish it after launch");
});

test("splits an explicit approval blocker from the dependent action", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        title: "Ship the update once security approves",
        owner: "Sarah",
        owners: ["Sarah"],
        source_quote: "I'll ship the update once security approves."
      })
    ],
    tasks: [
      task({
        title: "Ship the update after receiving security approval",
        owner: "Sarah",
        owners: ["Sarah"],
        source_quote: "I'll ship the update once security approves."
      })
    ]
  };
  const result = normalizeExecutionGraphQuality(graph);
  assert.equal(result.graph.tasks.length, 2);
  assert.ok(result.graph.tasks.some((item) => item.title === "Ship the update"));
  const blocker = result.graph.tasks.find(
    (item) => item.title === "Get security approval"
  );
  assert.ok(blocker);
  assert.equal(blocker.owner, null);
  assert.equal(blocker.commitment_ref, "c1");
});

test("commitment may legally remain without tasks", () => {
  const result = normalizeExecutionGraphQuality({
    commitments: [commitment({ title: "Explore future options" })],
    tasks: []
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 0);
});
