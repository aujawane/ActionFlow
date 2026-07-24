import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFixtureTranscript,
  fixtureSegmentId
} from "../lib/execution-intelligence/fixture-harness";
import { matchExecutionGraphRows } from "../lib/execution-intelligence/matching";
import { runExecutionGraphModel } from "../lib/execution-intelligence/model";
import type { ExecutionGraph } from "../lib/execution-intelligence/schemas";
import {
  buildCommitmentTitleMap,
  getCommitmentTitleForTask,
  isInferredTask
} from "../lib/task-execution-display";
import { mergeManualOverrideFields } from "../lib/manual-overrides";
import type { MeetingTask } from "../lib/types";

const segmentId = "e919513f-66f3-4082-86c0-38be4b9d0e4f";

function validGraph(): ExecutionGraph {
  return {
    commitments: [
      {
        client_ref: "c1",
        topic_id: null,
        title: "Send pricing deck",
        description: null,
        owner: "Aditya",
        owners: ["Aditya"],
        due_date: null,
        due_date_text: null,
        priority: "medium",
        confidence: 0.9,
        source_quote: "I'll send the pricing deck.",
        source_segment_ids: [segmentId],
        evidence_source: "transcript",
        type: "personal",
        completion_state: "open"
      }
    ],
    tasks: [
      {
        client_ref: "t1",
        commitment_ref: "c1",
        topic_id: null,
        title: "Send the pricing deck",
        description: null,
        owner: "Aditya",
        owners: ["Aditya"],
        due_date: null,
        due_date_text: null,
        priority: "medium",
        confidence: 0.9,
        source_quote: "I'll send the pricing deck.",
        source_segment_ids: [segmentId],
        evidence_source: "transcript",
        inferred: false,
        task_type: "commitment",
        workspace_type: "email",
        suggested_steps: []
      }
    ]
  };
}

test("production migration preserves user work and rejects stale generations", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260723130000_production_execution_graph_safety.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(sql, /execution_graph_generation = execution_graph_generation \+ 1/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /stale_analysis_run/i);
  assert.match(sql, /task_artifacts[\s\S]*task_comments/i);
  assert.match(sql, /manual_override_fields \? 'status'/i);
  assert.match(sql, /drop index if exists public\.meeting_commitments_dedupe_idx/i);
  assert.match(sql, /revoke all on function[\s\S]*from authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
});

test("cross-run matcher keeps task identity despite minor title changes", () => {
  const graph = validGraph();
  graph.tasks[0] = { ...graph.tasks[0], title: "Send pricing deck to client" };
  const existingTask = {
    id: "task-existing",
    task: "Send the pricing deck",
    source_quote: "I'll send the pricing deck.",
    source_segment_ids: [segmentId]
  } as MeetingTask;
  const result = matchExecutionGraphRows({
    graph,
    commitments: [],
    tasks: [existingTask]
  });
  assert.equal(result.tasks.get(0), "task-existing");
});

test("model salvages valid items when one model item is malformed", async () => {
  const graph = validGraph();
  const raw = {
    ...graph,
    tasks: [
      ...graph.tasks,
      {
        client_ref: "bad",
        title: "",
        source_segment_ids: ["not-a-uuid"]
      }
    ]
  };
  const result = await runExecutionGraphModel({
    stage: "candidates",
    systemPrompt: "test",
    context: {},
    createResponse: async () => ({ output_text: JSON.stringify(raw) })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.salvagedItems, 1);
});

test("execution display exposes inferred and parent commitment state", () => {
  const titles = buildCommitmentTitleMap([
    { id: "commitment-1", title: "Launch beta" }
  ]);
  assert.equal(isInferredTask({ inferred: true }), true);
  assert.equal(isInferredTask({}), false);
  assert.equal(
    getCommitmentTitleForTask({ commitment_id: "commitment-1" }, titles),
    "Launch beta"
  );
});

test("manual override tracking is additive and idempotent", () => {
  assert.deepEqual(
    mergeManualOverrideFields(["owner", "status"], ["status", "due_date"]),
    ["owner", "status", "due_date"]
  );
});

test("live fixture harness creates deterministic grounded transcripts", () => {
  const fixture = {
    id: "explicit",
    transcript: "Aditya: I'll send it.",
    expected: { commitments: [], tasks: [] }
  };
  assert.equal(fixtureSegmentId("explicit"), fixtureSegmentId("explicit"));
  assert.match(
    buildFixtureTranscript(fixture),
    /^\[[0-9a-f-]{36}\] Aditya:/
  );
});
