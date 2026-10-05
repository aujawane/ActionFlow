import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { assembleExecutionTree, isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import { isLifecycleReviewCandidate, runLifecycleReconciliationPass } from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemCorrection, RawWorkItem, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Repair executable actions mistagged as scope_decision (forensic-audit follow-up, real
// production trace). "Aditya: ...I'll text you about like timings and everything... I think we
// should set up like a weekly meeting here. Kevin: yeah." was extracted as classification=
// scheduling, work_item_role=scope_decision -- which, before this fix, LIFECYCLE_REVIEW_ROLES
// excluded entirely, so lifecycle reconciliation never even saw it as a candidate. It was
// therefore invisible to eligibility, grouping, and recovery, and silently disappeared from the
// final output despite Aditya explicitly committing to a concrete future action (texting Kevin to
// coordinate). scope_decision is NOT made executable by default -- only reviewable, exactly like
// idea/future_feature/incidental_troubleshooting already are, so lifecycle gets the chance to
// repair it when (and only when) the item's own evidence shows a genuine self-committed action.
// ---------------------------------------------------------------------------

function seg(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function fakeModelResponse(payload: unknown) {
  return async () => ({ output_text: JSON.stringify(payload) });
}

function countingResponse(payload: unknown) {
  const state = { calls: 0 };
  const createResponse = async () => {
    state.calls += 1;
    return { output_text: JSON.stringify(payload) };
  };
  return { createResponse, state };
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
    owner: "Aditya",
    owners: ["Aditya"],
    requester: null,
    recipient: "Kevin",
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "scheduling",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "scope_decision",
    classification_reason: "Fixture.",
    source_segment_ids: [seg(1)],
    extraction_reason: "Fixture.",
    confidence: 0.9,
    ...overrides
  };
}

function schedulingItem(overrides: Partial<WorkItem> & { ref: string; title: string; source_quote: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
}

function correction(overrides: Partial<GlobalWorkItemCorrection> & { ref: string }): GlobalWorkItemCorrection {
  return {
    classification: "scheduling",
    status: "open",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "scope_decision",
    owner: "Aditya",
    owners: ["Aditya"],
    source_quote: "fixture quote",
    source_segment_ids: [seg(1)],
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
// Unit: isLifecycleReviewCandidate now admits scope_decision for inspection
// ===========================================================================

test("[unit] a scope_decision item is now a lifecycle-review candidate (admitted for inspection, not made executable by this alone)", () => {
  const candidate = schedulingItem({
    ref: "wi_1",
    title: "Set up recurring weekly meeting with Kevin",
    source_quote: "I think we should set up like a weekly meeting here",
    work_item_role: "scope_decision"
  });
  assert.equal(isLifecycleReviewCandidate(candidate), true);
  // Admission alone does not change eligibility -- scope_decision is still not an eligible role.
  assert.equal(isExecutionEligible(candidate), false);
});

// ===========================================================================
// Test 1 -- explicit self-commitment repairs scope_decision -> action
// ===========================================================================

test("[Test 1] a scope_decision item whose evidence contains a genuine self-committed future action is repaired to work_item_role=action and becomes execution-eligible", async () => {
  const transcript = [
    transcriptLine(seg(1), "Cameron", "I think y'all should set one up"),
    transcriptLine(
      seg(2),
      "Aditya",
      "so i'll text you about like timings and everything like what works for you what works for me and i think we should set up like a weekly meeting here"
    ),
    transcriptLine(seg(3), "Kevin", "yeah")
  ].join("\n");

  const meetingItem = schedulingItem({
    ref: "wi_16",
    title: "Set up a recurring weekly meeting with Kevin",
    source_quote:
      "so i'll text you about like timings and everything like what works for you what works for me and i think we should set up like a weekly meeting here",
    source_segment_ids: [seg(2)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [meetingItem],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_16",
          classification: "accepted_request",
          work_item_role: "action",
          owner: "Aditya",
          owners: ["Aditya"],
          source_quote:
            "so i'll text you about like timings and everything like what works for you what works for me and i think we should set up like a weekly meeting here",
          source_segment_ids: [seg(2)],
          reconciliation_reason: "Aditya explicitly commits to personally text Kevin to coordinate and set up the weekly meeting -- a genuine self-committed future action, not merely a cadence decision."
        })
      ]
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const merged = applyGlobalCorrections({ workItems: [meetingItem], corrections: result.reviews, additions: [], transcript });
  const resolved = merged[0];
  assert.equal(resolved.work_item_role, "action");
  assert.equal(resolved.classification, "accepted_request");
  assert.equal(resolved.owner, "Aditya");
  assert.equal(isExecutionEligible(resolved), true, "the repaired item must survive as real executable work");
});

// ===========================================================================
// Test 2 -- a pure scheduling decision stays scope_decision, stays non-executable
// ===========================================================================

test("[Test 2] a pure scheduling/cadence decision with no embedded self-commitment stays scope_decision and remains non-executable", async () => {
  const transcript = [
    transcriptLine(seg(1), "Cameron", "let's meet every two weeks"),
    transcriptLine(seg(2), "Kevin", "sounds good")
  ].join("\n");

  const cadenceItem = schedulingItem({
    ref: "wi_1",
    title: "Meet every two weeks",
    source_quote: "let's meet every two weeks",
    source_segment_ids: [seg(1)]
  });

  const { createResponse, state: calls } = countingResponse({
    reviews: [
      correction({
        ref: "wi_1",
        // Lifecycle correctly echoes it back unchanged -- no self-committed action in evidence.
        classification: "scheduling",
        work_item_role: "scope_decision",
        reconciliation_reason: null
      })
    ]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [cadenceItem],
    createResponse
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(calls.calls, 1, "the item is reviewed (admitted as a candidate)");

  const merged = applyGlobalCorrections({ workItems: [cadenceItem], corrections: result.reviews, additions: [], transcript });
  const resolved = merged[0];
  assert.equal(resolved.work_item_role, "scope_decision", "a pure decision must never be manufactured into an action");
  assert.equal(isExecutionEligible(resolved), false, "must remain non-executable");
});

// ===========================================================================
// Test 3 -- full pipeline: repaired item survives as standalone, no fabricated parent commitment
// ===========================================================================

test("[Test 3] the repaired scheduling action never becomes a fabricated or wrongly-grouped commitment -- it is either genuinely standalone, or (per the existing, unmodified explicit-deliverable recovery rule for classification=accepted_request) a clean one-member singleton correctly traced to itself", () => {
  const transcript = `[${seg(1)}] Aditya: I'll text you about timings and set up a weekly meeting.`;
  // Already in the corrected, post-lifecycle-reconciliation shape. No recipient/due_date -- Kevin
  // here is the meeting counterpart being coordinated with, not a deliverable handoff target.
  const repaired = schedulingItem({
    ref: "wi_16",
    title: "Set up a recurring weekly meeting with Kevin",
    source_quote: "I'll text you about timings and set up a weekly meeting",
    source_segment_ids: [seg(1)],
    classification: "accepted_request",
    work_item_role: "action",
    owner: "Aditya",
    owners: ["Aditya"],
    recipient: null
  });

  // Also present: Aditya's real, unrelated implementation work, to prove the scheduling action is
  // never folded into it -- the actual concern this test guards against.
  const implementationAction = schedulingItem({
    ref: "wi_3",
    title: "Deliver the video-generation agent workflow",
    source_quote: "my end goal is to deliver an agent workflow",
    source_segment_ids: [seg(1)],
    classification: "accepted_request",
    work_item_role: "action",
    owner: "Aditya",
    owners: ["Aditya"]
  });

  const result = assembleExecutionTree({
    transcript,
    workItems: [repaired, implementationAction],
    draftGroups: [],
    verifiedGroups: []
  });

  // classification=accepted_request alone is already sufficient, existing, unmodified recovery
  // evidence (see hasExplicitDeliverableEvidence in execution-tree.ts) -- a genuinely self-
  // committed action is EXPECTED to become its own singleton commitment via recovery, exactly like
  // every other recovered_N commitment observed throughout this project's prior audits. Fix A must
  // not prevent that; it must only ensure the result is never fabricated or wrongly attached.
  const schedulingCommitment = result.tree.commitments.find((c) =>
    c.tasks.some((t) => t.ref === "wi_16")
  );
  assert.ok(schedulingCommitment, "the repaired item must survive, in some correct form, not vanish");
  assert.equal(schedulingCommitment!.tasks.length, 1, "it must never be folded into a larger group as a side effect of this fix");
  assert.equal(schedulingCommitment!.tasks[0].ref, "wi_16");
  assert.equal(schedulingCommitment!.owner, "Aditya", "owner must be exactly who the transcript shows committing, never fabricated");
  assert.equal(schedulingCommitment!.title, "Set up a recurring weekly meeting with Kevin", "title must trace directly to the item itself, never invented");

  // The unrelated implementation work must remain completely separate -- confirms no accidental
  // merging of the two distinct commitments.
  const implementationCommitment = result.tree.commitments.find((c) => c.tasks.some((t) => t.ref === "wi_3"));
  assert.notEqual(implementationCommitment?.ref, schedulingCommitment?.ref, "the scheduling action and the real implementation work must never share one commitment");
});
