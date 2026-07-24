import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_CHUNK_MAX_SEGMENTS,
  EXECUTION_CHUNK_OVERLAP_SEGMENTS,
  splitExecutionSourceIntoChunks
} from "../lib/execution-intelligence/chunking";
import {
  buildExecutionGraphBatches,
  EXECUTION_GRAPH_BATCH_MAX_ITEMS
} from "../lib/execution-intelligence/graph-batching";
import { runExecutionIntelligence } from "../lib/execution-intelligence/pipeline";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";
import {
  generateChunkedExecutionCandidates,
  verifyExecutionGraphInBatches,
  type ExecutionSourceContext
} from "../lib/execution-intelligence/stages";

function segmentId(index: number) {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function source(segmentCount = 120): ExecutionSourceContext {
  return {
    meetingId: "meeting-1",
    meetingDate: "2026-07-24T00:00:00.000Z",
    transcriptSegmentCount: segmentCount,
    transcript: Array.from(
      { length: segmentCount },
      (_, index) =>
        `[${segmentId(index + 1)}] [2026-07-24T00:00:00.000Z] Speaker: Segment ${index + 1}`
    ).join("\n"),
    topics: [],
    insights: []
  };
}

function commitment(
  id: string,
  title: string,
  sourceSegmentId: string,
  overrides: Partial<CommitmentCandidate> = {}
): CommitmentCandidate {
  return {
    client_ref: id,
    topic_id: null,
    title,
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: title,
    source_segment_ids: [sourceSegmentId],
    evidence_source: "transcript",
    type: "team",
    completion_state: "open",
    ...overrides
  };
}

function task(
  id: string,
  commitmentRef: string,
  title: string,
  sourceSegmentId: string,
  overrides: Partial<TaskCandidate> = {}
): TaskCandidate {
  return {
    client_ref: id,
    commitment_ref: commitmentRef,
    topic_id: null,
    title,
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: title,
    source_segment_ids: [sourceSegmentId],
    evidence_source: "transcript",
    inferred: false,
    task_type: "commitment",
    workspace_type: "other",
    suggested_steps: [],
    ...overrides
  };
}

test("long meetings split near topic boundaries with five-segment overlap", () => {
  const input = source();
  input.topics = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Boundary topic",
      summary: null,
      segment_ids: Array.from({ length: 48 }, (_, index) =>
        segmentId(index + 1)
      )
    }
  ];

  const chunks = splitExecutionSourceIntoChunks(input);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].endSegment, 48);
  assert.equal(
    chunks[1].startSegment,
    chunks[0].endSegment - EXECUTION_CHUNK_OVERLAP_SEGMENTS + 1
  );
  assert.ok(
    chunks.every(
      (chunk) =>
        (chunk.source.transcriptSegmentCount ?? 0) <=
        EXECUTION_CHUNK_MAX_SEGMENTS
    )
  );
});

test("cross-chunk ownership clarification enriches one earlier commitment", async () => {
  const result = await generateChunkedExecutionCandidates(source(90), {
    generateChunk: async (chunkSource) => {
      if (chunkSource.transcript.includes(`[${segmentId(1)}]`)) {
        return {
          ok: true as const,
          graph: {
            commitments: [
              commitment(
                "c1",
                "Launch AI search project",
                segmentId(10),
                { source_quote: "We should launch AI search." }
              )
            ],
            tasks: []
          },
          latencyMs: 1
        };
      }
      if (chunkSource.transcript.includes(`[${segmentId(50)}]`)) {
        return {
          ok: true as const,
          graph: {
            commitments: [
              commitment(
                "c1",
                "Own backend development for AI search",
                segmentId(50),
                {
                  owner: "B",
                  owners: ["B"],
                  source_quote: "I'll own the backend for that.",
                  type: "personal"
                }
              )
            ],
            tasks: [
              task(
                "t1",
                "c1",
                "Own backend development for AI search",
                segmentId(50),
                {
                  owner: "B",
                  owners: ["B"],
                  source_quote: "I'll own the backend for that."
                }
              )
            ]
          },
          latencyMs: 1
        };
      }
      return {
        ok: true as const,
        graph: { commitments: [], tasks: [] },
        latencyMs: 1
      };
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(
    result.graph.tasks[0].commitment_ref,
    result.graph.commitments[0].client_ref
  );
  assert.equal(result.graph.tasks[0].owner, "B");
  assert.match(result.graph.tasks[0].title, /^Implement .*backend/i);
});

test("overlapping chunks globally deduplicate the same task", async () => {
  const overlapSegment = segmentId(38);
  const result = await generateChunkedExecutionCandidates(source(90), {
    generateChunk: async (chunkSource) => {
      const graph: ExecutionGraph = chunkSource.transcript.includes(
        `[${overlapSegment}]`
      )
        ? {
            commitments: [
              commitment("c1", "Review launch plan", overlapSegment)
            ],
            tasks: [
              task("t1", "c1", "Review launch plan", overlapSegment)
            ]
          }
        : { commitments: [], tasks: [] };
      return { ok: true as const, graph, latencyMs: 1 };
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 1);
});

test("one failed candidate chunk prevents pipeline persistence", async () => {
  let calls = 0;
  let persisted = false;
  const result = await runExecutionIntelligence({
    source: source(90),
    fallbackUsed: false,
    generation: 1,
    dependencies: {
      generateCandidates: (input) =>
        generateChunkedExecutionCandidates(input, {
          concurrency: 1,
          generateChunk: async () => {
            calls += 1;
            if (calls === 2) {
              return {
                ok: false as const,
                error: "simulated chunk failure",
                latencyMs: 1,
                validationFailure: false
              };
            }
            return {
              ok: true as const,
              graph: { commitments: [], tasks: [] },
              latencyMs: 1
            };
          }
        }),
      persistGraph: async () => {
        persisted = true;
        return { ok: true, commitments: [], tasks: [] };
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(persisted, false);
  assert.match(result.error, /chunk 2 failed/i);
});

test("chunk merge order is deterministic despite completion order", async () => {
  async function run() {
    return generateChunkedExecutionCandidates(source(90), {
      concurrency: 2,
      generateChunk: async (chunkSource) => {
        const isFirst = chunkSource.transcript.includes(`[${segmentId(1)}]`);
        await new Promise((resolve) => setTimeout(resolve, isFirst ? 10 : 0));
        const index = isFirst ? 1 : 2;
        return {
          ok: true as const,
          graph: {
            commitments: [
              commitment(
                "c1",
                index === 1
                  ? "Prepare financial report"
                  : "Schedule customer interview",
                segmentId(isFirst ? 1 : 50)
              )
            ],
            tasks: []
          },
          latencyMs: 1
        };
      }
    });
  }

  const first = await run();
  const second = await run();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(
    first.graph.commitments.map((item) => item.title),
    second.graph.commitments.map((item) => item.title)
  );
  assert.deepEqual(
    first.graph.commitments.map((item) => item.client_ref),
    ["chunk_1_c1", "chunk_2_c1"]
  );
});

test("large verification graphs are split into bounded batches with concurrency two", async () => {
  const inputSource = source(120);
  const graph: ExecutionGraph = {
    commitments: Array.from({ length: 40 }, (_, index) =>
      commitment(
        `c${index}`,
        `Prepare artifact codeword${index}`,
        segmentId(index * 3 + 1)
      )
    ),
    tasks: Array.from({ length: 40 }, (_, index) =>
      task(
        `t${index}`,
        `c${index}`,
        `Complete deliverable codeword${index}`,
        segmentId(index * 3 + 1)
      )
    )
  };
  const batches = buildExecutionGraphBatches({
    source: inputSource,
    graph
  });
  assert.ok(batches.length > 3);
  assert.ok(
    batches.every(
      (batch) =>
        batch.graph.commitments.length + batch.graph.tasks.length <=
        EXECUTION_GRAPH_BATCH_MAX_ITEMS
    )
  );

  let active = 0;
  let maxActive = 0;
  const result = await verifyExecutionGraphInBatches({
    source: inputSource,
    graph,
    verifyBatch: async (batch) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { ok: true, graph: batch.graph, latencyMs: 2 };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(maxActive, 2);
  if (!result.ok) return;
  assert.equal(result.graph.commitments.length, 40);
  assert.equal(result.graph.tasks.length, 40);
});

test("batched verification preserves cross-batch commitment task links", async () => {
  const graph: ExecutionGraph = {
    commitments: [
      commitment("c1", "Launch customer portal", segmentId(1))
    ],
    tasks: [
      task(
        "t1",
        "c1",
        "Implement customer portal backend",
        segmentId(80)
      )
    ]
  };
  const seenParentWithTask: boolean[] = [];
  const result = await verifyExecutionGraphInBatches({
    source: source(100),
    graph,
    verifyBatch: async (batch) => {
      if (batch.graph.tasks.some((item) => item.client_ref === "t1")) {
        seenParentWithTask.push(
          batch.graph.commitments.some(
            (item) => item.client_ref === "c1"
          )
        );
      }
      return { ok: true, graph: batch.graph, latencyMs: 1 };
    }
  });

  assert.deepEqual(seenParentWithTask, [true]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, "c1");
});

test("failed verification batch prevents pipeline persistence", async () => {
  const candidateGraph: ExecutionGraph = {
    commitments: [
      commitment("c1", "Prepare launch brief", segmentId(1)),
      commitment("c2", "Review customer feedback", segmentId(80))
    ],
    tasks: []
  };
  let verificationCalls = 0;
  let persisted = false;
  const result = await runExecutionIntelligence({
    source: source(100),
    fallbackUsed: false,
    generation: 1,
    dependencies: {
      generateCandidates: async () => ({
        ok: true,
        graph: candidateGraph,
        latencyMs: 1
      }),
      verifyGraph: (input) =>
        verifyExecutionGraphInBatches({
          ...input,
          concurrency: 1,
          verifyBatch: async (batch) => {
            verificationCalls += 1;
            if (verificationCalls === 2) {
              return {
                ok: false,
                error: "verification batch failed",
                latencyMs: 1,
                validationFailure: false
              };
            }
            return { ok: true, graph: batch.graph, latencyMs: 1 };
          }
        }),
      persistGraph: async () => {
        persisted = true;
        return { ok: true, commitments: [], tasks: [] };
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(persisted, false);
  assert.match(result.error, /verification batch 2 failed/i);
});

