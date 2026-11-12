import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskContextPrompt, type TaskWorkspaceContext } from "@/lib/task-workspace";

function contextFor(meetingUrl: string | null) {
  return {
    task: {
      title: "Send the revised budget",
      owner: "Craig",
      task_type: "action",
      priority: "high",
      status: "open",
      workspace_type: "general",
      workspace_summary: null,
      source_quote: null,
      suggested_steps: []
    },
    meeting: { title: "Imported planning call", meeting_url: meetingUrl },
    topic: null,
    segments: []
  } as unknown as TaskWorkspaceContext;
}

test("an imported meeting has no join link, so the prompt omits the line instead of printing 'null'", () => {
  const prompt = buildTaskContextPrompt(contextFor(null));
  assert.match(prompt, /Meeting: Imported planning call/);
  assert.doesNotMatch(prompt, /Meeting URL/);
  assert.doesNotMatch(prompt, /\bnull\b/);
});

test("a Recall meeting still includes its meeting link", () => {
  const prompt = buildTaskContextPrompt(contextFor("https://meet.google.com/abc-defg-hij"));
  assert.match(prompt, /Meeting URL: https:\/\/meet\.google\.com\/abc-defg-hij/);
});
