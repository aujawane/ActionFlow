import assert from "node:assert/strict";
import test from "node:test";

import {
  canApplyTaskChatPatch,
  getTaskChatPatchConflict,
  normalizeSuggestedSteps,
  sanitizeTaskChatPatch
} from "../lib/ai/task-chat-patch";

test("maps AI fields only to the meeting_tasks whitelist", () => {
  const patch = sanitizeTaskChatPatch({
    title: "Use Poke for reminders",
    description: "Integrate Parfait with Poke.",
    owner: "Sarah",
    priority: "high",
    status: "in_progress",
    task_type: "commitment",
    due_date: "2026-07-17",
    suggested_next_steps: ["Draft the reminder flow", "Test weekly check-ins"],
    rationale: "Follow-through needs a repeatable workflow.",
    supporting_context: "The meeting requested reminders throughout the week.",
    meeting_id: "malicious-meeting",
    user_id: "malicious-user"
  });

  assert.deepEqual(patch, {
    task: "Use Poke for reminders",
    workspace_summary: "Integrate Parfait with Poke.",
    owner: "Sarah",
    priority: "high",
    status: "in_progress",
    due_date: "2026-07-17",
    task_type: "commitment",
    suggested_steps: ["Draft the reminder flow", "Test weekly check-ins"],
    rationale: "Follow-through needs a repeatable workflow.",
    supporting_context: "The meeting requested reminders throughout the week."
  });
});

test("rejects non-ISO due dates and unknown keys", () => {
  const patch = sanitizeTaskChatPatch({
    due_date: "Friday",
    arbitrary: "ignored"
  });
  assert.deepEqual(patch, {});
});

test("requires update intent, confidence at least 0.75, and a non-empty patch", () => {
  const patch = sanitizeTaskChatPatch({ owner: "Craig" });
  assert.equal(
    canApplyTaskChatPatch({
      shouldUpdateTask: true,
      confidence: 0.75,
      patch
    }),
    true
  );
  assert.equal(
    canApplyTaskChatPatch({
      shouldUpdateTask: true,
      confidence: 0.74,
      patch
    }),
    false
  );
  assert.equal(
    canApplyTaskChatPatch({
      shouldUpdateTask: false,
      confidence: 0.99,
      patch
    }),
    false
  );
  assert.equal(
    canApplyTaskChatPatch({
      shouldUpdateTask: true,
      confidence: 0.99,
      patch: {}
    }),
    false
  );
});

test("supports explicitly clearing an assignee", () => {
  assert.deepEqual(sanitizeTaskChatPatch({ owner: "Unassigned" }), {
    owner: null
  });
});

test("maps assignee to owner and rejects conflicting aliases", () => {
  assert.deepEqual(sanitizeTaskChatPatch({ assignee: "Craig" }), {
    owner: "Craig"
  });
  assert.equal(
    getTaskChatPatchConflict({ owner: "Craig", assignee: "Sarah" }),
    "owner and assignee contain different values"
  );
  assert.equal(
    getTaskChatPatchConflict({ owner: "Craig", assignee: "craig" }),
    null
  );
});

test("normalizes string and array suggested next steps", () => {
  assert.deepEqual(
    normalizeSuggestedSteps("1. Review the API\n- Draft the integration; Test it"),
    ["Review the API", "Draft the integration", "Test it"]
  );
  assert.deepEqual(
    sanitizeTaskChatPatch({
      suggested_next_steps: ["  Review the API  ", "", "Test it"]
    }),
    { suggested_steps: ["Review the API", "Test it"] }
  );
});
