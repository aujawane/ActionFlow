import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible, isFutureScopeItem } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  buildTranscriptPositionIndex,
  isScopeDeferralDecision,
  revertScopeDeferralField,
  runLifecycleReconciliationPass,
  validateScopeDeferralEvidence
} from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemCorrection, RawWorkItem, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Later-scope-supersession precision hardening (forensic-audit follow-up, generation-3 production
// trace). The audit found "Develop character generator..." correctly extracted as current_scope
// early in a meeting, then explicitly deferred later ("that's not a feature we're doing in phase
// one... put that in phase three") -- lifecycle reconciliation already has the full transcript and
// its own prompt already instructs it to apply such later statements, but nothing downstream ever
// checked a proposed deferral before trusting it, unlike completion decisions. These tests exercise
// the real programmatic evidence/chronology gate and the real targeted scope-deferral verifier via
// the actual runLifecycleReconciliationPass orchestration (mocked model calls, not just prompt-
// string assertions), proving the pipeline itself -- not prompt wording -- is what prevents a
// repeat of that regression.
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

function deferralCorrection(
  overrides: Partial<GlobalWorkItemCorrection> & { ref: string }
): GlobalWorkItemCorrection {
  return correction({
    scope_state: "future_scope",
    ...overrides
  });
}

function verifierResponse(confirmed: boolean, reasoning: string, supportingSegmentIds: string[] = []) {
  return fakeModelResponse({ confirmed, reasoning, supporting_segment_ids: supportingSegmentIds });
}

// ===========================================================================
// PART 1 -- pure-function unit coverage of the evidence/chronology gate
// ===========================================================================

test("[unit] isScopeDeferralDecision fires only on the exact current_scope -> future_scope transition", () => {
  const currentScopeItem = item({ ref: "wi_1", title: "t", source_quote: "q", scope_state: "current_scope" });
  const futureScopeItem = item({ ref: "wi_2", title: "t", source_quote: "q", scope_state: "future_scope" });
  assert.equal(isScopeDeferralDecision(currentScopeItem, correction({ ref: "wi_1", scope_state: "future_scope" })), true);
  assert.equal(isScopeDeferralDecision(currentScopeItem, correction({ ref: "wi_1", scope_state: "current_scope" })), false);
  assert.equal(isScopeDeferralDecision(futureScopeItem, correction({ ref: "wi_2", scope_state: "current_scope" })), false);
  assert.equal(isScopeDeferralDecision(currentScopeItem, correction({ ref: "wi_1", scope_state: "superseded" })), false);
});

test("[unit] validateScopeDeferralEvidence rejects an empty superseding_segment_ids array", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [seg(1)] });
  const positions = buildTranscriptPositionIndex(
    [transcriptLine(seg(1), "A", "x"), transcriptLine(seg(2), "A", "y")].join("\n")
  );
  const result = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [], reconciliation_reason: "deferred" }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "missing_evidence" });
});

test("[unit] validateScopeDeferralEvidence rejects a missing/blank reconciliation_reason even with segment IDs present", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [seg(1)] });
  const positions = buildTranscriptPositionIndex(
    [transcriptLine(seg(1), "A", "x"), transcriptLine(seg(2), "A", "y")].join("\n")
  );
  const result = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(2)], reconciliation_reason: "   " }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "missing_evidence" });
});

test("[unit] validateScopeDeferralEvidence rejects a deferral segment ID absent from this transcript", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", source_segment_ids: [seg(1)] });
  const positions = buildTranscriptPositionIndex(
    [transcriptLine(seg(1), "A", "x"), transcriptLine(seg(2), "A", "y")].join("\n")
  );
  const result = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(99)], reconciliation_reason: "deferred" }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_segment" });
});

test("[unit / D] validateScopeDeferralEvidence rejects deferral evidence at or before the origin position (strictly-after, not at-or-after)", () => {
  const transcript = [transcriptLine(seg(1), "A", "origin"), transcriptLine(seg(2), "A", "same or later")].join("\n");
  const positions = buildTranscriptPositionIndex(transcript);
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "origin", source_segment_ids: [seg(2)] });

  // Deferral segment BEFORE origin.
  const before = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(1)], reconciliation_reason: "deferred" }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(before, { ok: false, reason: "chronology" });

  // Deferral segment EQUAL to origin (same segment cited as its own deferral evidence).
  const same = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(2)], reconciliation_reason: "deferred" }),
    transcriptPositionIndex: positions
  });
  assert.deepEqual(same, { ok: false, reason: "chronology" });

  // Deferral segment strictly after origin -- passes.
  const after = validateScopeDeferralEvidence({
    originalItem,
    correction: deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(1)], reconciliation_reason: "deferred" }),
    transcriptPositionIndex: buildTranscriptPositionIndex(
      [transcriptLine(seg(2), "A", "origin"), transcriptLine(seg(1), "A", "later")].join("\n")
    )
  });
  assert.deepEqual(after, { ok: true });
});

test("[unit] revertScopeDeferralField reverts exactly scope_state/superseding_segment_ids/reconciliation_reason, preserves everything else", () => {
  const originalItem = item({ ref: "wi_1", title: "t", source_quote: "q", scope_state: "current_scope" });
  const proposedDeferral = deferralCorrection({
    ref: "wi_1",
    owner: "New Owner",
    owners: ["New Owner"],
    status: "in_progress",
    superseding_segment_ids: [seg(2)],
    reconciliation_reason: "some claim"
  });
  const reverted = revertScopeDeferralField(proposedDeferral, originalItem, "rejected for test");
  assert.equal(reverted.scope_state, "current_scope");
  assert.deepEqual(reverted.superseding_segment_ids, []);
  assert.equal(reverted.reconciliation_reason, "rejected for test");
  // Unrelated fields the model proposed are NOT reverted -- this gate is scope-deferral-only, per
  // the task's explicit "Do NOT automatically change status/classification" requirement.
  assert.equal(reverted.owner, "New Owner");
  assert.deepEqual(reverted.owners, ["New Owner"]);
  assert.equal(reverted.status, "in_progress");
});

// ===========================================================================
// PART 2 -- A/B/C/D/E via the real pipeline (runLifecycleReconciliationPass)
// ===========================================================================

test("[A] earlier current-scope item + later explicit deferral -> scope_state becomes future_scope", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "we can add a character generator"),
    transcriptLine(seg(2), "Cameron", "that's not a feature we're doing in phase one, put that in phase three")
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator",
    source_quote: "we can add a character generator",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_1",
          superseding_segment_ids: [seg(2)],
          reconciliation_reason: "Cameron explicitly deferred the character generator to phase three."
        })
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(
      true,
      "Seg 2 explicitly states the character generator is not part of phase one and belongs in phase three.",
      [seg(2)]
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralProposals, 1);
  assert.equal(result.scopeDeferralVerified, 1);

  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "future_scope");
  assert.equal(isFutureScopeItem(merged[0]), true);
  assert.equal(isExecutionEligible(merged[0]), false, "a correctly-deferred item must never remain execution-eligible");
});

test("[B] earlier current-scope item + no later scope change -> remains current_scope", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "I'll build the script generator"),
    transcriptLine(seg(2), "Cameron", "sounds great, let's keep going")
  ].join("\n");
  const scriptGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Build the script generator",
    source_quote: "I'll build the script generator",
    source_segment_ids: [seg(1)]
  });

  const { createResponse: createScopeDeferralVerificationResponse, state: verifierCalls } = countingResponse({
    confirmed: true,
    reasoning: "should never be reached",
    supporting_segment_ids: []
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [scriptGenerator],
    // The broad model correctly echoes current_scope back unchanged -- no deferral proposed at all.
    createResponse: fakeModelResponse({
      reviews: [correction({ ref: "wi_1", scope_state: "current_scope", reconciliation_reason: null })]
    }),
    createScopeDeferralVerificationResponse
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralProposals, 0);
  assert.equal(verifierCalls.calls, 0, "the targeted verifier must never be called when no deferral was even proposed");

  const merged = applyGlobalCorrections({ workItems: [scriptGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "current_scope");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C] ambiguous later comment -> remains current_scope (semantic gate rejects, structural gate passed)", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "I'll build the character generator"),
    transcriptLine(seg(2), "Cameron", "yeah, phase one has a lot going on")
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator",
    source_quote: "I'll build the character generator",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_1",
          superseding_segment_ids: [seg(2)],
          reconciliation_reason: "Phase one has a lot going on, so this is probably deferred."
        })
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(
      false,
      "Seg 2 is vague general discussion of phase one's scope -- it never actually names or excludes the character generator specifically."
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralProposals, 1);
  assert.equal(result.scopeDeferralRejectedVerifier, 1);
  assert.equal(result.scopeDeferralVerified, 0);

  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "current_scope", "vague adjacent discussion must never descope a specific feature");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[D] alleged deferral citation occurs before the original work item -> correction rejected, verifier never called", async () => {
  const transcript = [
    transcriptLine(seg(1), "Cameron", "that's not a feature we're doing in phase one"),
    transcriptLine(seg(2), "Aditya", "we can add a character generator")
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator",
    source_quote: "we can add a character generator",
    source_segment_ids: [seg(2)]
  });

  const { createResponse: createScopeDeferralVerificationResponse, state: verifierCalls } = countingResponse({
    confirmed: true,
    reasoning: "should never be reached",
    supporting_segment_ids: []
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    // A buggy model cites the EARLIER "not phase one" segment as if it deferred the LATER
    // "character generator" promise -- exactly the chronology violation the gate exists for.
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_1",
          superseding_segment_ids: [seg(1)],
          reconciliation_reason: "Deferred per the earlier phase one discussion."
        })
      ]
    }),
    createScopeDeferralVerificationResponse
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralRejectedChronology, 1);
  assert.equal(result.scopeDeferralVerified, 0);
  assert.equal(verifierCalls.calls, 0, "evidence that precedes the item's own origin must never even reach the semantic verifier");

  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "current_scope", "the item must remain exactly as it was -- chronology-inverted evidence proves nothing");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[E] explicit 'not phase one / phase three' example -> future_scope (the exact real production failure)", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "we can add a character generator"),
    transcriptLine(
      seg(2),
      "Cameron",
      "that's not a feature we're doing in phase one, you can put that in phase three, kevin already made six characters"
    )
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator to create named characters with characteristics and background",
    source_quote: "we can add a character generator",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_1",
          superseding_segment_ids: [seg(2)],
          reconciliation_reason: "Cameron explicitly says the character generator is not a phase-one feature and belongs in phase three."
        })
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(
      true,
      "Seg 2 explicitly states the character generator is not a phase-one feature and should be in phase three.",
      [seg(2)]
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralVerified, 1);

  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "future_scope");
  assert.equal(isExecutionEligible(merged[0]), false);
});

// ===========================================================================
// PART 3 -- pipeline-boundary tests: status/classification untouched, observability counts
// ===========================================================================

test("[pipeline / critical assertion] a correctly-verified deferral changes ONLY scope_state -- status/classification/acceptance_state proposed alongside it pass through as the model set them, never forced back by this gate", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "we can add a character generator"),
    transcriptLine(seg(2), "Cameron", "that's not a feature we're doing in phase one, put that in phase three")
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator",
    source_quote: "we can add a character generator",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_1",
          // The broad model also independently repairs classification in the same review --
          // this fix must never force it back just because a scope deferral is also present.
          classification: "idea",
          superseding_segment_ids: [seg(2)],
          reconciliation_reason: "Deferred to phase three."
        })
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(true, "Explicitly deferred to phase three.", [seg(2)])
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "future_scope");
  assert.equal(merged[0].classification, "idea", "an unrelated classification repair proposed alongside a verified deferral must pass through untouched");
});

test("[pipeline / observability] scope-deferral safety counts sum to scopeDeferralProposals across a mixed batch", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "I'll build thing one"),
    transcriptLine(seg(2), "Aditya", "I'll build thing two"),
    transcriptLine(seg(3), "Cameron", "thing two is deferred to a later phase"),
    transcriptLine(seg(4), "Aditya", "I'll build thing three")
  ].join("\n");
  const items = [
    lifecycleCandidate({ ref: "wi_1", title: "Thing one", source_quote: "I'll build thing one", source_segment_ids: [seg(1)] }),
    lifecycleCandidate({ ref: "wi_2", title: "Thing two", source_quote: "I'll build thing two", source_segment_ids: [seg(2)] }),
    lifecycleCandidate({ ref: "wi_3", title: "Thing three", source_quote: "I'll build thing three", source_segment_ids: [seg(4)] })
  ];

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: items,
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({ ref: "wi_1", superseding_segment_ids: [], reconciliation_reason: null }), // missing evidence
        deferralCorrection({ ref: "wi_2", superseding_segment_ids: [seg(3)], reconciliation_reason: "deferred" }), // verified
        correction({ ref: "wi_3" }) // not a deferral decision at all
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(true, "Seg 3 explicitly defers thing two.", [seg(3)])
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralProposals, 2);
  assert.equal(result.scopeDeferralRejectedMissingEvidence, 1);
  assert.equal(result.scopeDeferralVerified, 1);
  assert.equal(result.scopeDeferralRejectedChronology, 0);
  assert.equal(result.scopeDeferralRejectedVerifier, 0);
  assert.equal(
    result.scopeDeferralVerified +
      result.scopeDeferralRejectedMissingEvidence +
      result.scopeDeferralRejectedChronology +
      result.scopeDeferralRejectedVerifier,
    result.scopeDeferralProposals
  );
});

test("[pipeline] a malformed scope-deferral verifier response is treated as non-confirmation, never as a pipeline failure", async () => {
  const transcript = [
    transcriptLine(seg(1), "Aditya", "we can add a character generator"),
    transcriptLine(seg(2), "Cameron", "that's not a feature we're doing in phase one")
  ].join("\n");
  const characterGenerator = lifecycleCandidate({
    ref: "wi_1",
    title: "Develop character generator",
    source_quote: "we can add a character generator",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [characterGenerator],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({ ref: "wi_1", superseding_segment_ids: [seg(2)], reconciliation_reason: "Deferred." })
      ]
    }),
    // Missing "reasoning" and "supporting_segment_ids" -- fails scopeDeferralVerificationSchema.
    createScopeDeferralVerificationResponse: fakeModelResponse({ confirmed: true })
  });

  assert.equal(result.ok, true, "a malformed verifier response must never fail the whole meeting");
  if (!result.ok) return;
  assert.equal(result.scopeDeferralRejectedVerifier, 1);
  const merged = applyGlobalCorrections({ workItems: [characterGenerator], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].scope_state, "current_scope", "ambiguous/malformed verification must keep the item at its current scope, never convert uncertainty into a deferral");
});

// ===========================================================================
// PART 4 -- Generation-5 regression: a SECOND, independently-added representation of the same
// real feature must also be deferred, not just the one the original fix was found against.
//
// The generation-5 production audit found a different work item ("Add feature for creating new
// characters when Kevin decides to add one") that was introduced not by initial per-topic
// extraction but by completeness recovery (Pass A/B) from a later utterance in the SAME meeting --
// immediately followed, in the very next exchange, by Cameron's "that's not a feature we're doing
// in phase one... you can put that in phase three." Lifecycle reconciliation reviewed this item and
// echoed it back unchanged (current_scope), in the very same pass that correctly deferred a
// different, earlier representation of the same idea. This test proves the EXISTING scope-deferral
// gate (no new mechanism -- see the rest of this file) correctly handles this second shape too:
// an item whose own origin is a completeness-recovery addition, not initial extraction.
// ===========================================================================

test("[Gen5 regression] a work item introduced via completeness recovery, immediately followed by an explicit 'not phase one / phase three' deferral, is correctly moved to future_scope and excluded from the current Phase-1 group", async () => {
  const transcript = [
    // The completeness-recovery-added item's own origin segment (mirrors wi_g1's real source quote).
    transcriptLine(seg(1), "Aditya", "so i added like one more feature where he can make one more character"),
    // Immediately following, in the same meeting, the explicit deferral (mirrors the real segments).
    transcriptLine(seg(2), "Cameron", "that's not a feature we're doing in phase one"),
    transcriptLine(seg(3), "Cameron", "so let's just you can put that in phase three")
  ].join("\n");

  // This item's own shape mirrors wi_g1 exactly: added by completeness recovery (not initial
  // extraction), classification=assignment, scope_state=current_scope -- the SAME mis-scoped
  // starting state found in production, on a different ref/title than the original fix's test.
  const newCharacterFeature = lifecycleCandidate({
    ref: "wi_g1",
    title: "Add feature for creating new characters when Kevin decides to add one",
    classification: "assignment",
    source_quote: "so i added like one more feature where he can make one more character",
    source_segment_ids: [seg(1)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [newCharacterFeature],
    createResponse: fakeModelResponse({
      reviews: [
        deferralCorrection({
          ref: "wi_g1",
          classification: "assignment",
          superseding_segment_ids: [seg(2), seg(3)],
          reconciliation_reason: "Cameron explicitly defers this new-character-creation feature to phase three, immediately after Aditya describes it."
        })
      ]
    }),
    createScopeDeferralVerificationResponse: verifierResponse(
      true,
      "Segments 2-3 explicitly state this feature is not part of phase one and belongs in phase three.",
      [seg(2), seg(3)]
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scopeDeferralVerified, 1);

  const merged = applyGlobalCorrections({ workItems: [newCharacterFeature], corrections: result.reviews, additions: [], transcript });
  const resolved = merged[0];
  assert.equal(resolved.scope_state, "future_scope");
  assert.equal(isFutureScopeItem(resolved), true);
  assert.equal(isExecutionEligible(resolved), false, "must not remain eligible for the current Phase-1 group");
});
