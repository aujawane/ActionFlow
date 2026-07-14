import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingProposalMetadata,
  findLatestPendingProposal,
  formatAppliedPatchMessage,
  formatPendingPatchMessage,
  isTaskUpdateConfirmation,
  parseTaskCommentMetadata,
  taskContainsPatch,
  updateProposalStatus
} from "../lib/task-comment-metadata";
import type { MeetingTask, TaskComment } from "../lib/types";

function task(overrides: Partial<MeetingTask> = {}): MeetingTask {
  return {
    id: "task-1",
    meeting_id: "meeting-1",
    topic_id: "topic-1",
    task: "Explore Parfait and Pogue",
    owner: "Aditya",
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    due_date: null,
    workspace_type: "research",
    workspace_summary: "Research the integration",
    rationale: null,
    supporting_context: null,
    created_at: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

function comment(
  id: string,
  metadata: TaskComment["metadata"]
): TaskComment {
  return {
    id,
    task_id: "task-1",
    user_id: null,
    role: "assistant",
    message: "Proposal",
    metadata,
    created_at: "2026-07-14T00:00:00.000Z"
  };
}

test("persists and finds the latest exact pending proposal", () => {
  const first = createPendingProposalMetadata({
    patch: { task: "First title" },
    confidence: 0.7,
    source: "agent"
  });
  const latest = createPendingProposalMetadata({
    patch: {
      suggested_steps: ["Review the API", "Test reminders"],
      rationale: "Validate the workflow first."
    },
    confidence: 0.8,
    source: "agent"
  });

  const found = findLatestPendingProposal([
    comment("comment-1", first),
    comment("comment-2", latest)
  ]);
  assert.equal(found?.commentId, "comment-2");
  assert.deepEqual(found?.proposal.patch, latest.proposal?.patch);
});

test("applied and superseded proposals are no longer pending", () => {
  const metadata = createPendingProposalMetadata({
    patch: { owner: "Sarah" },
    confidence: 0.9,
    source: "agent"
  });
  const applied = updateProposalStatus(metadata, "applied");
  assert.equal(parseTaskCommentMetadata(applied).proposal?.status, "applied");
  assert.equal(findLatestPendingProposal([comment("comment-1", applied)]), null);
});

test("recognizes only unambiguous confirmation replies", () => {
  assert.equal(isTaskUpdateConfirmation("Yes, looks good."), true);
  assert.equal(isTaskUpdateConfirmation("confirm"), true);
  assert.equal(isTaskUpdateConfirmation("yes, but change the owner"), false);
});

test("verifies persisted task values and generates truthful summaries", () => {
  const patch = {
    task: "Explore Parfait and Poke",
    suggested_steps: ["Review the API"]
  };
  assert.equal(
    taskContainsPatch(
      task({
        task: "Explore Parfait and Poke",
        suggested_steps: ["Review the API"]
      }),
      patch
    ),
    true
  );
  assert.equal(taskContainsPatch(task(), patch), false);
  assert.equal(
    formatAppliedPatchMessage(patch),
    "Updated: title, suggested next steps."
  );
  assert.equal(
    formatPendingPatchMessage(patch),
    "Pending update: title, suggested next steps. Confirm to apply these exact changes."
  );
});

test("drops malformed proposal metadata", () => {
  assert.deepEqual(
    parseTaskCommentMetadata({
      proposal: {
        id: "not-a-uuid",
        patch: { meeting_id: "malicious" },
        confidence: 2,
        status: "pending",
        source: "agent"
      }
    }),
    {}
  );
});
