import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { consolidateExecutionGraph } from "../lib/execution-intelligence/consolidation";
import { matchConvertedCommitments } from "../lib/execution-intelligence/matching";
import type {
  CommitmentCandidate,
  ExecutionGraph
} from "../lib/execution-intelligence/schemas";
import {
  buildCommitmentWorkspaceModel,
  computeProjectProgress,
  selectNextBestTask
} from "../lib/project-execution";
import type {
  MeetingCommitment,
  MeetingTask,
  TaskDependency
} from "../lib/types";

const segmentA = "11111111-1111-4111-8111-111111111111";
const segmentB = "22222222-2222-4222-8222-222222222222";

function candidate(
  clientRef: string,
  title: string,
  overrides: Partial<CommitmentCandidate> = {}
): CommitmentCandidate {
  return {
    client_ref: clientRef,
    topic_id: segmentA,
    title,
    description: null,
    owner: "Jamileh",
    owners: ["Jamileh"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: title,
    source_segment_ids: [segmentA],
    evidence_source: "transcript",
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    consolidated_from_refs: [],
    ...overrides
  };
}

function commitment(
  id: string,
  overrides: Partial<MeetingCommitment> = {}
): MeetingCommitment {
  return {
    id,
    meeting_id: "meeting-1",
    project_id: "project-1",
    topic_id: null,
    title: `Milestone ${id}`,
    description: null,
    owner: "Jamileh",
    owners: ["Jamileh"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: "evidence",
    source_segment_ids: [segmentA],
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    ...overrides
  };
}

function task(id: string, overrides: Partial<MeetingTask> = {}): MeetingTask {
  return {
    id,
    meeting_id: "meeting-1",
    project_id: "project-1",
    topic_id: null,
    commitment_id: "c1",
    task: `Task ${id}`,
    owner: "Jamileh",
    owners: ["Jamileh"],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: "evidence",
    source_segment_ids: [segmentA],
    confidence: 0.9,
    status: "pending",
    due_date: null,
    due_date_text: null,
    inferred: false,
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    position: 0,
    created_at: "2026-07-27T00:00:00Z",
    ...overrides
  };
}

test("narrow commitments consolidate into one milestone and become tasks", () => {
  const graph: ExecutionGraph = {
    commitments: [
      candidate("c1", "Deliver the first website MVP"),
      candidate("c2", "Implement authentication backend", {
        source_segment_ids: [segmentA, segmentB]
      }),
      candidate("c3", "Create login and signup UI")
    ],
    tasks: []
  };
  const result = consolidateExecutionGraph(graph, {
    projectName: "Build Jamileh's Website",
    projectGoal: "Deliver a usable website for Jamileh"
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.convertedCommitments, 2);
  assert.deepEqual(
    new Set(result.graph.tasks.map((item) => item.title)),
    new Set(["Implement authentication backend", "Create login and signup UI"])
  );
  assert.ok(result.graph.tasks.every((item) => item.commitment_ref === "c1"));
  assert.ok(result.graph.commitments[0].source_segment_ids.includes(segmentB));
});

test("unrelated commitments remain separate milestones", () => {
  const graph: ExecutionGraph = {
    commitments: [
      candidate("c1", "Deliver the first website MVP"),
      candidate("c2", "Prepare brand content"),
      candidate("c3", "Launch website to production")
    ],
    tasks: []
  };
  const result = consolidateExecutionGraph(graph, {
    projectName: "Build Jamileh's Website"
  });
  assert.equal(result.graph.commitments.length, 3);
  assert.equal(result.convertedCommitments, 0);
});

test("Jamileh-style graph reduces twelve candidates to five outcome milestones", () => {
  const pairs = [
    ["Define website scope and architecture", "Choose technology stack"],
    ["Prepare brand and content", "Draft founder story content"],
    ["Deliver website MVP", "Implement authentication backend"],
    ["Prepare e-commerce capabilities", "Implement subscription ordering"],
    ["Launch website to production", "Configure production hosting"],
    ["Establish stakeholder coordination", "Confirm UI with stakeholders"]
  ] as const;
  const commitments = pairs.flatMap(([milestone, action], index) => [
    candidate(`c${index + 1}`, milestone, {
      topic_id: `${index + 1}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
      source_segment_ids: [
        `${index + 1}`.padStart(8, "0") + "-2222-4222-8222-222222222222"
      ]
    }),
    candidate(`n${index + 1}`, action, {
      topic_id: `${index + 1}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
      source_segment_ids: [
        `${index + 1}`.padStart(8, "0") + "-2222-4222-8222-222222222222"
      ]
    })
  ]);
  const result = consolidateExecutionGraph(
    { commitments, tasks: [] },
    {
      projectName: "Build Jamileh's Website",
      projectGoal: "Plan, build, and launch Jamileh's website"
    }
  );
  assert.equal(commitments.length, 12);
  assert.equal(result.graph.commitments.length, 5);
  assert.equal(result.graph.tasks.length, 7);
  assert.deepEqual(
    result.graph.commitments.map((item) => item.title),
    pairs.slice(1).map(([milestone]) => milestone)
  );
});

test("project progress uses tasks and zero-task milestone completion", () => {
  const progress = computeProjectProgress({
    commitments: [
      commitment("c1"),
      commitment("c2", { status: "completed" })
    ],
    tasks: [
      task("t1", { commitment_id: "c1", status: "completed" }),
      task("t2", { commitment_id: "c1", status: "pending" })
    ]
  });
  assert.deepEqual(progress, { completed: 2, total: 3, percent: 67 });
});

test("next best task ignores blocked and dependency-blocked work", () => {
  const tasks = [
    task("blocked", { priority: "high", status: "blocked" }),
    task("dependent", { priority: "high" }),
    task("prerequisite", { priority: "medium", status: "pending" }),
    task("ready", { priority: "high", due_date: "2026-07-28" })
  ];
  const dependencies: TaskDependency[] = [
    {
      task_id: "dependent",
      depends_on_task_id: "prerequisite",
      created_at: "2026-07-27T00:00:00Z"
    }
  ];
  const next = selectNextBestTask({
    tasks,
    dependencies,
    commitments: [commitment("c1")],
    today: new Date("2026-07-27T00:00:00Z")
  });
  assert.equal(next?.task.id, "ready");
});

test("commitment workspace includes every child task and traceable evidence", () => {
  const model = buildCommitmentWorkspaceModel({
    commitment: commitment("c1", {
      source_segment_ids: [segmentA]
    }),
    tasks: [
      task("t2", { position: 2, source_segment_ids: [segmentB] }),
      task("t1", { position: 1, source_segment_ids: [segmentA] }),
      task("other", { commitment_id: "other" })
    ]
  });
  assert.deepEqual(model.tasks.map((item) => item.id), ["t1", "t2"]);
  assert.deepEqual(new Set(model.evidenceSegmentIds), new Set([segmentA, segmentB]));
});

test("converted task matches its prior commitment so manual edits can transfer", () => {
  const graph = consolidateExecutionGraph({
    commitments: [
      candidate("c1", "Deliver the first website MVP"),
      candidate("c2", "Implement authentication backend", {
        source_segment_ids: [segmentA, segmentB]
      })
    ],
    tasks: []
  }).graph;
  const matches = matchConvertedCommitments({
    graph,
    commitments: [
      commitment("old-c2", {
        title: "Implement authentication backend",
        source_quote: "Implement authentication backend",
        source_segment_ids: [segmentA, segmentB],
        preserve_on_reanalysis: true,
        manual_override_fields: ["title", "owner", "status"]
      })
    ]
  });
  assert.equal(matches.get(0), "old-c2");
});

test("project migration preserves graph safety and manual work", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260727110000_add_project_execution_hierarchy.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(sql, /create table if not exists public\.projects/i);
  assert.match(sql, /add column if not exists project_id/i);
  assert.match(sql, /assign_meeting_project/);
  assert.match(sql, /merge_commitment_tasks/);
  assert.match(sql, /task_artifacts set task_id = p_survivor_task_id/i);
  assert.match(sql, /task_comments set task_id = p_survivor_task_id/i);
  assert.match(sql, /preserve_converted_commitment/);
  assert.match(sql, /converted_to_task_id = new\.id/);
  assert.match(sql, /preserve_on_reanalysis = true/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);

  const safetySql = await readFile(
    new URL(
      "../supabase/migrations/20260724150000_commitment_first_execution_classification.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(safetySql, /stale_analysis_run/);
  assert.match(safetySql, /manual_override_fields \? 'title'/);
  assert.match(safetySql, /task_artifacts/);
  assert.match(safetySql, /task_comments/);
});
