import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateExecutionExtraction,
  MVP_QUALITY_THRESHOLDS
} from "../lib/execution-intelligence/evaluation";
import {
  enforceExecutionGraphGrounding,
  mergeAndDeduplicateGraphs
} from "../lib/execution-intelligence/graph";
import { runExecutionIntelligence } from "../lib/execution-intelligence/pipeline";
import type { ExecutionGraph } from "../lib/execution-intelligence/schemas";

const segmentId = "e919513f-66f3-4082-86c0-38be4b9d0e4f";

function graph(): ExecutionGraph {
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
        due_date_text: "tomorrow",
        priority: "medium",
        confidence: 0.9,
        source_quote: "I'll send the pricing deck tomorrow.",
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
        due_date_text: "tomorrow",
        priority: "medium",
        confidence: 0.9,
        source_quote: "I'll send the pricing deck tomorrow.",
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

test("deduplicates commitments/tasks while preserving links", () => {
  const duplicate = graph();
  duplicate.commitments[0] = {
    ...duplicate.commitments[0],
    client_ref: "c2",
    title: "Send the pricing deck"
  };
  duplicate.tasks[0] = {
    ...duplicate.tasks[0],
    client_ref: "t2",
    commitment_ref: "c2"
  };

  const result = mergeAndDeduplicateGraphs(graph(), duplicate);
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, result.graph.commitments[0].client_ref);
  assert.equal(result.deduplicatedCommitments, 1);
  assert.equal(result.deduplicatedTasks, 1);
});

test("rejects ungrounded transcript candidates", () => {
  const grounded = enforceExecutionGraphGrounding({
    graph: graph(),
    source: {
      meetingId: "meeting-1",
      meetingDate: "2026-07-22T00:00:00Z",
      transcript: `[${segmentId}] [2026-07-22T00:00:00Z] Aditya: I'll send the pricing deck tomorrow.`,
      topics: [],
      insights: []
    }
  });
  assert.equal(grounded.graph.commitments.length, 1);
  assert.equal(grounded.graph.tasks.length, 1);

  const invalid = graph();
  invalid.tasks[0] = {
    ...invalid.tasks[0],
    source_quote: "Invent a feature nobody mentioned."
  };
  const rejected = enforceExecutionGraphGrounding({
    graph: invalid,
    source: {
      meetingId: "meeting-1",
      meetingDate: "2026-07-22T00:00:00Z",
      transcript: `[${segmentId}] Aditya: I'll send the pricing deck tomorrow.`,
      topics: [],
      insights: []
    }
  });
  assert.equal(rejected.graph.tasks.length, 0);
  assert.equal(rejected.rejectedTasks, 1);
});

test("evaluation metrics enforce MVP regression thresholds", () => {
  const expected = {
    commitments: [
      { title: "Send pricing deck", owner: "Aditya", source_quote: "I'll send it." }
    ],
    tasks: [
      { title: "Send the pricing deck", owner: "Aditya", source_quote: "I'll send it." }
    ]
  };
  const metrics = evaluateExecutionExtraction({
    expected,
    predicted: expected
  });

  assert.ok(metrics.commitmentRecall >= MVP_QUALITY_THRESHOLDS.commitmentRecall);
  assert.ok(metrics.commitmentPrecision >= MVP_QUALITY_THRESHOLDS.commitmentPrecision);
  assert.ok(metrics.taskRecall >= MVP_QUALITY_THRESHOLDS.taskRecall);
  assert.ok(metrics.taskPrecision >= MVP_QUALITY_THRESHOLDS.taskPrecision);
  assert.ok(metrics.groundingAccuracy >= MVP_QUALITY_THRESHOLDS.groundingAccuracy);
  assert.ok(metrics.duplicateRate <= MVP_QUALITY_THRESHOLDS.duplicateRateMax);
  assert.ok(metrics.hallucinationRate <= MVP_QUALITY_THRESHOLDS.hallucinationRateMax);
});

test("fallback pipeline verifies completeness before persisting executable work", async () => {
  const candidateGraph = graph();
  let persistedGraph: ExecutionGraph | null = null;
  const result = await runExecutionIntelligence({
    fallbackUsed: true,
    generation: 1,
    source: {
      meetingId: "meeting-1",
      meetingDate: "2026-07-22T00:00:00Z",
      transcript: `[${segmentId}] Aditya: I'll send the pricing deck tomorrow.`,
      topics: [],
      insights: [
        {
          topic_id: null,
          category: "next_steps",
          content: "Send the pricing deck"
        }
      ]
    },
    dependencies: {
      generateCandidates: async () => ({
        ok: true,
        graph: candidateGraph,
        latencyMs: 2
      }),
      verifyGraph: async ({ graph: inputGraph }) => ({
        ok: true,
        graph: inputGraph,
        latencyMs: 2
      }),
      findMissing: async () => ({
        ok: true,
        graph: { commitments: [], tasks: [] },
        latencyMs: 2
      }),
      persistGraph: async ({ graph: inputGraph }) => {
        persistedGraph = inputGraph;
        return { ok: true, commitments: [], tasks: [] };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.metrics.fallbackUsed, true);
  const stored = persistedGraph as ExecutionGraph | null;
  assert.ok(stored);
  assert.equal(stored.commitments.length, 1);
  // A child task that merely restates the commitment is consolidated away.
  assert.equal(stored.tasks.length, 0);
});
