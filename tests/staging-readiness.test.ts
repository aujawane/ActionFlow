import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadMeetingTasksWithFallback } from "../lib/meeting-task-query";
import {
  buildExecutionModelRequest,
  EXECUTION_MODEL_MAX_ATTEMPTS,
  EXECUTION_MODEL_MAX_OUTPUT_TOKENS,
  EXECUTION_MODEL_SDK_MAX_RETRIES,
  runExecutionGraphModel
} from "../lib/execution-intelligence/model";
import { buildExecutionSourcePayload } from "../lib/execution-intelligence/stages";
import { replaceSpeakerOwnerFields } from "../lib/speaker-resolution";

test("execution graph RPC is server-only and search_path protected", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260723010000_add_execution_commitments.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(sql, /set search_path = public/i);
  assert.match(sql, /revoke all on function[\s\S]*from public/i);
  assert.match(sql, /revoke all on function[\s\S]*from anon/i);
  assert.match(sql, /revoke all on function[\s\S]*from authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
  assert.match(sql, /if not exists \([\s\S]*from public\.meetings/i);
  assert.match(sql, /server-only/i);
});

test("execution model calls time out and stop after bounded retries", async () => {
  let attempts = 0;
  const events: Record<string, unknown>[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    if (
      args[0] === "[execution-intelligence]" &&
      args[1] &&
      typeof args[1] === "object"
    ) {
      events.push(args[1] as Record<string, unknown>);
    }
  };

  let result: Awaited<ReturnType<typeof runExecutionGraphModel>> | undefined;
  try {
    result = await runExecutionGraphModel({
      stage: "candidates",
      systemPrompt: "test",
      context: {},
      timeoutMs: 5,
      createResponse: async () => {
        attempts += 1;
        return new Promise(() => {});
      }
    });
  } finally {
    console.info = originalInfo;
  }

  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(attempts, EXECUTION_MODEL_MAX_ATTEMPTS);
  assert.match(result.error, /timed out/i);
  const timeoutEvents = events.filter((event) => event.event === "timeout");
  assert.equal(timeoutEvents.length, EXECUTION_MODEL_MAX_ATTEMPTS);
  assert.ok(
    timeoutEvents.every(
      (event) =>
        event.timeout_ms === 5 &&
        typeof event.elapsed_ms === "number" &&
        event.elapsed_ms >= 0 &&
        typeof event.request_started_at === "string" &&
        typeof event.request_ended_at === "string"
    )
  );
});

test("execution model logs elapsed time for successful calls", async () => {
  const events: Record<string, unknown>[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    if (
      args[0] === "[execution-intelligence]" &&
      args[1] &&
      typeof args[1] === "object"
    ) {
      events.push(args[1] as Record<string, unknown>);
    }
  };

  try {
    const result = await runExecutionGraphModel({
      stage: "candidates",
      systemPrompt: "test",
      context: {},
      timeoutMs: 50,
      createResponse: async () => ({
        output_text: JSON.stringify({ commitments: [], tasks: [] })
      })
    });
    assert.equal(result.ok, true);
  } finally {
    console.info = originalInfo;
  }

  const success = events.find((event) => event.event === "success");
  assert.ok(success);
  assert.equal(success.timeout_ms, 50);
  assert.equal(typeof success.elapsed_ms, "number");
  assert.equal(typeof success.request_started_at, "string");
  assert.equal(typeof success.request_ended_at, "string");
});

test("execution candidate requests bound output without hidden reasoning or SDK retries", () => {
  const request = buildExecutionModelRequest({
    stage: "candidates",
    model: "gpt-4.1-mini",
    systemPrompt: "test prompt",
    context: { transcript: "test transcript" }
  });

  assert.equal(request.model, "gpt-4.1-mini");
  assert.equal(
    request.max_output_tokens,
    EXECUTION_MODEL_MAX_OUTPUT_TOKENS
  );
  assert.equal(EXECUTION_MODEL_SDK_MAX_RETRIES, 0);
  assert.equal("reasoning" in request, false);
});

test("execution source payload sends each transcript, topic, and insight once", () => {
  const payload = buildExecutionSourcePayload({
    meetingId: "meeting-1",
    meetingDate: "2026-07-24T00:00:00.000Z",
    transcript: "single transcript",
    transcriptSegmentCount: 1,
    topics: [
      {
        id: "topic-1",
        title: "Topic",
        summary: "Summary",
        segment_ids: []
      }
    ],
    insights: [
      {
        topic_id: "topic-1",
        category: "product_summary",
        content: "Product summary"
      },
      {
        topic_id: "topic-1",
        category: "next_steps",
        content: "Next step"
      }
    ]
  });

  assert.equal(payload.transcript, "single transcript");
  assert.equal(payload.topics.length, 1);
  assert.equal(payload.meeting_summaries.length, 1);
  assert.equal(payload.insight_next_steps.length, 1);
  assert.deepEqual(Object.keys(payload).sort(), [
    "insight_next_steps",
    "meeting_date",
    "meeting_id",
    "meeting_summaries",
    "topics",
    "transcript",
    "transcript_segment_count"
  ]);
});

test("speaker alias replacement updates primary and task owners arrays", () => {
  assert.deepEqual(
    replaceSpeakerOwnerFields({
      owner: "Speaker 1",
      owners: ["Speaker 1", "Craig"],
      rawSpeakerLabel: "Speaker 1",
      displayName: "Aditya"
    }),
    { owner: "Aditya", owners: ["Aditya", "Craig"] }
  );
  assert.deepEqual(
    replaceSpeakerOwnerFields({
      owner: "Old Name",
      owners: ["Old Name", "Craig"],
      rawSpeakerLabel: "Speaker 1",
      previousDisplayName: "Old Name",
      displayName: "New Name"
    }),
    { owner: "New Name", owners: ["New Name", "Craig"] }
  );
});

test("meeting task query falls back without hiding legacy tasks", async () => {
  const requestedColumns: string[] = [];
  const result = await loadMeetingTasksWithFallback(async (columns) => {
    requestedColumns.push(columns);
    if (requestedColumns.length === 1) {
      return {
        data: null,
        error: { code: "42703", message: "column commitment_id does not exist" }
      };
    }
    return {
      data: [
        {
          id: "task-1",
          meeting_id: "meeting-1",
          topic_id: "topic-1",
          task: "Legacy task"
        }
      ],
      error: null
    };
  });

  assert.equal(result.usedLegacyFallback, true);
  assert.equal(result.error, null);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].task, "Legacy task");
  assert.equal(requestedColumns.length, 2);
});

