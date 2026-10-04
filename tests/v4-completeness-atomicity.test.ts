import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections, resolveCompletenessAdjudicationTrace } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  dedupeCompletenessAdditions,
  isLifecycleReviewCandidate,
  runAtomicActionHarvestPass,
  runCompletenessAdjudicationPass,
  runCompletenessRecoveryPass,
  semanticDedupeCompletenessAdditions,
  validateCompletenessAdjudicationCoverage,
  type HarvestedCandidate
} from "../lib/execution-intelligence/work-item-stages";
import type {
  AtomicActionHarvestCandidate,
  CompletenessAdjudicationDecision,
  GlobalWorkItemAddition,
  RawWorkItem,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Completeness-recovery outcome atomicity + generation-11 semantic-duplicate follow-up.
//
// Generation 11 proved the single-pass completeness-recovery design (deterministic exact-segment
// dedup only) could preserve distinct same-segment outcomes, but the model still under-enumerated
// compound/conversational turns, and one semantic duplicate leaked ACROSS segments (wi_g7/wi_g8 --
// same "connect agent to phone" commitment, two different turns, exact-segment-set dedup structurally
// cannot see it). This drove the two-step refactor exercised here: PASS A (atomic action harvest,
// runAtomicActionHarvestPass) is a ledger-blind, deliberately high-recall enumeration; PASS B
// (missing-work adjudication, runCompletenessAdjudicationPass) receives PASS A's own harvested
// candidates explicitly (never re-discovers them) and decides, per candidate, whether it is genuine,
// active, and already represented; LAYER 1 (dedupeCompletenessAdditions, unchanged) then LAYER 2
// (semanticDedupeCompletenessAdditions, reusing work-item-merge.ts's isNearDuplicateWorkItem) catch
// same-real-world-outcome duplicates the exact-segment-set rule alone cannot.
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

function addition(
  overrides: Partial<GlobalWorkItemAddition> & { title: string; source_quote: string; source_segment_ids: string[] }
): GlobalWorkItemAddition {
  return rawItem(overrides);
}

// Small transcripts (<= 50 segments) always land in a single window, and
// splitExecutionSourceIntoChunks always assigns that window index 0, so a harvested candidate's
// application-assigned canonicalRef is deterministically "hc_w0_<n>" in harvest-array order (after
// grounding). These fixtures rely on that so a mocked Pass B response can echo the right
// candidate_id back without inspecting Pass A's actual call arguments.
function harvestCandidate(
  overrides: Partial<AtomicActionHarvestCandidate> & {
    outcome: string;
    source_quote: string;
    source_segment_ids: string[];
  }
): AtomicActionHarvestCandidate {
  return {
    candidate_id: "c1",
    owner: "Speaker",
    owners: ["Speaker"],
    harvest_reason: "Fixture.",
    ...overrides
  };
}

function adjudicationDecision(
  overrides: Partial<CompletenessAdjudicationDecision> & {
    candidate_id: string;
    disposition: CompletenessAdjudicationDecision["disposition"];
  }
): CompletenessAdjudicationDecision {
  return {
    reason: "Fixture.",
    addition: null,
    ...overrides
  };
}

function harvestResponse(candidates: AtomicActionHarvestCandidate[]) {
  return fakeModelResponse({ candidates });
}

function adjudicationResponse(decisions: CompletenessAdjudicationDecision[]) {
  return fakeModelResponse({ decisions });
}

function harvested(overrides: HarvestedCandidate | (Partial<HarvestedCandidate> & { canonicalRef: string; windowIndex: number; outcome: string; source_quote: string; source_segment_ids: string[] })): HarvestedCandidate {
  return {
    candidate_id: overrides.canonicalRef,
    owner: "Speaker",
    owners: ["Speaker"],
    harvest_reason: "Fixture.",
    ...overrides
  };
}

// ===========================================================================
// PART 1 -- dedupeCompletenessAdditions unit coverage (LAYER 1: cheap, deterministic, exact-match)
// ===========================================================================

test("[layer 1] same segment set + same statement (normalized-equal quotes) is a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "I'll send Sam the article", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "dup", source_quote: "I'll send Sam the article", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 0);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].matchedTitle, "Send the article");
});

test("[layer 1] same segment set but a DIFFERENT statement is NOT a duplicate -- the compound-turn fix", () => {
  const existing = item({ ref: "wi_1", title: "Finish the work", source_quote: "i'll finish up what i was working on", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "Confirm the flow works", source_quote: "and then confirm that the flow works", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 1, "a distinct outcome sharing a segment with an existing item must survive");
  assert.equal(removed.length, 0);
});

test("[layer 1] quote containment (one quote is a substring of the other) on the same segment set is still treated as a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article we discussed tonight", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "dup (shorter excerpt)", source_quote: "send sam the article", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 0);
  assert.equal(removed.length, 1);
});

test("[layer 1] a PARTIAL segment overlap (not a full set match) is NOT treated as a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "different outcome spanning two segments", source_quote: "i'll send sam the article and also call him", source_segment_ids: [seg(1), seg(2)] })]
  );
  assert.equal(kept.length, 1, "an addition whose segment set is not an exact match to any existing item's segment set must not be silently dropped");
});

test("[layer 1] different segment sets are never deduped by this primitive, even with identical quotes -- that is LAYER 2's job", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "paraphrase elsewhere", source_quote: "i'll send sam the article", source_segment_ids: [seg(2)] })]
  );
  assert.equal(kept.length, 1);
});

test("[layer 1] cross-window duplicate proposals (same segment, same quote) collapse to one, first occurrence wins", () => {
  const candidateA = addition({ title: "A", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const candidateB = addition({ title: "B", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions([], [candidateA, candidateB]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "A");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].matchedTitle, "A");
});

// ===========================================================================
// PART 2 -- semanticDedupeCompletenessAdditions unit coverage (LAYER 2: reused isNearDuplicateWorkItem)
//
// The generation-11 wi_g7/wi_g8 leak: the SAME real-world commitment, restated across two DIFFERENT
// transcript segments, survives LAYER 1 untouched because its segment sets never match. LAYER 2 is
// the safety net -- it reuses work-item-merge.ts's isNearDuplicateWorkItem verbatim (same
// classification/status equality plus title-similarity-or-shared-evidence judgment already proven for
// topic-scoped extraction's own merge), so it is exercised here as a completeness-specific dedup
// layer, not a new heuristic.
// ===========================================================================

test("[layer 2] the same real-world outcome cited from two DIFFERENT segments collapses to one -- the wi_g7/wi_g8 fix", () => {
  const existing = item({
    ref: "wi_1",
    title: "Connect the agent to the phone",
    source_quote: "I'll connect the agent to my phone",
    source_segment_ids: [seg(1)]
  });
  const { kept, removed } = semanticDedupeCompletenessAdditions(
    [existing],
    [
      addition({
        title: "Connect the agent to the phone",
        source_quote: "I'll hook the agent up to the phone",
        source_segment_ids: [seg(9)]
      })
    ]
  );
  assert.equal(kept.length, 0, "a same-outcome restatement citing a different segment must still be caught");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].matchedTitle, "Connect the agent to the phone");
});

test("[layer 2] LAYER 1 alone does not catch the cross-segment duplicate LAYER 2 exists for", () => {
  const existing = item({
    ref: "wi_1",
    title: "Connect the agent to the phone",
    source_quote: "I'll connect the agent to my phone",
    source_segment_ids: [seg(1)]
  });
  const { kept } = dedupeCompletenessAdditions(
    [existing],
    [
      addition({
        title: "Connect the agent to the phone",
        source_quote: "I'll hook the agent up to the phone",
        source_segment_ids: [seg(9)]
      })
    ]
  );
  assert.equal(kept.length, 1, "LAYER 1's exact-segment-set rule structurally cannot see this duplicate -- that gap is exactly why LAYER 2 exists");
});

test("[layer 2] distinct outcomes sharing owner, topic, and segment do NOT collapse merely because they are related", () => {
  const existing = item({
    ref: "wi_1",
    title: "Finish the implementation",
    source_quote: "I'll finish the implementation",
    source_segment_ids: [seg(1)]
  });
  const { kept, removed } = semanticDedupeCompletenessAdditions(
    [existing],
    [
      addition({
        title: "Verify the implementation works",
        source_quote: "and then verify the implementation works",
        source_segment_ids: [seg(1)]
      })
    ]
  );
  assert.equal(kept.length, 1, "two independently checkable outcomes must never be collapsed just because they share owner/topic/segment");
  assert.equal(removed.length, 0);
});

test("[layer 2] a classification mismatch prevents merging even when titles are identical -- open work never merges with completed work", () => {
  const existing = item({
    ref: "wi_1",
    title: "Send the article",
    classification: "completed_work",
    status: "completed",
    source_quote: "I already sent the article",
    source_segment_ids: [seg(1)]
  });
  const { kept } = semanticDedupeCompletenessAdditions(
    [existing],
    [
      addition({
        title: "Send the article",
        classification: "promise",
        status: "open",
        source_quote: "I'll send the article",
        source_segment_ids: [seg(9)]
      })
    ]
  );
  assert.equal(kept.length, 1, "isNearDuplicateWorkItem's own classification/status guard is preserved by reuse, not weakened");
});

// ===========================================================================
// PART 3 -- runAtomicActionHarvestPass (PASS A) unit coverage
// ===========================================================================

test("[pass A] harvested candidates report per-window counts and are assigned canonicalRefs in harvest order", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll fix the build, verify deployment, and send the link.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Fix the build", source_quote: "I'll fix the build", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Verify deployment", source_quote: "verify deployment", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Send the link", source_quote: "send the link", source_segment_ids: [seg(1)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.map((c) => c.canonicalRef), ["hc_w0_1", "hc_w0_2", "hc_w0_3"]);
  assert.equal(result.harvestedByWindow.length, 1);
  assert.equal(result.harvestedByWindow[0].harvested, 3);
  assert.equal(result.groundingRejected, 0);
});

test("[pass A] harvest grounding rejects a candidate with an empty quote and a candidate citing a segment absent from the transcript, independent of adjudication", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send the article.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Real candidate", source_quote: "I'll send the article.", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Empty quote", source_quote: "   ", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Fabricated segment", source_quote: "something never said", source_segment_ids: [seg(99)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 1, "only the grounded candidate survives");
  assert.equal(result.candidates[0].outcome, "Real candidate");
  assert.equal(result.groundingRejected, 2);
  assert.equal(result.harvestedByWindow[0].harvested, 3, "the raw per-window count is reported before grounding filters anything out");
});

// ===========================================================================
// PART 4 -- runCompletenessAdjudicationPass (PASS B) unit coverage: exhaustive coverage,
// targeted retry/salvage, and fail-closed malformed-decision handling.
// ===========================================================================

function candidate(id: string, outcome: string, quote: string, segmentIds: string[]): HarvestedCandidate {
  return harvested({ canonicalRef: id, windowIndex: 0, outcome, source_quote: quote, source_segment_ids: segmentIds });
}

test("[pass B, C1+C2] a candidate omitted from the first adjudication response is recovered via targeted retry -- all N are eventually accounted for", async () => {
  const candidates = [
    candidate("hc_w0_1", "First thing", "I'll do the first thing", [seg(1)]),
    candidate("hc_w0_2", "Second thing", "I'll do the second thing", [seg(2)]),
    candidate("hc_w0_3", "Third thing", "I'll do the third thing", [seg(3)])
  ];

  let callCount = 0;
  const createResponse = async () => {
    callCount += 1;
    if (callCount === 1) {
      // Omits hc_w0_3 entirely -- simulates the same omission failure mode already hardened for
      // lifecycle reconciliation's own exhaustive-coverage retry.
      return {
        output_text: JSON.stringify({
          decisions: [
            adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "already_represented" }),
            adjudicationDecision({ candidate_id: "hc_w0_2", disposition: "already_represented" })
          ]
        })
      };
    }
    return {
      output_text: JSON.stringify({
        decisions: [adjudicationDecision({ candidate_id: "hc_w0_3", disposition: "already_represented" })]
      })
    };
  };

  const result = await runCompletenessAdjudicationPass({
    source: source({ transcript: "irrelevant for this mock" }),
    existingWorkItems: [],
    candidates,
    createResponse
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(callCount, 2, "a retry call must have been made for the omitted candidate");
  assert.equal(result.candidatesExpected, 3);
  assert.equal(result.decisionsReceived, 3, "all three candidates are accounted for once the retry recovers the omitted one");
  assert.deepEqual(result.missingCandidateRefsAfterRetry, []);
});

test("[pass B] a candidate still missing after the retry is left unadjudicated, not silently added or counted under any disposition", async () => {
  const candidates = [
    candidate("hc_w0_1", "First thing", "I'll do the first thing", [seg(1)]),
    candidate("hc_w0_2", "Second thing", "I'll do the second thing", [seg(2)])
  ];
  // The model omits hc_w0_2 on both the initial call AND the retry.
  const createResponse = fakeModelResponse({
    decisions: [adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "add", addition: addition({ title: "First thing", source_quote: "I'll do the first thing", source_segment_ids: [seg(1)] }) })]
  });

  const result = await runCompletenessAdjudicationPass({
    source: source({ transcript: "irrelevant for this mock" }),
    existingWorkItems: [],
    candidates,
    createResponse
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decisionsReceived, 1);
  assert.deepEqual(result.missingCandidateRefsAfterRetry, ["hc_w0_2"]);
  assert.equal(result.additions.length, 1, "only the adjudicated candidate produces an addition -- the unadjudicated one is never silently added");
});

test("[pass B, C3] a malformed 'add' decision (null addition payload) contributes zero additions and is never silently reclassified as 'already_represented'", async () => {
  const candidates = [candidate("hc_w0_1", "Send the article", "I'll send the article", [seg(1)])];
  const createResponse = fakeModelResponse({
    decisions: [
      // disposition says "add" but the addition payload is malformed/missing -- the safest fallback
      // is to contribute nothing, exactly as if this candidate had never been adjudicated at all.
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "add", addition: null })
    ]
  });

  const result = await runCompletenessAdjudicationPass({
    source: source({ transcript: "irrelevant for this mock" }),
    existingWorkItems: [],
    candidates,
    createResponse
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0, "a malformed add produces no addition");
  assert.equal(result.completenessDecisionAdd, 1, "the disposition itself is still tallied honestly as 'add'");
  assert.equal(result.completenessDecisionAlreadyRepresented, 0, "malformed 'add' must never be silently folded into a different disposition's count");
});

test("[pass B] all six dispositions are tallied correctly in one batch, and only 'add' with a valid payload produces an addition", async () => {
  const candidates = [
    candidate("hc_w0_1", "Add me", "I'll add this", [seg(1)]),
    candidate("hc_w0_2", "Already there", "I'll do the already-covered thing", [seg(2)]),
    candidate("hc_w0_3", "Speculative", "maybe someday I'll do this", [seg(3)]),
    candidate("hc_w0_4", "Retrospective", "I already did this", [seg(4)]),
    candidate("hc_w0_5", "Chatter", "that's an interesting idea", [seg(5)]),
    candidate("hc_w0_6", "Ungroundable", "something vague", [seg(6)])
  ];
  const result = await runCompletenessAdjudicationPass({
    source: source({ transcript: "irrelevant for this mock" }),
    existingWorkItems: [],
    candidates,
    createResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Add me", source_quote: "I'll add this", source_segment_ids: [seg(1)] })
      }),
      adjudicationDecision({ candidate_id: "hc_w0_2", disposition: "already_represented" }),
      adjudicationDecision({ candidate_id: "hc_w0_3", disposition: "speculative_or_inactive" }),
      adjudicationDecision({ candidate_id: "hc_w0_4", disposition: "retrospective_or_completed" }),
      adjudicationDecision({ candidate_id: "hc_w0_5", disposition: "non_execution" }),
      adjudicationDecision({ candidate_id: "hc_w0_6", disposition: "insufficient_grounding" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  assert.equal(result.completenessDecisionAdd, 1);
  assert.equal(result.completenessDecisionAlreadyRepresented, 1);
  assert.equal(result.completenessDecisionSpeculativeOrInactive, 1);
  assert.equal(result.completenessDecisionRetrospectiveOrCompleted, 1);
  assert.equal(result.completenessDecisionNonExecution, 1);
  assert.equal(result.completenessDecisionInsufficientGrounding, 1);
  assert.equal(result.decisionsReceived, 6);
  assert.deepEqual(result.missingCandidateRefsAfterRetry, []);
});

test("[pass B] with zero harvested candidates, adjudication short-circuits without calling the model", async () => {
  let called = false;
  const result = await runCompletenessAdjudicationPass({
    source: source({ transcript: "irrelevant" }),
    existingWorkItems: [],
    candidates: [],
    createResponse: async () => {
      called = true;
      return { output_text: JSON.stringify({ decisions: [] }) };
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidatesExpected, 0);
  assert.equal(result.additions.length, 0);
  assert.equal(called, false, "there is nothing to adjudicate, so the model is never called");
});

test("[coverage] validateCompletenessAdjudicationCoverage rejects hallucinated candidate_ids and collapses duplicate decisions for the same candidate", () => {
  const { covered, missingCandidateRefs } = validateCompletenessAdjudicationCoverage(
    ["hc_w0_1", "hc_w0_2"],
    [
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "already_represented" }),
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "add", reason: "duplicate response for the same candidate" }),
      adjudicationDecision({ candidate_id: "hc_w0_99", disposition: "add" }) // not requested -- must be dropped
    ]
  );
  assert.equal(covered.length, 1);
  assert.equal(covered[0].candidate_id, "hc_w0_1");
  assert.equal(covered[0].disposition, "already_represented", "first decision per candidate_id wins");
  assert.deepEqual(missingCandidateRefs, ["hc_w0_2"]);
});

// ===========================================================================
// PART 5 -- pipeline-boundary tests via the real runCompletenessRecoveryPass (harvest + adjudication)
// ===========================================================================

test("[H1, GT3-B pattern] a compound turn's second, distinct outcome is recovered even though the first outcome already has a ledger item citing the same segment", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll finish the Chatter work and then confirm the drops flow works.");
  const existingChatterWork = item({
    ref: "wi_1",
    title: "Finish the Chatter work",
    source_quote: "I'll finish the Chatter work",
    source_segment_ids: [seg(1)]
  });

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existingChatterWork],
    // Pass A is ledger-blind, so it harvests BOTH outcomes regardless of what already exists.
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Finish the Chatter work", source_quote: "I'll finish the Chatter work", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Confirm the drops flow works", source_quote: "confirm the drops flow works", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "already_represented" }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Confirm the drops flow works", source_quote: "confirm the drops flow works", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidatesHarvested, 2);
  assert.equal(result.adjudicationCounts.completenessDecisionAlreadyRepresented, 1);
  assert.equal(result.adjudicationCounts.completenessDecisionAdd, 1);
  assert.equal(result.additions.length, 1, "the distinct second outcome must not be suppressed merely because the first outcome from the same turn is already in the ledger");

  const merged = applyGlobalCorrections({ workItems: [existingChatterWork], corrections: [], additions: result.additions, transcript });
  assert.equal(merged.length, 2);
  const recovered = merged.find((entry) => entry.title === "Confirm the drops flow works")!;
  assert.equal(isExecutionEligible(recovered), true);
  assert.equal(isLifecycleReviewCandidate(recovered), true, "the recovered outcome must also be visible to lifecycle reconciliation");
});

test("[H2, GT5 pattern] a small, low-salience promise embedded in a long explanatory turn is harvested and added independently of the surrounding discussion", async () => {
  const longTurn =
    "so the thing about AI-engineer skills right now is that everyone's coming at it from a different background, some from pure software, some from research, and honestly I think the fastest way to close that gap is just reading -- I'll send you a link of an article that explains it, and then we can talk through it together next time.";
  const transcript = transcriptLine(seg(1), "Speaker", longTurn);

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Send a link of an article", source_quote: "I'll send you a link of an article that explains it", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Send a link of an article", source_quote: "I'll send you a link of an article that explains it", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1, "a short promise must not disappear because most of the surrounding turn is explanatory discussion");
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[H3, GT6 pattern] two distinct commitments in the same long turn are both recovered -- neither suppresses the other", async () => {
  const longTurn =
    "one thing I've been thinking about for the incoming cohort is how we actually ramp them up -- I'll chaperone the group through the first few weeks, and separately I will walk them through explaining product-founder fit since that's usually the hardest concept to land.";
  const transcript = transcriptLine(seg(1), "Speaker", longTurn);

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Chaperone the group", source_quote: "I'll chaperone the group through the first few weeks", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Walk them through product-founder fit", source_quote: "I will walk them through explaining product-founder fit", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Chaperone the group", source_quote: "I'll chaperone the group through the first few weeks", source_segment_ids: [seg(1)] })
      }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Walk them through product-founder fit", source_quote: "I will walk them through explaining product-founder fit", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 2, "neither commitment may swallow the other");
});

test("[H4] three independent outcomes from one compound turn can all be represented", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll fix the build, verify deployment, and send the link.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Fix the build", source_quote: "I'll fix the build", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Verify deployment", source_quote: "verify deployment", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Send the link", source_quote: "send the link", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "add", addition: addition({ title: "Fix the build", source_quote: "I'll fix the build", source_segment_ids: [seg(1)] }) }),
      adjudicationDecision({ candidate_id: "hc_w0_2", disposition: "add", addition: addition({ title: "Verify deployment", source_quote: "verify deployment", source_segment_ids: [seg(1)] }) }),
      adjudicationDecision({ candidate_id: "hc_w0_3", disposition: "add", addition: addition({ title: "Send the link", source_quote: "send the link", source_segment_ids: [seg(1)] }) })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 3, "three semantically distinct outcomes sharing one segment must all survive");
  assert.equal(result.duplicatesRemoved.length, 0);
});

test("[H5] one semantic outcome restated with elaboration does not necessarily produce two independent additions", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll fix the deployment and make sure that deployment issue is fixed.");
  // Pass A over-harvests two candidates from the elaboration (its own high-recall mandate), citing
  // the SAME segment with one quote containing the other -- exactly what LAYER 1 dedup exists to
  // collapse once both are adjudicated as "add".
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Fix the deployment", source_quote: "I'll fix the deployment", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Fix the deployment issue", source_quote: "I'll fix the deployment and make sure that deployment issue is fixed", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "add", addition: addition({ title: "Fix the deployment", source_quote: "I'll fix the deployment", source_segment_ids: [seg(1)] }) }),
      adjudicationDecision({ candidate_id: "hc_w0_2", disposition: "add", addition: addition({ title: "Fix the deployment issue", source_quote: "I'll fix the deployment and make sure that deployment issue is fixed", source_segment_ids: [seg(1)] }) })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1, "elaboration of the same outcome must collapse to one addition, not two");
});

test("[H6, wi_g7/wi_g8 pattern] the same commitment restated in two DIFFERENT segments is recovered as exactly one missing-work addition", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll connect the agent to my phone."),
    transcriptLine(seg(2), "Person A", "sounds good"),
    transcriptLine(seg(3), "Speaker", "yeah, I'll hook the agent up to the phone once we're done here.")
  ].join("\n");

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Connect the agent to the phone", source_quote: "I'll connect the agent to my phone.", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Connect the agent to the phone", source_quote: "I'll hook the agent up to the phone once we're done here.", source_segment_ids: [seg(3)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Connect the agent to the phone", source_quote: "I'll connect the agent to my phone.", source_segment_ids: [seg(1)] })
      }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Connect the agent to the phone", source_quote: "I'll hook the agent up to the phone once we're done here.", source_segment_ids: [seg(3)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.duplicatesRemovedDeterministic.length, 0, "LAYER 1 cannot see this -- the segment sets never match");
  assert.equal(result.duplicatesRemovedSemantic.length, 1, "LAYER 2 (semantic, reused isNearDuplicateWorkItem) must catch the cross-segment restatement");
  assert.equal(result.additions.length, 1);
});

test("[H7] same topic, distinct actions -- 'finish implementation' and 'verify implementation works' both survive", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll finish implementation and verify the integration works.");
  const existingImplementation = item({
    ref: "wi_1",
    title: "Finish implementation",
    source_quote: "I'll finish implementation",
    source_segment_ids: [seg(1)]
  });

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existingImplementation],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Finish implementation", source_quote: "I'll finish implementation", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Verify the integration works", source_quote: "verify the integration works", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "already_represented" }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Verify the integration works", source_quote: "verify the integration works", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [existingImplementation], corrections: [], additions: result.additions, transcript });
  assert.equal(merged.length, 2, "distinct outcomes on the same topic (finish vs verify) both survive");
  const recovered = merged.find((entry) => entry.title === "Verify the integration works")!;
  assert.equal(isExecutionEligible(recovered), true);
});

test("[H8] a small promise embedded in a single clause of a long turn is harvested", async () => {
  const longTurn =
    "there's a lot going on this quarter with the roadmap review and the hiring push, but quickly, I'll send you the article, and then let's circle back to the roadmap stuff next week.";
  const transcript = transcriptLine(seg(1), "Speaker", longTurn);
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Send the article", source_quote: "I'll send you the article", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Send the article", source_quote: "I'll send you the article", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
});

// ===========================================================================
// PART 6 -- negative boundary tests: Pass A may over-harvest (high recall is its mandate), but
// Pass B must never let a speculative, retrospective, inactive, or non-execution candidate become
// an addition.
// ===========================================================================

test("[N1] speculative backlog phrasing ('maybe ... someday') produces no active addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "Maybe I'll send the article someday.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Send the article", source_quote: "Maybe I'll send the article someday.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "speculative_or_inactive" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
  assert.equal(result.adjudicationCounts.completenessDecisionSpeculativeOrInactive, 1);
});

test("[N2] a wistful aspiration ('it would be cool to') produces no active addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "It would be cool to walk them through this sometime.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Walk them through this", source_quote: "It would be cool to walk them through this sometime.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "speculative_or_inactive" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[N3] retrospective, already-completed language produces no open addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I already sent the article yesterday.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Send the article", source_quote: "I already sent the article yesterday.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "retrospective_or_completed" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
  assert.equal(result.adjudicationCounts.completenessDecisionRetrospectiveOrCompleted, 1);
});

test("[N4] an unactivated conditional offer with no later acceptance produces no active addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "If you want, I can send it.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Send it", source_quote: "If you want, I can send it.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "speculative_or_inactive" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[N5] a vague, unowned group aspiration ('we should probably verify it eventually') produces no active addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "We should probably verify it eventually.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Verify it", owner: null, owners: [], source_quote: "We should probably verify it eventually.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "non_execution" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
  assert.equal(result.adjudicationCounts.completenessDecisionNonExecution, 1);
});

test("[N6] a general explanation with no action anywhere in it is harvested as zero candidates", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "So historically the way this has worked is the platform team owns infra and the product team owns features, and that split has mostly held up over the last few years."
  );
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidatesHarvested, 0);
  assert.equal(result.additions.length, 0);
});

// ===========================================================================
// PART 7 -- observability
// ===========================================================================

test("[observability] harvest, adjudication, and dedup diagnostics are all populated end to end", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll finish the Chatter work and then confirm the drops flow works.");
  const existingChatterWork = item({
    ref: "wi_1",
    title: "Finish the Chatter work",
    source_quote: "I'll finish the Chatter work",
    source_segment_ids: [seg(1)]
  });

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existingChatterWork],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Finish the Chatter work", source_quote: "I'll finish the Chatter work", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Confirm the drops flow works", source_quote: "confirm the drops flow works", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "already_represented" }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Confirm the drops flow works", source_quote: "confirm the drops flow works", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidatesHarvested, 2);
  assert.equal(result.candidatesGroundingRejected, 0);
  assert.equal(result.candidatesExpectedForAdjudication, 2);
  assert.equal(result.decisionsReceived, 2);
  assert.deepEqual(result.missingCandidateRefsAfterRetry, []);
  assert.equal(result.adjudicationCounts.completenessDecisionAlreadyRepresented, 1);
  assert.equal(result.adjudicationCounts.completenessDecisionAdd, 1);
  assert.equal(result.groundedCount, 1);
  assert.equal(result.additions.length, 1);
  assert.equal(result.proposedByWindow.length, 1, "one window for a short transcript");
  assert.equal(result.proposedByWindow[0].proposed, 2);
  assert.equal(result.acceptedByWindow.length, 1);
  assert.equal(result.acceptedByWindow[0].title, "Confirm the drops flow works");
  assert.equal(result.acceptedByWindow[0].windowIndex, 0);
});

// ===========================================================================
// PART 8 -- Pass-A verification/experiment enumeration (generation-12 forensic-audit follow-up).
//
// The Gen-12 forensic audit found two remaining recall gaps sharing one root cause: Pass A
// under-enumerates a "confirm/check/verify/test/try...and see how it works" clause when it trails a
// longer, hedged lead-in in the same turn -- GT3-B folded "confirm the drops works" into the same
// candidate as "finish the chatter work"; GT4 (a committed experiment: "I can definitely talk to my
// agent about it... I want to see how it's used in practice") produced zero candidates at all, in a
// window that successfully harvested an unrelated promise moments later. These tests exercise the
// new ATOMIC_ACTION_HARVEST_PROMPT sections (VERIFICATION AND OBSERVATION ARE THEIR OWN OUTCOME;
// COMMITTED EXPERIMENTS ARE ACTIVE WORK, NOT ASPIRATION) at the pipeline-boundary level: given a
// harvest response shaped the way the strengthened prompt asks the model to produce, the rest of the
// pipeline (grounding, adjudication, dedup, eligibility) must carry it through correctly, and must
// keep two genuinely independent verification-class outcomes unmerged all the way to Pass B.
// ===========================================================================

test("[GT3-B class] a compound turn harvested as two candidates reaches Pass A's output as two independent, unmerged candidates", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "I'll finish up what I was working on and then confirm that the drops flow works."
  );
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({
        candidate_id: "c1",
        outcome: "Finish current work",
        source_quote: "I'll finish up what I was working on",
        source_segment_ids: [seg(1)]
      }),
      harvestCandidate({
        candidate_id: "c2",
        outcome: "Confirm the drops flow works",
        source_quote: "confirm that the drops flow works",
        source_segment_ids: [seg(1)]
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 2, "the verification clause must be exposed as its own candidate, not merged into the first");
  assert.deepEqual(result.candidates.map((c) => c.canonicalRef), ["hc_w0_1", "hc_w0_2"]);
  assert.equal(result.candidates[1].outcome, "Confirm the drops flow works");
});

test("[GT4 class] a committed experiment ('I can talk to my agent about it and see how it's used in practice') is harvested, added, and reaches eligibility", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "Yeah, I can definitely talk to my agent about it. I want to see how it's used in practice."
  );
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({
        outcome: "Try the approach with the agent and observe how it works in practice",
        source_quote: "Yeah, I can definitely talk to my agent about it. I want to see how it's used in practice.",
        source_segment_ids: [seg(1)]
      })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({
          title: "Try the approach with the agent and observe how it works in practice",
          source_quote: "Yeah, I can definitely talk to my agent about it. I want to see how it's used in practice.",
          source_segment_ids: [seg(1)]
        })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[V1] 'I'll deploy it and verify the endpoint responds' harvests two distinct, independently-checkable candidates", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll deploy it and verify the endpoint responds.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ candidate_id: "c1", outcome: "Deploy it", source_quote: "I'll deploy it", source_segment_ids: [seg(1)] }),
      harvestCandidate({ candidate_id: "c2", outcome: "Verify the endpoint responds", source_quote: "verify the endpoint responds", source_segment_ids: [seg(1)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 2);
});

test("[V2] 'I'll change the setting and check whether that fixes the issue' harvests the change and the check as two candidates", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll change the setting and check whether that fixes the issue.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ candidate_id: "c1", outcome: "Change the setting", source_quote: "I'll change the setting", source_segment_ids: [seg(1)] }),
      harvestCandidate({ candidate_id: "c2", outcome: "Check whether that fixes the issue", source_quote: "check whether that fixes the issue", source_segment_ids: [seg(1)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 2);
});

test("[V3] 'I'll test the workflow and let you know what happens' harvests the test and the report as two candidates", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll test the workflow and let you know what happens.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ candidate_id: "c1", outcome: "Test the workflow", source_quote: "I'll test the workflow", source_segment_ids: [seg(1)] }),
      harvestCandidate({ candidate_id: "c2", outcome: "Report the result", source_quote: "let you know what happens", source_segment_ids: [seg(1)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 2);
});

test("[V4] 'I can definitely try that approach tomorrow and see whether it works' is an active experiment candidate, not aspiration", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I can definitely try that approach tomorrow and see whether it works.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Try the approach and see whether it works", source_quote: "I can definitely try that approach tomorrow and see whether it works.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Try the approach and see whether it works", source_quote: "I can definitely try that approach tomorrow and see whether it works.", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
});

test("[V5] 'I'll run it once just to confirm the import works' is captured even though it is operationally small", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll run it once just to confirm the import works.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Run it once to confirm the import works", source_quote: "I'll run it once just to confirm the import works.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Run it once to confirm the import works", source_quote: "I'll run it once just to confirm the import works.", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
});

test("[verification N1] 'Maybe we could test that sometime' produces no active harvest", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "Maybe we could test that sometime.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[verification N2] 'I'd love to see how that works' produces no active execution merely from aspiration", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'd love to see how that works.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "See how that works", source_quote: "I'd love to see how that works.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "speculative_or_inactive" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[verification N3] 'I wonder if that would work' produces no action", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I wonder if that would work.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[verification N4] 'We tested that yesterday and it worked' is retrospective only", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "We tested that yesterday and it worked.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Test it", source_quote: "We tested that yesterday and it worked.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "retrospective_or_completed" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[verification N5] 'If I have time I'll test it' with no later activation is not active", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "If I have time I'll test it.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Test it", source_quote: "If I have time I'll test it.", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({ candidate_id: "hc_w0_1", disposition: "speculative_or_inactive" })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[verification N6] 'That confirms the service works' is a pure observation of an already-completed event, not a future/open action", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "That confirms the service works.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

// ===========================================================================
// PART 9 -- Pass-A/Pass-B diagnostic trace observability (generation-12 forensic-audit follow-up).
//
// The forensic audit's central limitation was that Pass A's raw candidate list was never persisted,
// so a future benchmark could not distinguish a Pass-A enumeration miss from a Pass-B rewrite
// without inference. These tests exercise the new bounded trace end to end: window -> candidate ->
// grounding -> adjudication -> resulting WorkItem ref, joinable purely by candidate_id.
// ===========================================================================

test("[trace] harvestTrace and adjudicationTrace are joinable end-to-end by candidate_id, and additionCandidateIds identifies which candidate produced which addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll finish the work and confirm the integration works.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: harvestResponse([
      harvestCandidate({ outcome: "Finish the work", source_quote: "I'll finish the work", source_segment_ids: [seg(1)] }),
      harvestCandidate({ outcome: "Confirm the integration works", source_quote: "confirm the integration works", source_segment_ids: [seg(1)] })
    ]),
    createAdjudicationResponse: adjudicationResponse([
      adjudicationDecision({
        candidate_id: "hc_w0_1",
        disposition: "add",
        addition: addition({ title: "Finish the work", source_quote: "I'll finish the work", source_segment_ids: [seg(1)] })
      }),
      adjudicationDecision({
        candidate_id: "hc_w0_2",
        disposition: "add",
        addition: addition({ title: "Confirm the integration works", source_quote: "confirm the integration works", source_segment_ids: [seg(1)] })
      })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.harvestTrace.length, 2);
  assert.deepEqual(result.harvestTrace.map((t) => t.candidateId), ["hc_w0_1", "hc_w0_2"]);
  assert.equal(result.harvestTrace[0].windowIndex, 0);
  assert.equal(result.harvestTrace[0].outcome, "Finish the work");
  assert.equal(result.harvestTrace[1].outcome, "Confirm the integration works");
  assert.equal((result.harvestTrace[0] as unknown as Record<string, unknown>).harvest_reason, undefined, "harvest_reason must never be retained in the trace");

  assert.equal(result.adjudicationTrace.length, 2);
  const harvestIds = new Set(result.harvestTrace.map((t) => t.candidateId));
  for (const decision of result.adjudicationTrace) {
    assert.ok(harvestIds.has(decision.candidateId), `adjudication decision ${decision.candidateId} must be traceable back to a harvested candidate`);
    assert.equal(decision.disposition, "add");
  }

  assert.deepEqual(result.additionCandidateIds, ["hc_w0_1", "hc_w0_2"]);
  assert.equal(result.groundingRejectionTrace.length, 0);
  assert.equal(result.traceTruncated, false);
});

test("[trace] a candidate rejected by harvest grounding is recorded with its window, candidate_id, and rejection reason", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send the article.");
  const result = await runAtomicActionHarvestPass({
    source: source({ transcript }),
    createResponse: harvestResponse([
      harvestCandidate({ candidate_id: "c1", outcome: "Real candidate", source_quote: "I'll send the article.", source_segment_ids: [seg(1)] }),
      harvestCandidate({ candidate_id: "c2", outcome: "Empty quote", source_quote: "   ", source_segment_ids: [seg(1)] }),
      harvestCandidate({ candidate_id: "c3", outcome: "Fabricated segment", source_quote: "something never said", source_segment_ids: [seg(99)] })
    ])
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidates.length, 1);
  assert.equal(result.harvestTrace.length, 1);
  assert.equal(result.harvestTrace[0].candidateId, "hc_w0_1");
  assert.equal(result.groundingRejectionTrace.length, 2);
  const byId = new Map(result.groundingRejectionTrace.map((r) => [r.candidateId, r]));
  assert.equal(byId.get("c2")?.rejectionReason, "empty_quote");
  assert.equal(byId.get("c2")?.windowIndex, 0);
  assert.equal(byId.get("c3")?.rejectionReason, "invalid_segment_ids");
});

test("[trace] resolveCompletenessAdjudicationTrace joins a Pass-B 'add' decision to its final wi_g ref, and leaves non-add dispositions null", () => {
  const additions = [
    addition({ title: "A", source_quote: "q1", source_segment_ids: [seg(1)] }),
    addition({ title: "B", source_quote: "q2", source_segment_ids: [seg(2)] })
  ];
  const resolved = resolveCompletenessAdjudicationTrace({
    additions,
    additionCandidateIds: ["hc_w0_1", "hc_w0_3"],
    adjudicationTrace: [
      { candidateId: "hc_w0_1", disposition: "add", reason: "r1" },
      { candidateId: "hc_w0_2", disposition: "already_represented", reason: "r2" },
      { candidateId: "hc_w0_3", disposition: "add", reason: "r3" }
    ]
  });
  assert.deepEqual(resolved, [
    { candidate_id: "hc_w0_1", disposition: "add", reason: "r1", resulting_work_item_ref: "wi_g1" },
    { candidate_id: "hc_w0_2", disposition: "already_represented", reason: "r2", resulting_work_item_ref: null },
    { candidate_id: "hc_w0_3", disposition: "add", reason: "r3", resulting_work_item_ref: "wi_g2" }
  ]);
});
