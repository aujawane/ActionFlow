import assert from "node:assert/strict";
import test from "node:test";

import { consolidateExecutionGraph } from "../lib/execution-intelligence/consolidation";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";
import {
  isCommittedWork,
  partitionExecutionGraph
} from "../lib/execution-display";
import type { MeetingCommitment, MeetingTask } from "../lib/types";

const segmentA = "11111111-1111-4111-8111-111111111111";
const segmentB = "22222222-2222-4222-8222-222222222222";

function commitment(
  overrides: Partial<CommitmentCandidate> & Pick<CommitmentCandidate, "client_ref" | "title">
): CommitmentCandidate {
  return {
    topic_id: null,
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: overrides.title,
    source_segment_ids: [segmentA],
    evidence_source: "transcript",
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    consolidated_from_refs: [],
    ...overrides
  };
}

function task(
  overrides: Partial<TaskCandidate> & Pick<TaskCandidate, "client_ref" | "title">
): TaskCandidate {
  return {
    commitment_ref: null,
    topic_id: null,
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: overrides.title,
    source_segment_ids: [segmentA],
    evidence_source: "transcript",
    inferred: false,
    task_type: "commitment",
    workspace_type: "document",
    suggested_steps: [],
    execution_classification: "committed",
    consolidated_from_refs: [],
    ...overrides
  };
}

test("duplicate founder-story tasks merge into one", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        client_ref: "c1",
        title: "Publish founder story on the website"
      })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Draft founder story text for website"
      }),
      task({
        client_ref: "t2",
        commitment_ref: "c1",
        title: "Draft the founder story text for website inclusion",
        source_segment_ids: [segmentA, segmentB]
      })
    ]
  };

  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.tasks.length, 1);
  assert.ok(result.mergedTasks >= 1);
});

test("three wireframe phrasings merge into one task", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({ client_ref: "c1", title: "Build the company website" })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Create website wireframe design"
      }),
      task({
        client_ref: "t2",
        commitment_ref: "c1",
        title: "Design website wireframe focusing on straightforward and clean layout"
      }),
      task({
        client_ref: "t3",
        commitment_ref: "c1",
        title: "Design wireframe with straightforward and clean layout"
      })
    ]
  };

  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.tasks.length, 1);
  assert.ok(result.mergedTasks >= 2);
});

test("FAQ restatement task is rejected leaving zero child tasks", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        client_ref: "c1",
        title: "Create FAQ page and chatbot support"
      })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Create FAQ page and chatbot support"
      })
    ]
  };

  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 0);
  assert.equal(result.rejectedRestatements, 1);
});

test("auth UI backend and testing remain distinct under one commitment", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({ client_ref: "c1", title: "Ship authentication for the website" })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Design login and signup UI"
      }),
      task({
        client_ref: "t2",
        commitment_ref: "c1",
        title: "Implement authentication backend"
      }),
      task({
        client_ref: "t3",
        commitment_ref: "c1",
        title: "Test authentication flows",
        inferred: true,
        evidence_source: "inferred"
      })
    ]
  };

  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.tasks.length, 2);
  assert.ok(
    result.graph.tasks.every((item) =>
      /ui|backend/i.test(item.title)
    )
  );
});

test("instagram without agreement becomes future consideration", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        client_ref: "c1",
        title: "Add Instagram integration",
        execution_classification: "future_consideration",
        owner: null,
        owners: []
      })
    ],
    tasks: []
  };
  const result = consolidateExecutionGraph(graph);
  assert.equal(
    result.graph.commitments[0].execution_classification,
    "future_consideration"
  );
});

test("required product page without owner becomes requirement", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        client_ref: "c1",
        title: "Create product display pages",
        execution_classification: "requirement",
        owner: null,
        owners: []
      })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Build product page templates",
        execution_classification: "committed"
      })
    ]
  };
  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.commitments[0].execution_classification, "requirement");
  assert.equal(result.graph.tasks[0]?.execution_classification, "requirement");
});

test("clear personal promise remains committed and may have zero tasks", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({
        client_ref: "c1",
        title: "Send pricing deck to the client",
        source_quote: "I'll send the pricing deck tomorrow."
      })
    ],
    tasks: []
  };
  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 0);
  assert.equal(result.graph.commitments[0].execution_classification, "committed");
});

test("standalone task remains standalone when no commitment fits", () => {
  const graph: ExecutionGraph = {
    commitments: [],
    tasks: [
      task({
        client_ref: "t1",
        title: "Email the vendor about packaging images"
      })
    ]
  };
  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, null);
});

test("partition separates ideas from execution work for UI and follow-ups", () => {
  const commitments = [
    {
      id: "c1",
      execution_classification: "committed"
    },
    {
      id: "c2",
      execution_classification: "requirement"
    }
  ] as MeetingCommitment[];
  const tasks = [
    {
      id: "t1",
      commitment_id: "c1",
      execution_classification: "committed",
      status: "completed"
    },
    {
      id: "t2",
      commitment_id: null,
      execution_classification: "committed",
      status: "pending"
    },
    {
      id: "t3",
      commitment_id: null,
      execution_classification: "proposed",
      status: "pending"
    }
  ] as MeetingTask[];

  const partitioned = partitionExecutionGraph({ commitments, tasks });
  assert.equal(partitioned.activeCommitments.length, 1);
  assert.equal(partitioned.executionTasks.length, 2);
  assert.equal(partitioned.standaloneTasks.length, 1);
  assert.equal(partitioned.ideaTasks.length, 1);
  assert.equal(isCommittedWork(tasks[2]), false);
});

test("generic inferred planning tasks are removed", () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment({ client_ref: "c1", title: "Launch marketing site" })
    ],
    tasks: [
      task({
        client_ref: "t1",
        commitment_ref: "c1",
        title: "Research competitor websites",
        inferred: true,
        evidence_source: "inferred"
      }),
      task({
        client_ref: "t2",
        commitment_ref: "c1",
        title: "Write homepage copy"
      })
    ]
  };
  const result = consolidateExecutionGraph(graph);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].title, "Write homepage copy");
  assert.ok(result.removedGenericInferred >= 1);
});
