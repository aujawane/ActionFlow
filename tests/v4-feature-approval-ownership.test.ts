import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import {
  assembleExecutionTree,
  isEligibleAcceptanceCriterion,
  isExecutionEligible
} from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { runLifecycleReconciliationPass } from "../lib/execution-intelligence/work-item-stages";
import type {
  GlobalWorkItemCorrection,
  GroupProposal,
  RawWorkItem,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Feature-approval-is-not-implementation-ownership (forensic-audit follow-up, real production
// trace). The audit found "Implement try again button to redo prompt" persisted as a Kevin-owned
// commitment: Cameron proposed the feature ("let's just do a try again button and then you would
// redo the prompt"), Kevin merely approved it ("that sounds good") -- Kevin never committed to
// personally build anything, yet extraction set owner=Kevin/classification=accepted_request/
// work_item_role=action, lifecycle reconciliation echoed it back unchanged, grouping therefore
// never claimed it (it looks like an independently-owned action by a different person than the
// group's accountable owner), and explicit-deliverable recovery promoted it into its own
// nonsensical singleton commitment. This is a pure prompt change (LIFECYCLE_RECONCILIATION_PROMPT's
// new FEATURE-APPROVAL VS IMPLEMENTATION-OWNERSHIP RULE) -- no code changes were needed in
// execution-tree.ts (recovery) or grouping, since a work_item_role=acceptance_criterion item
// structurally never reaches the standalone/recovery path at all (see assembleExecutionTree: an
// isEligibleAcceptanceCriterion item is routed to the acceptance-criterion bucket before
// isExecutionEligible/standalone/recovery ever sees it). These tests prove that EXISTING,
// unmodified pipeline machinery already does the right thing once lifecycle reconciliation resolves
// to the correct classification/role/owner -- they do not and cannot test prompt wording itself.
// ---------------------------------------------------------------------------

function seg(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function fakeModelResponse(payload: unknown) {
  return async () => ({ output_text: JSON.stringify(payload) });
}

function source(overrides: Partial<ExecutionSourceContext> & { transcript: string }): ExecutionSourceContext {
  return {
    meetingId: "meeting-1",
    meetingDate: "2026-01-01",
    topics: [],
    insights: [],
    ...overrides
  };
}

function transcriptLine(id: string, speaker: string, text: string) {
  return `[${id}] [2026-01-01T00:00:00.000Z] ${speaker}: ${text}`;
}

function rawItem(overrides: Partial<RawWorkItem> & { title: string; source_quote: string }): RawWorkItem {
  return {
    description: null,
    owner: "B",
    owners: ["B"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "accepted_request",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "Fixture.",
    source_segment_ids: [seg(1)],
    extraction_reason: "Fixture.",
    confidence: 0.9,
    ...overrides
  };
}

function item(overrides: Partial<WorkItem> & { ref: string; title: string; source_quote: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
}

function correction(overrides: Partial<GlobalWorkItemCorrection> & { ref: string }): GlobalWorkItemCorrection {
  return {
    classification: "accepted_request",
    status: "open",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    owner: "B",
    owners: ["B"],
    source_quote: "that sounds good",
    source_segment_ids: [seg(2)],
    classification_reason: "Fixture correction.",
    reconciliation_reason: null,
    superseding_segment_ids: [],
    superseded_item_refs: [],
    completion_segment_ids: [],
    completion_reason: null,
    ...overrides
  };
}

// ===========================================================================
// Test 1 -- approval-only is never enough for individual implementation ownership
// ===========================================================================

test("[Test 1] B merely approving A's proposed feature is NOT treated as B owning an accepted_request/action, even though C is the real implementer elsewhere", async () => {
  const transcript = [
    transcriptLine(seg(1), "A", "let's add a retry button, and then you would redo the prompt"),
    transcriptLine(seg(2), "B", "that sounds good"),
    transcriptLine(seg(3), "C", "I'll build the retry button")
  ].join("\n");

  // The mis-extracted starting state, exactly mirroring the real production item: classification=
  // accepted_request, work_item_role=action, owner=B, grounded in B's approval utterance.
  const feature = item({
    ref: "wi_1",
    title: "Implement retry button to redo prompt",
    source_quote: "that sounds good",
    source_segment_ids: [seg(2)],
    owner: "B",
    owners: ["B"],
    classification: "accepted_request",
    work_item_role: "action"
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [feature],
    // Simulates the CORRECTED lifecycle resolution the new FEATURE-APPROVAL VS
    // IMPLEMENTATION-OWNERSHIP RULE calls for: decision-shaped, no individually-accountable owner.
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "decision",
          work_item_role: "acceptance_criterion",
          owner: null,
          owners: [],
          reconciliation_reason: "B's 'that sounds good' approves A's proposed feature; it is not B committing to personally build it, and no other evidence shows B will implement it."
        })
      ]
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const merged = applyGlobalCorrections({ workItems: [feature], corrections: result.reviews, additions: [], transcript });
  const resolved = merged[0];

  assert.equal(resolved.owner, null, "approval alone must never leave B as an individually-accountable owner");
  assert.equal(resolved.classification, "decision");
  assert.equal(resolved.work_item_role, "acceptance_criterion");
  assert.equal(isExecutionEligible(resolved), false, "a decision/acceptance-criterion item must never be independently execution-eligible as its own action");
  assert.equal(isEligibleAcceptanceCriterion(resolved), true, "it must instead become visible to grouping as a requirement");
});

// ===========================================================================
// Test 2 -- regression guard: a genuine later self-commitment still correctly assigns ownership
// ===========================================================================

test("[Test 2] B approving a feature, then LATER independently committing to build it, correctly becomes B's accepted_request/action (no over-correction)", async () => {
  const transcript = [
    transcriptLine(seg(1), "A", "let's add a retry button"),
    transcriptLine(seg(2), "B", "that sounds good"),
    transcriptLine(seg(3), "B", "I'll build that")
  ].join("\n");

  const feature = item({
    ref: "wi_1",
    title: "Implement retry button",
    source_quote: "that sounds good",
    source_segment_ids: [seg(2)],
    owner: "B",
    owners: ["B"],
    classification: "accepted_request",
    work_item_role: "action"
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [feature],
    // B's own later words ("I'll build that") are independent, genuine self-commitment evidence --
    // the fix must not force every approval-shaped item into decision/acceptance_criterion
    // regardless of what else the transcript shows.
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "accepted_request",
          work_item_role: "action",
          owner: "B",
          owners: ["B"],
          source_quote: "I'll build that",
          source_segment_ids: [seg(3)],
          reconciliation_reason: "B independently commits, in his own words, to personally build the retry button in segment 3 -- this is genuine self-commitment, not mere approval."
        })
      ]
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const merged = applyGlobalCorrections({ workItems: [feature], corrections: result.reviews, additions: [], transcript });
  const resolved = merged[0];

  assert.equal(resolved.owner, "B");
  assert.equal(resolved.classification, "accepted_request");
  assert.equal(resolved.work_item_role, "action");
  assert.equal(isExecutionEligible(resolved), true, "a genuine self-commitment must remain a real, owned, eligible action");
});

// ===========================================================================
// Test 3 -- full pipeline path: approval-only never becomes a standalone recovered commitment
// ===========================================================================

function verifiedGroup(
  overrides: Partial<VerifiedGroup> & {
    ref: string | null;
    title: string;
    member_refs: string[];
    group_basis: VerifiedGroup["group_basis"];
  }
): VerifiedGroup {
  return {
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    acceptance_criteria_refs: [],
    purpose_reason: "Shared purpose.",
    explicit_outcome_evidence: null,
    ...overrides
  };
}

function assemble(input: { workItems: WorkItem[]; draftGroups?: GroupProposal[]; verifiedGroups?: VerifiedGroup[]; transcript: string }) {
  return assembleExecutionTree({
    transcript: input.transcript,
    workItems: input.workItems,
    draftGroups: input.draftGroups ?? [],
    verifiedGroups: input.verifiedGroups ?? []
  });
}

test("[Test 3a] a decision-shaped feature-approval item is never promoted into its own commitment by explicit-deliverable recovery, even when no group claims it", () => {
  const transcript = `[${seg(1)}] A: let's add a retry button.`;
  // Already in the CORRECTED post-lifecycle-reconciliation shape.
  const decisionItem = item({
    ref: "wi_1",
    title: "Add a retry button instead of editing generated output",
    source_quote: "that sounds good",
    source_segment_ids: [seg(1)],
    owner: null,
    owners: [],
    classification: "decision",
    work_item_role: "acceptance_criterion",
    acceptance_state: "accepted"
  });

  const result = assemble({ workItems: [decisionItem], verifiedGroups: [], transcript });

  assert.equal(result.tree.commitments.length, 0, "no commitment -- least of all one owned by the approver -- is fabricated from approval alone");
  assert.equal(result.tree.standalone_tasks.length, 0, "a decision/acceptance-criterion item never enters the standalone-task pool recovery operates on");
  const decision = result.workItemDecisions.find((d) => d.work_item_ref === "wi_1");
  assert.equal(decision?.disposition, "acceptance_criterion");
  assert.equal(decision?.claimed_group_ref, null, "unattached, but never promoted to its own commitment either");
});

test("[Test 3b] the same decision-shaped item correctly attaches as an acceptance criterion when the real implementation group claims it", () => {
  const transcript = `[${seg(1)}] A: let's add a retry button.`;
  const decisionItem = item({
    ref: "wi_1",
    title: "Add a retry button instead of editing generated output",
    source_quote: "that sounds good",
    source_segment_ids: [seg(1)],
    owner: null,
    owners: [],
    classification: "decision",
    work_item_role: "acceptance_criterion",
    acceptance_state: "accepted"
  });
  const implementationAction = item({
    ref: "wi_2",
    title: "Build the video-generation agent workflow",
    source_quote: "my end goal is to deliver an agent workflow",
    source_segment_ids: [seg(1)],
    owner: "Aditya",
    owners: ["Aditya"],
    classification: "accepted_request",
    work_item_role: "action"
  });

  const verified = [
    verifiedGroup({
      ref: null,
      title: "Build the video-generation agent workflow",
      owner: "Aditya",
      owners: ["Aditya"],
      member_refs: ["wi_2"],
      acceptance_criteria_refs: ["wi_1"],
      group_basis: "explicit_deliverable"
    })
  ];

  const result = assemble({ workItems: [decisionItem, implementationAction], verifiedGroups: verified, transcript });

  assert.equal(result.tree.commitments.length, 1);
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.owner, "Aditya", "the real implementation owner, never the approver");
  assert.deepEqual(commitment.acceptance_criteria.map((c) => c.ref), ["wi_1"]);
});
