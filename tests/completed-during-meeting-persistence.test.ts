import assert from "node:assert/strict";
import test from "node:test";

import { assembleExecutionTree, isCompletedDuringMeeting, isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import { treeToExecutionGraph } from "../lib/execution-intelligence/execution-graph-v4";
import type { GroupProposal, RawWorkItem, VerifiedGroup, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

/**
 * Focused tests for the completed-during-meeting persistence fix (see execution-tree.ts's
 * `isCompletedDuringMeeting`/`COMPLETED_HISTORY_ROLES`/`dedupeCompletedWork`, and
 * execution-graph-v4.ts's `completedWorkItemToCommitmentCandidate`). Mirrors the builder pattern
 * already used in tests/v4-execution-intelligence.test.ts (not shared across files, by existing
 * convention).
 */

const segment = "11111111-1111-4111-8111-111111111111";
const segment2 = "22222222-2222-4222-8222-222222222222";
const transcript = `[${segment}] Theo: I'll restart the worker.\n[${segment2}] Theo: okay, restarted, it's back up.`;

function rawItem(overrides: Partial<RawWorkItem> & { title: string }): RawWorkItem {
  return {
    description: null,
    owner: "Theo",
    owners: ["Theo"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "Fixture classification.",
    source_quote: `I'll ${overrides.title.toLowerCase()}`,
    source_segment_ids: [segment],
    extraction_reason: "Fixture classification.",
    confidence: 0.9,
    ...overrides
  };
}

function workItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
}

function assemble(workItems: WorkItem[], draftGroups: GroupProposal[] = [], verifiedGroups: VerifiedGroup[] = []) {
  return assembleExecutionTree({ transcript, workItems, draftGroups, verifiedGroups });
}

// ---------------------------------------------------------------------------
// T1 -- same utterance: "I'll restart the worker... okay, done."
// ---------------------------------------------------------------------------
test("[T1] a same-breath completed action produces one persisted completed item and zero open items", () => {
  const item = workItem({
    ref: "wi_1",
    title: "Restart the stuck export worker",
    source_quote: "I'll restart it... okay, restarted, it's back up",
    source_segment_ids: [segment, segment2],
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  const assembled = assemble([item]);
  assert.equal(assembled.tree.commitments.length, 0, "must not become an open commitment");
  assert.equal(assembled.tree.standalone_tasks.length, 0, "must not become an open standalone task");
  assert.equal(assembled.tree.completed_work?.length, 1, "must produce exactly one completed-history entry");
  assert.equal(assembled.tree.completed_work?.[0].ref, "wi_1");

  const graph = treeToExecutionGraph(assembled.tree);
  assert.equal(graph.commitments.length, 1);
  assert.equal(graph.commitments[0].completion_state, "completed");
  assert.equal(graph.tasks.length, 0, "a completed item must never also produce a task row");
});

// ---------------------------------------------------------------------------
// T2 -- normal active promise: "I'll restart the worker after the meeting."
// ---------------------------------------------------------------------------
test("[T2] a normal open active promise is unaffected -- existing behavior unchanged", () => {
  const item = workItem({
    ref: "wi_2",
    title: "Restart the worker after the meeting",
    status: "open",
    classification: "promise",
    acceptance_state: "accepted"
  });
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length ?? 0, 0);
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), false);
  // Still eligible, still ends up standalone exactly as before this change.
  assert.equal(assembled.tree.standalone_tasks.length, 1);
  assert.equal(assembled.tree.standalone_tasks[0].ref, "wi_2");
});

// ---------------------------------------------------------------------------
// T3 -- active -> later completed: "I'll restart it." [later] "Okay, restarted."
// ---------------------------------------------------------------------------
test("[T3] an item that transitions from active to completed later in the meeting produces one completed representation, never a duplicate active one", () => {
  // By the time global correction has run, the SAME ref's fields reflect the final (completed)
  // state -- there is no separate "stale open" copy of it for assembleExecutionTree to see (the
  // correction mutates the one WorkItem in place upstream of tree assembly). This is exactly what
  // makes this case converge with T1 at this layer -- see the fix's own design note.
  const item = workItem({
    ref: "wi_3",
    title: "Restart the worker",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    classification_reason: "Corrected by lifecycle reconciliation after the restart was confirmed later in the meeting."
  });
  const assembled = assemble([item]);
  assert.equal(assembled.tree.commitments.length, 0);
  assert.equal(assembled.tree.standalone_tasks.length, 0);
  assert.equal(assembled.tree.completed_work?.length, 1);

  const graph = treeToExecutionGraph(assembled.tree);
  assert.equal(graph.commitments.filter((c) => c.supporting_action_refs?.includes("wi_3")).length, 1, "exactly one completed representation");
  assert.equal(graph.tasks.some((t) => t.client_ref === "wi_3"), false, "no duplicate active/task representation");
});

// ---------------------------------------------------------------------------
// T4 -- retrospective: "I restarted it yesterday."
// ---------------------------------------------------------------------------
test("[T4] a retrospective statement from before the meeting produces no completed meeting work item", () => {
  const item = workItem({
    ref: "wi_4",
    title: "Restart the worker yesterday",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    scope_state: "informational",
    work_item_role: "status_update",
    due_date_text: "yesterday"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), false);
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// T5 -- historical informational: "We restarted that during last week's incident."
// ---------------------------------------------------------------------------
test("[T5] historical informational narration produces no completed meeting work item", () => {
  const item = workItem({
    ref: "wi_5",
    title: "Historical worker restart during last week's incident",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    scope_state: "informational",
    work_item_role: "status_update"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), false);
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// T6 -- hypothetical: "If this happens again I'll restart it."
// ---------------------------------------------------------------------------
test("[T6] a hypothetical/conditional action produces no completed item", () => {
  const item = workItem({
    ref: "wi_6",
    title: "Restart it if this happens again",
    status: "open",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), false, "status is not even completed");
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// T7 -- same-breath troubleshooting action that IS meaningful project work.
// ---------------------------------------------------------------------------
test("[T7] a same-breath troubleshooting action classified as meaningful project work produces a completed representation", () => {
  const item = workItem({
    ref: "wi_7",
    title: "Diagnose and fix the stuck queue live on the call",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    work_item_role: "incidental_troubleshooting"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), true);
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length, 1);
});

// ---------------------------------------------------------------------------
// T8 -- pure meeting logistics: "I'll share my screen... okay, sharing."
// ---------------------------------------------------------------------------
test("[T8] pure meeting logistics follows existing product semantics -- not promoted to a completed project task", () => {
  const item = workItem({
    ref: "wi_8",
    title: "Share screen",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    execution_scope: "personal_logistics"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), false, "personal_logistics is excluded exactly as it already is for active eligibility");
  const assembled = assemble([item]);
  assert.equal(assembled.tree.completed_work?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// T9 -- completed item retains owner, source evidence, classification/status, meeting linkage.
// ---------------------------------------------------------------------------
test("[T9] the persisted completed representation retains owner, evidence, status, and classification", () => {
  const item = workItem({
    ref: "wi_9",
    title: "Restart the stuck export worker",
    owner: "Theo",
    owners: ["Theo"],
    source_quote: "I'll restart it, okay restarted",
    source_segment_ids: [segment, segment2],
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  const assembled = assemble([item]);
  const graph = treeToExecutionGraph(assembled.tree);
  const persisted = graph.commitments.find((c) => c.client_ref === "wi_9");
  assert.ok(persisted);
  assert.equal(persisted!.owner, "Theo");
  assert.deepEqual(persisted!.owners, ["Theo"]);
  assert.equal(persisted!.source_quote, "I'll restart it, okay restarted");
  assert.deepEqual(persisted!.source_segment_ids, [segment, segment2]);
  assert.equal(persisted!.completion_state, "completed");
  assert.deepEqual(persisted!.supporting_action_refs, ["wi_9"], "meeting linkage back to the originating work item is preserved");
});

// ---------------------------------------------------------------------------
// T10 -- the completed representation does not satisfy active execution eligibility.
// ---------------------------------------------------------------------------
test("[T10] a completed-history item never satisfies isExecutionEligible", () => {
  const item = workItem({
    ref: "wi_10",
    title: "Restart the stuck export worker",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  assert.equal(isCompletedDuringMeeting(item, new Set([segment])), true);
  assert.equal(isExecutionEligible(item), false, "completed work must never ALSO be execution-eligible active work");
});

// ---------------------------------------------------------------------------
// Additional: no ungrounded/unowned item is ever promoted, even if status/classification match.
// ---------------------------------------------------------------------------
test("[safety] a completed-shaped item with no owner or no valid grounding is not promoted to completed history", () => {
  const noOwner = workItem({
    ref: "wi_11",
    title: "Restart the worker",
    owner: null,
    owners: [],
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  assert.equal(isCompletedDuringMeeting(noOwner, new Set([segment])), false);

  const noEvidence = workItem({
    ref: "wi_12",
    title: "Restart the worker",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none",
    source_segment_ids: ["99999999-9999-4999-8999-999999999999"] // not in the real transcript
  });
  assert.equal(isCompletedDuringMeeting(noEvidence, new Set([segment])), false);
});

// ---------------------------------------------------------------------------
// Dedup: two near-duplicate completed items for the same owner/action collapse to one.
// ---------------------------------------------------------------------------
test("[dedup] two near-duplicate completed items for the same owner collapse to a single completed-history entry", () => {
  const a = workItem({
    ref: "wi_13a",
    title: "Restart the stuck export worker",
    owner: "Theo",
    owners: ["Theo"],
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  const b = workItem({
    ref: "wi_13b",
    title: "Restart the stuck export worker now",
    owner: "Theo",
    owners: ["Theo"],
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  const assembled = assemble([a, b]);
  assert.equal(assembled.tree.completed_work?.length, 1, "near-duplicate completed items for the same owner must collapse to one");
});
