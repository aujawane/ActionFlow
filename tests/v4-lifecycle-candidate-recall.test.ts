import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  computeLifecycleCandidateObservability,
  isLifecycleReviewCandidate,
  runLifecycleReconciliationPass
} from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemCorrection, RawWorkItem, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Lifecycle candidate-selection recall hardening (generation-9 recall-benchmark follow-up).
//
// Generation 9 showed a circular failure: lifecycle candidate selection excluded a ref whenever its
// classification/acceptance_state/scope_state/execution_scope looked wrong (classification=proposal,
// acceptance_state=proposed, execution_scope=personal_logistics) -- but those are EXACTLY the fields
// lifecycle reconciliation exists to repair. GT1 ("I still need three or four hours of work, then
// I'll send you the usable link" -- extracted as proposal/proposed/future_scope) and GT4 ("I can
// definitely try that with my agent" -- extracted as proposal/proposed/future_scope/
// personal_logistics/idea) were both real, grounded, self-committed statements that never became
// lifecycle candidates and so could never be repaired. These tests prove the widened
// isLifecycleReviewCandidate() admits exactly the right items -- grounded, action-bearing,
// plausibly-misclassified work -- without flooding lifecycle review with genuinely non-action
// content, and that isExecutionEligible's own behavior is completely unchanged.
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
    owner: "Speaker",
    owners: ["Speaker"],
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
    classification: "promise",
    status: "open",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    owner: "Speaker",
    owners: ["Speaker"],
    source_quote: "corrected quote",
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
// PART 1 -- pure-function candidate-selection tests (C1-C6)
// ===========================================================================

test("[C1] GT1-shaped: proposal/proposed/future_scope with grounded self-committed evidence IS a candidate", () => {
  const gt1Shaped = item({
    ref: "wi_1",
    title: "Finish work, launch, send the usable link",
    source_quote: "I still have several hours of security work and then I'll send you the usable link",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "project_work",
    work_item_role: "action"
  });
  assert.equal(isLifecycleReviewCandidate(gt1Shaped), true);
});

test("[C2] action initially marked personal_logistics IS a candidate", () => {
  const screenshotShaped = item({
    ref: "wi_1",
    title: "Take a screenshot of the interface for the project review",
    source_quote: "I'll take a screenshot of the interface for the project review",
    classification: "promise",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "personal_logistics",
    work_item_role: "action"
  });
  assert.equal(isLifecycleReviewCandidate(screenshotShaped), true);

  const troubleshootingRoleShaped = item({
    ref: "wi_2",
    title: "Restart Chrome to fix memory issue",
    source_quote: "yeah i'll do that actually start",
    classification: "assignment",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "personal_logistics",
    work_item_role: "incidental_troubleshooting"
  });
  assert.equal(isLifecycleReviewCandidate(troubleshootingRoleShaped), true, "incidental_troubleshooting role must not itself exclude a candidate");
});

test("[C3] GT4-shaped: proposal/future_scope/personal_logistics/idea-role all at once IS a candidate", () => {
  const gt4Shaped = item({
    ref: "wi_1",
    title: "Try the reversibility approach with the agent",
    source_quote: "I can definitely try the reversibility approach with my agent and see how it works",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "personal_logistics",
    work_item_role: "idea"
  });
  assert.equal(isLifecycleReviewCandidate(gt4Shaped), true, "every broadened dimension combined must still admit a grounded, owned action");
});

test("[C4] true personal logistics is still a candidate (for repair-confirmation), but nothing here implies it becomes eligible", () => {
  const chargeLaptop = item({
    ref: "wi_1",
    title: "Charge laptop",
    source_quote: "I need to charge my laptop after the meeting",
    classification: "promise",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "personal_logistics",
    work_item_role: "action"
  });
  assert.equal(isLifecycleReviewCandidate(chargeLaptop), true);
});

test("[C5] true future idea remains a candidate (for repair-confirmation), independent of eventual eligibility", () => {
  const futureIdea = item({
    ref: "wi_1",
    title: "Redesign onboarding next version",
    source_quote: "maybe in the next version we could redesign onboarding",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "project_work",
    work_item_role: "idea"
  });
  assert.equal(isLifecycleReviewCandidate(futureIdea), true);
});

test("[C6] informational statement is NOT a lifecycle candidate", () => {
  const informational = item({
    ref: "wi_1",
    title: "Chrome memory usage noted",
    source_quote: "chrome uses a lot of memory",
    classification: "completed_work",
    acceptance_state: "none",
    scope_state: "informational",
    execution_scope: "informational",
    work_item_role: "status_update",
    status: "completed"
  });
  assert.equal(isLifecycleReviewCandidate(informational), false, "execution_scope=informational is never broadened -- no future action is attached");
});

test("[safety boundary] structurally non-action roles/classifications stay excluded even with otherwise action-like fields", () => {
  const acceptanceCriterion = item({
    ref: "wi_1", title: "must support X", source_quote: "it needs to support X",
    classification: "open_task", acceptance_state: "accepted", scope_state: "current_scope",
    execution_scope: "project_work", work_item_role: "acceptance_criterion"
  });
  const question = item({
    ref: "wi_2", title: "what timezone", source_quote: "what timezone should we use",
    classification: "question", acceptance_state: "none", scope_state: "current_scope",
    execution_scope: "project_work", work_item_role: "question"
  });
  const reference = item({
    ref: "wi_3", title: "example site", source_quote: "like the site we saw last week",
    classification: "proposal", acceptance_state: "proposed", scope_state: "current_scope",
    execution_scope: "project_work", work_item_role: "reference"
  });
  const scopeDecision = item({
    ref: "wi_4", title: "in-person meetings supported", source_quote: "we will support in-person meetings",
    classification: "decision", acceptance_state: "accepted", scope_state: "future_scope",
    execution_scope: "project_work", work_item_role: "scope_decision"
  });
  const bareDecisionClassification = item({
    ref: "wi_5", title: "decided to use vercel", source_quote: "we decided to use vercel",
    classification: "decision", acceptance_state: "accepted", scope_state: "current_scope",
    execution_scope: "project_work", work_item_role: "action"
  });
  const alreadyCompleted = item({
    ref: "wi_6", title: "sent the file", source_quote: "i already sent the file",
    classification: "completed_work", acceptance_state: "none", scope_state: "current_scope",
    execution_scope: "project_work", work_item_role: "action", status: "completed"
  });

  assert.equal(isLifecycleReviewCandidate(acceptanceCriterion), false);
  assert.equal(isLifecycleReviewCandidate(question), false);
  assert.equal(isLifecycleReviewCandidate(reference), false);
  assert.equal(isLifecycleReviewCandidate(scopeDecision), false);
  assert.equal(isLifecycleReviewCandidate(bareDecisionClassification), false, "classification=decision stays excluded even with action-shaped role/scope");
  assert.equal(isLifecycleReviewCandidate(alreadyCompleted), false);
});

// ===========================================================================
// PART 2 -- pipeline-boundary tests via the real runLifecycleReconciliationPass
// ===========================================================================

test("[pipeline / C1] proposal does not automatically exclude action-like grounded work from repair -- GT1-shaped item is repaired to eligible", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "I still have several hours of security work and then I'll send you the usable link"
  );
  const gt1Shaped = item({
    ref: "wi_1",
    title: "Finish work, launch, send the usable link",
    source_quote: "I still have several hours of security work and then I'll send you the usable link",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "project_work",
    work_item_role: "action",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [gt1Shaped],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "promise",
          acceptance_state: "accepted",
          scope_state: "current_scope",
          source_quote: "I still have several hours of security work and then I'll send you the usable link",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Genuine self-committed acceptance with a concrete timeline, not a mere proposal."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reviews.length, 1);
  assert.equal(result.lifecycleCandidatesConsidered, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaProposal, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaFutureScope, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaProposedAcceptance, 1);
  assert.equal(result.lifecycleRepairedAcceptanceState, 1);
  assert.equal(result.lifecycleRepairedScopeState, 1);

  const merged = applyGlobalCorrections({ workItems: [gt1Shaped], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true, "GT1-shaped item must reach eligibility once lifecycle repairs it");
});

test("[pipeline / C2] personal_logistics does not automatically exclude a misclassified project action from repair", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll take a screenshot of the interface for the project review");
  const screenshotShaped = item({
    ref: "wi_1",
    title: "Take a screenshot of the interface for the project review",
    source_quote: "I'll take a screenshot of the interface for the project review",
    classification: "promise",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "personal_logistics",
    work_item_role: "action",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [screenshotShaped],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          execution_scope: "project_work",
          source_quote: "I'll take a screenshot of the interface for the project review",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "The screenshot serves the project review, not a personal errand."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lifecycleCandidatesAdmittedViaPersonalLogistics, 1);
  assert.equal(result.lifecycleRepairedExecutionScope, 1);

  const merged = applyGlobalCorrections({ workItems: [screenshotShaped], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[pipeline / C3] GT4-shaped item (proposal + future_scope + personal_logistics + idea role, all at once) is repaired to eligible", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I can definitely try the reversibility approach with my agent and see how it works");
  const gt4Shaped = item({
    ref: "wi_1",
    title: "Try the reversibility approach with the agent",
    source_quote: "I can definitely try the reversibility approach with my agent and see how it works",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "personal_logistics",
    work_item_role: "idea",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [gt4Shaped],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "promise",
          acceptance_state: "accepted",
          scope_state: "current_scope",
          execution_scope: "project_work",
          work_item_role: "action",
          source_quote: "I can definitely try the reversibility approach with my agent and see how it works",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Voluntary, concrete commitment to try the approach with the agent -- a real accepted experiment, not a hedge."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lifecycleCandidatesAdmittedViaProposal, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaFutureScope, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaPersonalLogistics, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaProposedAcceptance, 1);
  assert.equal(result.lifecycleRepairedExecutionScope, 1);
  assert.equal(result.lifecycleRepairedAcceptanceState, 1);
  assert.equal(result.lifecycleRepairedScopeState, 1);

  const merged = applyGlobalCorrections({ workItems: [gt4Shaped], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true, "GT4-shaped item must reach eligibility once lifecycle repairs every broadened field");
});

test("[pipeline / C4] true personal logistics reaches lifecycle review but is correctly kept ineligible when echoed unchanged", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I need to charge my laptop after the meeting");
  const chargeLaptop = item({
    ref: "wi_1",
    title: "Charge laptop",
    source_quote: "I need to charge my laptop after the meeting",
    classification: "promise",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "personal_logistics",
    work_item_role: "action",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [chargeLaptop],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          execution_scope: "personal_logistics",
          source_quote: "I need to charge my laptop after the meeting",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Genuine personal logistics with no project deliverable attached; execution_scope confirmed unchanged."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lifecycleCandidatesAdmittedViaPersonalLogistics, 1, "it was still shown to lifecycle for confirmation");
  assert.equal(result.lifecycleRepairedExecutionScope, 0, "lifecycle correctly did not repair a genuinely personal action");

  const merged = applyGlobalCorrections({ workItems: [chargeLaptop], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false, "reaching candidacy never implies automatic eligibility");
});

test("[pipeline / C5] true future idea reaches lifecycle review but remains future_scope/ineligible when echoed unchanged", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "maybe in the next version we could redesign onboarding");
  const futureIdea = item({
    ref: "wi_1",
    title: "Redesign onboarding next version",
    source_quote: "maybe in the next version we could redesign onboarding",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "project_work",
    work_item_role: "idea",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [futureIdea],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "proposal",
          acceptance_state: "proposed",
          scope_state: "future_scope",
          work_item_role: "idea",
          source_quote: "maybe in the next version we could redesign onboarding",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Genuinely speculative next-version idea with no current commitment; confirmed unchanged."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [futureIdea], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[pipeline / C6] informational content is never selected as a lifecycle candidate -- reviews array is empty, no model call needed", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "chrome uses a lot of memory");
  const informational = item({
    ref: "wi_1",
    title: "Chrome memory usage noted",
    source_quote: "chrome uses a lot of memory",
    classification: "completed_work",
    acceptance_state: "none",
    scope_state: "informational",
    execution_scope: "informational",
    work_item_role: "status_update",
    status: "completed",
    source_segment_ids: [seg(1)]
  });

  let modelCalled = false;
  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [informational],
    createResponse: async () => {
      modelCalled = true;
      return { output_text: JSON.stringify({ reviews: [] }) };
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lifecycleCandidatesConsidered, 0, "clearly non-action content must not flood lifecycle review");
  assert.equal(modelCalled, false, "no model call is even made when there are zero candidates");
});

test("[pipeline / C7] voluntary promise with no prior request is repaired to accepted current-scope work", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Laura the article tonight");
  const voluntaryPromise = item({
    ref: "wi_1",
    title: "Send Laura the article",
    source_quote: "I'll send Laura the article tonight",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "current_scope",
    execution_scope: "project_work",
    work_item_role: "action",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [voluntaryPromise],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "promise",
          acceptance_state: "accepted",
          source_quote: "I'll send Laura the article tonight",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Voluntary promise -- no prior request required for acceptance."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [voluntaryPromise], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[pipeline / C8] work committed now but executed later stays current_scope, not future_scope, merely because of timing", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll finish the migration tomorrow");
  const committedNow = item({
    ref: "wi_1",
    title: "Finish the migration",
    source_quote: "I'll finish the migration tomorrow",
    classification: "promise",
    acceptance_state: "accepted",
    scope_state: "current_scope",
    execution_scope: "project_work",
    work_item_role: "action",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [committedNow],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          scope_state: "current_scope",
          source_quote: "I'll finish the migration tomorrow",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Committed now, even though execution happens tomorrow -- timing alone is not future_scope."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [committedNow], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "current_scope");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[critical] reaching candidacy never implies automatic eligibility -- lifecycle still decides", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I can definitely try the reversibility approach with my agent and see how it works");
  const gt4Shaped = item({
    ref: "wi_1",
    title: "Try the reversibility approach with the agent",
    source_quote: "I can definitely try the reversibility approach with my agent and see how it works",
    classification: "proposal",
    acceptance_state: "proposed",
    scope_state: "future_scope",
    execution_scope: "personal_logistics",
    work_item_role: "idea",
    source_segment_ids: [seg(1)]
  });

  // Lifecycle reviews it (it IS a candidate) but this time judges it genuinely NOT yet accepted --
  // echoes every field back unchanged.
  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [gt4Shaped],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "proposal",
          acceptance_state: "proposed",
          scope_state: "future_scope",
          execution_scope: "personal_logistics",
          work_item_role: "idea",
          source_quote: "I can definitely try the reversibility approach with my agent and see how it works",
          source_segment_ids: [seg(1)],
          reconciliation_reason: "Confirmed as genuinely not yet committed in this hypothetical variant."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reviews.length, 1, "the item WAS reviewed -- candidacy worked");
  const merged = applyGlobalCorrections({ workItems: [gt4Shaped], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false, "candidacy alone never grants eligibility -- only a lifecycle repair that actually changes the fields can");
});

// ===========================================================================
// PART 3 -- computeLifecycleCandidateObservability unit coverage
// ===========================================================================

test("[unit] computeLifecycleCandidateObservability tallies admissions and repairs independently per field", () => {
  const candidates = [
    item({ ref: "wi_1", title: "a", source_quote: "q", classification: "proposal", acceptance_state: "proposed", scope_state: "future_scope", execution_scope: "personal_logistics", work_item_role: "idea" }),
    item({ ref: "wi_2", title: "b", source_quote: "q", classification: "promise", acceptance_state: "accepted", scope_state: "current_scope", execution_scope: "project_work", work_item_role: "action" })
  ];
  const reviews: GlobalWorkItemCorrection[] = [
    correction({ ref: "wi_1", classification: "promise", acceptance_state: "accepted", scope_state: "current_scope", execution_scope: "project_work" }),
    correction({ ref: "wi_2", classification: "promise", acceptance_state: "accepted", scope_state: "current_scope", execution_scope: "project_work" })
  ];
  const result = computeLifecycleCandidateObservability(candidates, reviews);
  assert.equal(result.lifecycleCandidatesConsidered, 2);
  assert.equal(result.lifecycleCandidatesAdmittedViaProposal, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaFutureScope, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaPersonalLogistics, 1);
  assert.equal(result.lifecycleCandidatesAdmittedViaProposedAcceptance, 1);
  // wi_1 was repaired on all three fields; wi_2 was already correct, so its "corrected" values are
  // identical to its originals and must not count as a repair.
  assert.equal(result.lifecycleRepairedExecutionScope, 1);
  assert.equal(result.lifecycleRepairedAcceptanceState, 1);
  assert.equal(result.lifecycleRepairedScopeState, 1);
});

test("[unit] computeLifecycleCandidateObservability returns all zeros for an empty candidate set", () => {
  const result = computeLifecycleCandidateObservability([], []);
  assert.deepEqual(result, {
    lifecycleCandidatesConsidered: 0,
    lifecycleCandidatesAdmittedViaProposal: 0,
    lifecycleCandidatesAdmittedViaFutureScope: 0,
    lifecycleCandidatesAdmittedViaPersonalLogistics: 0,
    lifecycleCandidatesAdmittedViaProposedAcceptance: 0,
    lifecycleRepairedExecutionScope: 0,
    lifecycleRepairedAcceptanceState: 0,
    lifecycleRepairedScopeState: 0
  });
});
