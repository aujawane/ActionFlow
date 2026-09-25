import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  buildTranscriptPositionIndex,
  isCompletionDecision,
  revertCompletionFields,
  runLifecycleReconciliationPass,
  validateCompletionEvidence
} from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemCorrection, RawWorkItem, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Temporal-completion precision hardening (generation-8 staging benchmark follow-up).
//
// Generation 8 showed the broad lifecycle-reconciliation judgment alone marked a genuinely
// still-open item (GT1: "finish security work, launch, send the link") completed on the basis of
// "the demo and ongoing discussions" -- unrelated topic proximity, not evidence that the SAME
// action was performed. These tests exercise the real programmatic evidence/chronology gate and
// the real targeted completion verifier via the actual runLifecycleReconciliationPass orchestration
// (mocked model calls, not just prompt-string assertions), proving the pipeline itself -- not
// prompt wording -- is what prevents a repeat of that regression.
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

function lifecycleCandidate(overrides: Partial<WorkItem> & { ref: string; title: string; source_quote: string }) {
  return item({
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action",
    ...overrides
  });
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

function completedCorrection(
  overrides: Partial<GlobalWorkItemCorrection> & { ref: string }
): GlobalWorkItemCorrection {
  return correction({
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    ...overrides
  });
}

function verifierResponse(confirmed: boolean, reasoning: string, supportingSegmentIds: string[] = []) {
  return fakeModelResponse({ confirmed, reasoning, supporting_segment_ids: supportingSegmentIds });
}

// ===========================================================================
// PART 1 -- pure-function unit coverage of the evidence/chronology gate
// ===========================================================================

test("[unit] isCompletionDecision fires on EITHER status=completed or classification=completed_work independently (the exact generation-8 gap)", () => {
  assert.equal(isCompletionDecision(correction({ ref: "wi_1", status: "completed", classification: "promise" })), true);
  assert.equal(isCompletionDecision(correction({ ref: "wi_1", status: "open", classification: "completed_work" })), true);
  assert.equal(isCompletionDecision(correction({ ref: "wi_1", status: "open", classification: "promise" })), false);
});

test("[unit] validateCompletionEvidence rejects an empty completion_segment_ids array", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [seg(1)] });
  const positions = buildTranscriptPositionIndex(
    [transcriptLine(seg(1), "A", "x"), transcriptLine(seg(2), "A", "y")].join("\n")
  );
  const result = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [] }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "missing_evidence" });
});

test("[unit] validateCompletionEvidence rejects a completion segment ID absent from this transcript", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [seg(1)] });
  const positions = buildTranscriptPositionIndex(
    [transcriptLine(seg(1), "A", "x"), transcriptLine(seg(2), "A", "y")].join("\n")
  );
  const result = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(99)] }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_segment" });
});

test("[unit / N7] validateCompletionEvidence rejects completion evidence at or before the origin position (strictly-after, not at-or-after)", () => {
  const transcript = [transcriptLine(seg(1), "A", "origin"), transcriptLine(seg(2), "A", "same or later")].join("\n");
  const positions = buildTranscriptPositionIndex(transcript);
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "origin", source_segment_ids: [seg(2)] });

  // Completion segment BEFORE origin.
  const before = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(1)] }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(before, { ok: false, reason: "chronology" });

  // Completion segment EQUAL to origin (same segment cited as its own completion evidence).
  const same = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)] }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(same, { ok: false, reason: "chronology" });

  // Completion segment strictly after origin -- passes.
  const after = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(1)] }),
    transcriptPositionIndex: buildTranscriptPositionIndex(
      [transcriptLine(seg(2), "A", "origin"), transcriptLine(seg(1), "A", "later")].join("\n")
    )
  });
  assert.deepEqual(after, { ok: true });
});

test("[unit] validateCompletionEvidence fails closed when the item's own origin evidence cannot be positioned in this transcript", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [] });
  const positions = buildTranscriptPositionIndex(transcriptLine(seg(1), "A", "x"));
  const result = validateCompletionEvidence({
    originalItem,
    correction: completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(1)] }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "chronology" });
});

test("[unit] revertCompletionFields reverts exactly status/classification/acceptance_state/completion fields, preserves everything else", () => {
  const originalItem = item({
    ref: "wi_1",
    title: "t",
    source_quote: "q",
    status: "open",
    classification: "promise",
    acceptance_state: "accepted"
  });
  const proposedCompletion = completedCorrection({
    ref: "wi_1",
    owner: "New Owner",
    owners: ["New Owner"],
    scope_state: "future_scope",
    completion_segment_ids: [seg(2)],
    completion_reason: "some claim"
  });
  const reverted = revertCompletionFields(proposedCompletion, originalItem, "rejected for test");
  assert.equal(reverted.status, "open");
  assert.equal(reverted.classification, "promise");
  assert.equal(reverted.acceptance_state, "accepted");
  assert.deepEqual(reverted.completion_segment_ids, []);
  assert.equal(reverted.completion_reason, null);
  assert.equal(reverted.reconciliation_reason, "rejected for test");
  // Unrelated fields the model proposed are NOT reverted -- this gate is completion-only.
  assert.equal(reverted.owner, "New Owner");
  assert.deepEqual(reverted.owners, ["New Owner"]);
  assert.equal(reverted.scope_state, "future_scope");
});

// ===========================================================================
// PART 2 -- GT1 regression: the exact generation-8 failure class, via the real pipeline
// ===========================================================================

test("[GT1 regression / structural gate] a completion decision with no completion_segment_ids is rejected before the verifier is ever called, item stays open", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I still need three or four hours of work, then I can send you the usable product link"),
    transcriptLine(seg(2), "Person A", "walk me through the product"),
    transcriptLine(seg(3), "Speaker", "sure, here's how it works"),
    transcriptLine(seg(4), "Person A", "this looks great, very promising")
  ].join("\n");
  const remainingWork = lifecycleCandidate({
    ref: "wi_1",
    title: "Finish work, launch, send the usable link",
    source_quote: "I still need three or four hours of work, then I can send you the usable product link",
    source_segment_ids: [seg(1)]
  });

  const { createResponse: createVerificationResponse, state: verifierCalls } = countingResponse({
    confirmed: true,
    reasoning: "should never be reached",
    supporting_segment_ids: []
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [remainingWork],
    // Reproduces the exact generation-8 shape: status flips to completed, classification stays
    // "promise" (not even completed_work), reconciliation_reason cites unrelated later discussion,
    // and -- critically -- completion_segment_ids is empty, exactly like the real regression.
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "promise",
          status: "completed",
          reconciliation_reason: "Made completed since the demo and ongoing discussions indicate the promise is fulfilled or nearly fulfilled.",
          source_quote: "I still need three or four hours of work, then I can send you the usable product link",
          source_segment_ids: [seg(1)]
        })
      ]
    }),
    createVerificationResponse
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionProposals, 1);
  assert.equal(result.completionRejectedMissingEvidence, 1);
  assert.equal(result.completionVerified, 0);
  assert.equal(verifierCalls.calls, 0, "the targeted verifier must never be called when the structural gate already rejects");

  const merged = applyGlobalCorrections({ workItems: [remainingWork], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "open", "the item must remain exactly as it was -- not silently closed");
  assert.equal(isExecutionEligible(merged[0]), true, "a real outstanding commitment must never be closed by unrelated later discussion");
});

test("[GT1 regression / semantic gate] a completion decision citing structurally-valid but merely topic-related later segments is rejected by the targeted verifier", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I still need three or four hours of work, then I can send you the usable product link"),
    transcriptLine(seg(2), "Person A", "walk me through the product"),
    transcriptLine(seg(3), "Speaker", "sure, here's how it works, let's say you open it up and review your history"),
    transcriptLine(seg(4), "Person A", "this looks great, very promising")
  ].join("\n");
  const remainingWork = lifecycleCandidate({
    ref: "wi_1",
    title: "Finish work, launch, send the usable link",
    source_quote: "I still need three or four hours of work, then I can send you the usable product link",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [remainingWork],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({
          ref: "wi_1",
          reconciliation_reason: "The demo and ongoing discussion indicate the promise is fulfilled.",
          completion_segment_ids: [seg(3)],
          completion_reason: "A demo of the product was given."
        })
      ]
    }),
    createVerificationResponse: verifierResponse(
      false,
      "Seg 3 demonstrates the product being demoed, not that the remaining security/launch work was finished or that a usable link was actually sent -- same topic, not the same action."
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionProposals, 1);
  assert.equal(result.completionRejectedVerifier, 1);
  assert.equal(result.completionVerified, 0);

  const merged = applyGlobalCorrections({ workItems: [remainingWork], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "open");
  assert.equal(isExecutionEligible(merged[0]), true, "a demo of the same product must never complete a distinct, unfinished commitment");
});

// ===========================================================================
// PART 3 -- positive completion tests (T1-T4)
// ===========================================================================

test("[T1] demo: accepted request is confirmed completed once the demo actually happens", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you demo it?"),
    transcriptLine(seg(2), "Speaker", "yeah, I'll share my screen"),
    transcriptLine(seg(3), "Speaker", "okay, here's the demo starting now")
  ].join("\n");
  const demo = lifecycleCandidate({ ref: "wi_1", title: "Demo the product", classification: "accepted_request", source_quote: "yeah, I'll share my screen", source_segment_ids: [seg(2)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [demo],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({
          ref: "wi_1",
          completion_segment_ids: [seg(3)],
          completion_reason: "The demo actually begins and is performed in seg 3."
        })
      ]
    }),
    createVerificationResponse: verifierResponse(true, "Seg 3 explicitly shows the demo being performed, the same action that was accepted.", [seg(3)])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionVerified, 1);
  const merged = applyGlobalCorrections({ workItems: [demo], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "completed");
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[T2] restart: accepted promise is confirmed completed once the restart is confirmed", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll restart Chrome"),
    transcriptLine(seg(2), "Speaker", "I restarted it, let's see if that fixed it")
  ].join("\n");
  const restart = lifecycleCandidate({ ref: "wi_1", title: "Restart Chrome", source_quote: "I'll restart Chrome", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [restart],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({
          ref: "wi_1",
          completion_segment_ids: [seg(2)],
          completion_reason: "Seg 2 explicitly confirms the restart happened."
        })
      ]
    }),
    createVerificationResponse: verifierResponse(true, "Seg 2 is an explicit statement that the restart was performed.", [seg(2)])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [restart], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[T3] screenshot: accepted promise is confirmed completed once taking it is confirmed", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll take a screenshot"),
    transcriptLine(seg(2), "Speaker", "okay, I took it and saved it")
  ].join("\n");
  const screenshot = lifecycleCandidate({ ref: "wi_1", title: "Take a screenshot", source_quote: "I'll take a screenshot", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [screenshot],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({
          ref: "wi_1",
          completion_segment_ids: [seg(2)],
          completion_reason: "Seg 2 confirms the screenshot was taken and saved."
        })
      ]
    }),
    createVerificationResponse: verifierResponse(true, "Seg 2 explicitly states the screenshot was taken and saved.", [seg(2)])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [screenshot], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[T4] send article: accepted promise is confirmed completed once sending it is confirmed", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll send you the article"),
    transcriptLine(seg(2), "Speaker", "I just sent it to you")
  ].join("\n");
  const sendArticle = lifecycleCandidate({ ref: "wi_1", title: "Send the article", source_quote: "I'll send you the article", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [sendArticle],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({
          ref: "wi_1",
          completion_segment_ids: [seg(2)],
          completion_reason: "Seg 2 confirms the article was sent."
        })
      ]
    }),
    createVerificationResponse: verifierResponse(true, "Seg 2 explicitly states the article was just sent.", [seg(2)])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [sendArticle], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false);
});

// ===========================================================================
// PART 4 -- negative completion tests (N1-N8)
// ===========================================================================

test("[N1] same topic only: a later demo/discussion of the same product does not complete a distinct promise", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll finish the security work tomorrow"),
    transcriptLine(seg(2), "Speaker", "let me show you the product now"),
    transcriptLine(seg(3), "Speaker", "here's how the dashboard looks")
  ].join("\n");
  const securityWork = lifecycleCandidate({ ref: "wi_1", title: "Finish the security work", source_quote: "I'll finish the security work tomorrow", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [securityWork],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(3)], completion_reason: "The product was demoed." })
      ]
    }),
    createVerificationResponse: verifierResponse(false, "The dashboard demo is the same product but not the same action as finishing the security work.")
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [securityWork], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[N2] progress only: 'made good progress' does not complete the promise", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll finish the migration"),
    transcriptLine(seg(2), "Speaker", "I made good progress on the migration")
  ].join("\n");
  const migration = lifecycleCandidate({ ref: "wi_1", title: "Finish the migration", source_quote: "I'll finish the migration", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [migration],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)], completion_reason: "Progress was made." })
      ]
    }),
    createVerificationResponse: verifierResponse(false, "'Made good progress' is a status update, not a statement that the migration was finished.")
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [migration], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[N3] intent repeated: restating the same unfulfilled intent does not complete it", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll send the report"),
    transcriptLine(seg(2), "Speaker", "yeah, I still need to send that")
  ].join("\n");
  const report = lifecycleCandidate({ ref: "wi_1", title: "Send the report", source_quote: "I'll send the report", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [report],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)], completion_reason: "The report was mentioned again." })
      ]
    }),
    createVerificationResponse: verifierResponse(false, "Seg 2 explicitly restates the report still needs to be sent -- the opposite of completion.")
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [report], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[N4] earlier completion of a different instance does not complete a later, distinct commitment (chronology gate, verifier never called)", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I sent the old report"),
    transcriptLine(seg(2), "Speaker", "I'll send the new report tomorrow")
  ].join("\n");
  const newReport = lifecycleCandidate({ ref: "wi_1", title: "Send the new report", source_quote: "I'll send the new report tomorrow", source_segment_ids: [seg(2)] });

  const { createResponse: createVerificationResponse, state: verifierCalls } = countingResponse({
    confirmed: true,
    reasoning: "should never be reached",
    supporting_segment_ids: []
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [newReport],
    // A buggy model cites the EARLIER "I sent the old report" segment as if it completed the LATER
    // "I'll send the new report" promise -- exactly the chronology violation the gate exists for.
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(1)], completion_reason: "A report was sent." })
      ]
    }),
    createVerificationResponse
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedChronology, 1);
  assert.equal(result.completionVerified, 0);
  assert.equal(verifierCalls.calls, 0, "earlier activity must never even reach the semantic verifier for a later commitment");
  const merged = applyGlobalCorrections({ workItems: [newReport], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true, "the new report promise must remain open -- the old report's completion is a different action");
});

test("[N5] ambiguous evidence: 'it looks better now' is not confirmation the specific fix was performed", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll fix the bug"),
    transcriptLine(seg(2), "Person A", "it looks better now")
  ].join("\n");
  const bugFix = lifecycleCandidate({ ref: "wi_1", title: "Fix the bug", source_quote: "I'll fix the bug", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [bugFix],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)], completion_reason: "Things look better." })
      ]
    }),
    createVerificationResponse: verifierResponse(false, "'It looks better now' is vague reassurance, not an explicit statement that the specific promised fix was performed.")
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [bugFix], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[N5 continued] a malformed verifier response (missing required field) is treated as non-confirmation, never as a pipeline failure", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll fix the bug"),
    transcriptLine(seg(2), "Person A", "it looks better now")
  ].join("\n");
  const bugFix = lifecycleCandidate({ ref: "wi_1", title: "Fix the bug", source_quote: "I'll fix the bug", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [bugFix],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)], completion_reason: "Things look better." })
      ]
    }),
    // Missing "reasoning" and "supporting_segment_ids" -- fails completionVerificationSchema.
    createVerificationResponse: fakeModelResponse({ confirmed: true })
  });
  assert.equal(result.ok, true, "a malformed verifier response must never fail the whole meeting");
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [bugFix], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true, "ambiguous/malformed verification must keep the item open, never convert uncertainty into completed");
});

test("[N6] missing completion_segment_ids: a completion decision with no evidence array populated is rejected before verification", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll fix the bug"),
    transcriptLine(seg(2), "Person A", "thanks")
  ].join("\n");
  const bugFix = lifecycleCandidate({ ref: "wi_1", title: "Fix the bug", source_quote: "I'll fix the bug", source_segment_ids: [seg(1)] });

  const { createResponse: createVerificationResponse, state: verifierCalls } = countingResponse({
    confirmed: true,
    reasoning: "should never be reached",
    supporting_segment_ids: []
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [bugFix],
    createResponse: fakeModelResponse({
      reviews: [completedCorrection({ ref: "wi_1" })] // completion_segment_ids defaults to []
    }),
    createVerificationResponse
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedMissingEvidence, 1);
  assert.equal(verifierCalls.calls, 0);
  const merged = applyGlobalCorrections({ workItems: [bugFix], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[N8] wrong-action evidence: evidence of a different action does not complete this commitment", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll send the article"),
    transcriptLine(seg(2), "Speaker", "okay, sharing my screen now")
  ].join("\n");
  const sendArticle = lifecycleCandidate({ ref: "wi_1", title: "Send the article", source_quote: "I'll send the article", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [sendArticle],
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_segment_ids: [seg(2)], completion_reason: "Screen was shared." })
      ]
    }),
    createVerificationResponse: verifierResponse(false, "Sharing a screen is a different action than sending the article; no evidence the article was actually sent.")
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [sendArticle], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

// ===========================================================================
// PART 5 -- pipeline-boundary tests: the critical assertion and observability counts
// ===========================================================================

test("[pipeline / critical assertion] an item cannot transition to completed_work/completed solely because the broad lifecycle model emitted those fields -- it must pass BOTH the evidence gate AND the targeted verifier", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll do thing one"),
    transcriptLine(seg(2), "Speaker", "I'll do thing two"),
    transcriptLine(seg(3), "Speaker", "unrelated later chatter about thing two's topic"),
    transcriptLine(seg(4), "Speaker", "I actually did thing two, all done")
  ].join("\n");
  const items = [
    lifecycleCandidate({ ref: "wi_1", title: "Thing one", source_quote: "I'll do thing one", source_segment_ids: [seg(1)] }),
    lifecycleCandidate({ ref: "wi_2", title: "Thing two", source_quote: "I'll do thing two", source_segment_ids: [seg(2)] })
  ];

  let verifierCallCount = 0;
  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: items,
    createResponse: fakeModelResponse({
      reviews: [
        // wi_1: broad model claims completed but supplies NO completion evidence -- structural reject,
        // the verifier must never even be consulted.
        completedCorrection({ ref: "wi_1", completion_reason: "seems done" }),
        // wi_2: broad model cites structurally-valid, genuinely later completion evidence -- this one
        // reaches and passes the verifier.
        completedCorrection({ ref: "wi_2", completion_segment_ids: [seg(4)], completion_reason: "explicitly confirmed done" })
      ]
    }),
    createVerificationResponse: async () => {
      verifierCallCount += 1;
      return { output_text: JSON.stringify({ confirmed: true, reasoning: "Seg 4 explicitly confirms thing two was done.", supporting_segment_ids: [seg(4)] }) };
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionProposals, 2);
  assert.equal(result.completionRejectedMissingEvidence, 1, "wi_1 rejected structurally -- no completion_segment_ids");
  assert.equal(result.completionVerified, 1, "wi_2 passed both the evidence gate and the verifier");
  assert.equal(verifierCallCount, 1, "only wi_2 passed the structural gate and reached the verifier -- wi_1 never did");

  const merged = applyGlobalCorrections({ workItems: items, corrections: result.reviews, additions: [], transcript });
  const byRef = new Map(merged.map((entry) => [entry.ref, entry]));
  assert.equal(isExecutionEligible(byRef.get("wi_1")!), true, "no evidence at all -- must stay open regardless of what the broad model emitted");
  assert.equal(isExecutionEligible(byRef.get("wi_2")!), false, "genuine, verified completion evidence correctly closes the item");
});

test("[pipeline / observability] completion safety counts sum to completionProposals across a mixed batch", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll do thing one"),
    transcriptLine(seg(2), "Speaker", "I'll do thing two"),
    transcriptLine(seg(3), "Speaker", "I did thing two, confirmed"),
    transcriptLine(seg(4), "Speaker", "I'll do thing three")
  ].join("\n");
  const items = [
    lifecycleCandidate({ ref: "wi_1", title: "Thing one", source_quote: "I'll do thing one", source_segment_ids: [seg(1)] }),
    lifecycleCandidate({ ref: "wi_2", title: "Thing two", source_quote: "I'll do thing two", source_segment_ids: [seg(2)] }),
    lifecycleCandidate({ ref: "wi_3", title: "Thing three", source_quote: "I'll do thing three", source_segment_ids: [seg(4)] })
  ];

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: items,
    createResponse: fakeModelResponse({
      reviews: [
        completedCorrection({ ref: "wi_1", completion_reason: "no evidence" }), // missing evidence
        completedCorrection({ ref: "wi_2", completion_segment_ids: [seg(3)], completion_reason: "confirmed" }), // verified
        correction({ ref: "wi_3" }) // not a completion decision at all
      ]
    }),
    createVerificationResponse: verifierResponse(true, "Seg 3 explicitly confirms thing two was done.", [seg(3)])
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.completionProposals, 2);
  assert.equal(result.completionRejectedMissingEvidence, 1);
  assert.equal(result.completionVerified, 1);
  assert.equal(result.completionRejectedChronology, 0);
  assert.equal(result.completionRejectedVerifier, 0);
  assert.equal(
    result.completionVerified + result.completionRejectedMissingEvidence + result.completionRejectedChronology + result.completionRejectedVerifier,
    result.completionProposals
  );
});
