import assert from "node:assert/strict";
import test from "node:test";

import { proposeTaskPatch } from "../lib/task-clarification-patches";
import type { MeetingTask } from "../lib/types";

function task(overrides: Partial<MeetingTask> = {}): MeetingTask {
  return {
    id: "task-1",
    meeting_id: "meeting-1",
    topic_id: "topic-1",
    task: "Explore integration between Parfait and Pogue",
    owner: "Aditya",
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: null,
    status: "pending",
    workspace_type: "research",
    workspace_summary: "Planning integration of Parfait with Pogue",
    created_at: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

test("replaces corrected text in title and description with matched casing", () => {
  const proposal = proposeTaskPatch(task(), "instead of pogue it is poke");
  assert.equal(proposal.kind, "patch");
  if (proposal.kind !== "patch") return;
  assert.equal(proposal.patch.task, "Explore integration between Parfait and Poke");
  assert.equal(
    proposal.patch.workspace_summary,
    "Planning integration of Parfait with Poke"
  );
  assert.equal(
    proposal.assistantMessage,
    "I updated the task to replace “pogue” with “Poke”."
  );
});

test("updates only the explicitly requested structured fields", () => {
  const ownerProposal = proposeTaskPatch(
    task(),
    "This should be assigned to Sarah"
  );
  assert.deepEqual(
    ownerProposal.kind === "patch" ? ownerProposal.patch : null,
    { owner: "Sarah" }
  );

  const priorityProposal = proposeTaskPatch(task(), "Priority should be high");
  assert.deepEqual(
    priorityProposal.kind === "patch" ? priorityProposal.patch : null,
    { priority: "high" }
  );
});

test("asks for confirmation when replacement text is not present", () => {
  const proposal = proposeTaskPatch(task(), "change Jira to Linear");
  assert.equal(proposal.kind, "ambiguous");
});

test("asks for an exact date when a deadline is ambiguous", () => {
  const proposal = proposeTaskPatch(task(), "Deadline is Friday");
  assert.equal(proposal.kind, "ambiguous");
  if (proposal.kind === "ambiguous") {
    assert.match(proposal.assistantMessage, /calendar date/i);
  }
});

test("proposes an ISO due date through the deterministic fallback", () => {
  const proposal = proposeTaskPatch(task(), "Due date is 2026-07-17");
  assert.deepEqual(
    proposal.kind === "patch" ? proposal.patch : null,
    { due_date: "2026-07-17" }
  );
});

test("leaves ordinary clarification questions as comments only", () => {
  const proposal = proposeTaskPatch(task(), "Why was this task created?");
  assert.deepEqual(proposal, { kind: "none" });
});
