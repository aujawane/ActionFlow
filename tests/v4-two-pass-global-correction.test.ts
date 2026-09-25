import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  dedupeCompletenessAdditions,
  filterGroundedAdditions,
  isLifecycleReviewCandidate,
  runCompletenessRecoveryPass,
  runLifecycleReconciliationPass,
  validateLifecycleReviewCoverage
} from "../lib/execution-intelligence/work-item-stages";
import type {
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
  RawWorkItem,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// These tests exercise the ACTUAL two-pass orchestration (runCompletenessRecoveryPass /
// runLifecycleReconciliationPass), not just prompt-string assertions or hand-built fixtures fed
// straight into applyGlobalCorrections (that boundary is already covered by
// v4-recall-temporal-hardening.test.ts). A mocked createResponse stands in for the live model --
// per the task's own framing, these tests can only prove (1) the focused model output CAN express
// the desired behavior and parses against the real schema, (2) the pipeline correctly applies it
// via the unmodified applyGlobalCorrections, (3) lifecycle refs cannot silently go unreviewed, and
// (4) isExecutionEligible behaves correctly afterward -- not that a live model will judge any given
// transcript correctly. That is what an actual staging benchmark run is for.
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

function correction(
  overrides: Partial<GlobalWorkItemCorrection> & { ref: string }
): GlobalWorkItemCorrection {
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
    ...overrides
  };
}

// ===========================================================================
// PASS A -- completeness recovery
// ===========================================================================

test("[C1] a self-initiated voluntary promise with no prior request becomes a grounded addition that reaches eligibility", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Sam the article we discussed");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Send Sam the article",
          recipient: "Sam",
          source_quote: "I'll send Sam the article we discussed",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);

  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(merged.length, 1);
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C2] a self-initiated future commitment ('I will walk the cohort through X') is grounded and current_scope despite executing after the meeting", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "I will walk the incoming cohort through product-founder fit next week"
  );
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Walk the incoming cohort through product-founder fit",
          scope_state: "current_scope",
          source_quote: "I will walk the incoming cohort through product-founder fit next week",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(merged[0].scope_state, "current_scope");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C3] multi-person agreed work preserves every named owner instead of collapsing to 'Team'", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "we're going to test the build, and Sam and Priya will send feedback"
  );
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Test the build and send feedback",
          owner: "Speaker",
          owners: ["Speaker", "Sam", "Priya"],
          source_quote: "we're going to test the build, and Sam and Priya will send feedback",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.deepEqual(merged[0].owners, ["Speaker", "Sam", "Priya"]);
  assert.notEqual(merged[0].owner, "Team");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C4] a concrete voluntary offer to try something with a named tool is grounded and eligible", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I can definitely try the reversibility idea with my agent");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Try the reversibility idea",
          source_quote: "I can definitely try the reversibility idea with my agent",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C5] a candidate addition that overlaps an existing ledger item's evidence is deduplicated, not added again", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Sam the article we discussed");
  const existing = item({
    ref: "wi_1",
    title: "Send the article",
    source_quote: "I'll send Sam the article we discussed",
    source_segment_ids: [seg(1)]
  });
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existing],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Send the article (re-detected)",
          source_quote: "I'll send Sam the article we discussed",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0, "the ledger already covers this segment -- no duplicate addition");

  // Direct unit coverage of the dedup primitive itself, isolated from the model-call plumbing.
  const deduped = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "dup", source_quote: "q", source_segment_ids: [seg(1)] })]
  );
  assert.equal(deduped.length, 0);
});

test("[C6] a hypothetical with no clear commitment produces no addition, and a fabricated addition would be rejected by grounding regardless", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "maybe I could send an article someday");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({ additions: [] })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);

  // Even if a hypothetical were mistakenly proposed, grounding would still catch it if ungrounded.
  const validSegments = new Set([seg(1)]);
  const ungrounded = filterGroundedAdditions(
    [addition({ title: "Send an article", source_quote: "", source_segment_ids: [seg(1)] })],
    validSegments
  );
  assert.equal(ungrounded.length, 0, "an empty source_quote must never survive grounding");
  const fabricatedSegment = filterGroundedAdditions(
    [addition({ title: "Send an article", source_quote: "maybe I could send an article someday", source_segment_ids: [seg(99)] })],
    validSegments
  );
  assert.equal(fabricatedSegment.length, 0, "a segment ID absent from this transcript must never survive grounding");
});

test("[completeness recovery] an addition citing a segment ID that does not exist in the transcript is dropped end-to-end, not merged", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Sam the article we discussed");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Fabricated work",
          source_quote: "something never said",
          source_segment_ids: [seg(99)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[completeness recovery, windowing] additions independently proposed by two overlapping chronological windows for the same statement are merged into exactly one", async () => {
  // Force multiple chunks: EXECUTION_CHUNK_MAX_SEGMENTS is 50, so 60 segments guarantees a split.
  const lines: string[] = [];
  for (let i = 1; i <= 60; i += 1) {
    lines.push(transcriptLine(seg(i), "Speaker", `filler statement number ${i}`));
  }
  const transcript = lines.join("\n");

  // Both windows' mocked model call return the SAME addition (same evidence segment) -- simulating
  // the real scenario where a promise falls inside the overlap region and both windows see it.
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Send the article",
          source_quote: "filler statement number 1",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1, "cross-window duplicate proposals for the same evidence collapse to one");
});

// ===========================================================================
// PASS B -- lifecycle reconciliation
// ===========================================================================

function lifecycleCandidate(overrides: Partial<WorkItem> & { ref: string; title: string; source_quote: string }) {
  const built = item({
    classification: "accepted_request",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action",
    ...overrides
  });
  assert.equal(isLifecycleReviewCandidate(built), true, "fixture must actually qualify as a lifecycle candidate");
  return built;
}

test("[L1] an accepted request whose action is completed later in the meeting is corrected to completed/ineligible", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you show us the demo?"),
    transcriptLine(seg(2), "Person B", "sure, I'll share my screen"),
    transcriptLine(seg(3), "Person B", "so here's the whole walkthrough")
  ].join("\n");
  const demo = lifecycleCandidate({ ref: "wi_1", title: "Show the demo", source_quote: "sure, I'll share my screen", source_segment_ids: [seg(2)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [demo],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "completed_work",
          status: "completed",
          acceptance_state: "none",
          source_quote: "sure, I'll share my screen",
          source_segment_ids: [seg(2), seg(3)],
          reconciliation_reason: "The demo was subsequently walked through in seg 3."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reviews.length, 1);
  assert.deepEqual(result.missingRefsAfterRetry, []);

  const merged = applyGlobalCorrections({ workItems: [demo], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "completed");
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[L2] a distinct accepted action (e.g. restarting something) that is later actually performed is corrected to completed/ineligible", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you restart the application?"),
    transcriptLine(seg(2), "Person B", "yep, restarting it now"),
    transcriptLine(seg(3), "Person B", "okay it's back up")
  ].join("\n");
  const restart = lifecycleCandidate({ ref: "wi_1", title: "Restart the application", source_quote: "yep, restarting it now", source_segment_ids: [seg(2)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [restart],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "completed_work",
          status: "completed",
          acceptance_state: "none",
          source_quote: "yep, restarting it now",
          source_segment_ids: [seg(2), seg(3)],
          reconciliation_reason: "Confirmed back up in seg 3."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [restart], corrections: result.reviews, additions: [], transcript });
  assert.equal(isExecutionEligible(merged[0]), false);
});

test("[L3] completion evidence for one ref is never misattached to a different, merely similar-sounding ref", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you take a screenshot?"),
    transcriptLine(seg(2), "Person B", "done, here's the screenshot"),
    transcriptLine(seg(3), "Person A", "can you send that to the team too?"),
    transcriptLine(seg(4), "Person B", "sure, I'll send it over")
  ].join("\n");
  const takeScreenshot = lifecycleCandidate({
    ref: "wi_1",
    title: "Take a screenshot",
    source_quote: "done, here's the screenshot",
    source_segment_ids: [seg(2)]
  });
  const sendScreenshot = lifecycleCandidate({
    ref: "wi_2",
    title: "Send the screenshot to the team",
    source_quote: "sure, I'll send it over",
    source_segment_ids: [seg(4)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [takeScreenshot, sendScreenshot],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "completed_work",
          status: "completed",
          acceptance_state: "none",
          source_quote: "done, here's the screenshot",
          source_segment_ids: [seg(2)],
          reconciliation_reason: "The screenshot itself was taken in seg 2."
        }),
        correction({
          ref: "wi_2",
          classification: "accepted_request",
          status: "open",
          acceptance_state: "accepted",
          source_quote: "sure, I'll send it over",
          source_segment_ids: [seg(4)],
          reconciliation_reason: null
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({
    workItems: [takeScreenshot, sendScreenshot],
    corrections: result.reviews,
    additions: [],
    transcript
  });
  const byRef = new Map(merged.map((entry) => [entry.ref, entry]));
  assert.equal(isExecutionEligible(byRef.get("wi_1")!), false, "the completed screenshot action is not eligible");
  assert.equal(isExecutionEligible(byRef.get("wi_2")!), true, "the still-open send action must not inherit wi_1's completion");
});

test("[L4] a genuinely still-open item with no completion evidence stays open/current_scope/accepted", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send you that report tomorrow");
  const open = lifecycleCandidate({ ref: "wi_1", title: "Send the report", source_quote: "I'll send you that report tomorrow", source_segment_ids: [seg(1)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [open],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "accepted_request",
          status: "open",
          acceptance_state: "accepted",
          scope_state: "current_scope",
          source_quote: "I'll send you that report tomorrow",
          source_segment_ids: [seg(1)],
          reconciliation_reason: null
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [open], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "open");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[L5] an earlier similar-sounding topic does not complete a later, distinct promise", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "we talked about doing a walkthrough like this before"),
    transcriptLine(seg(2), "Person B", "I'll actually record a walkthrough video next week")
  ].join("\n");
  const laterPromise = lifecycleCandidate({
    ref: "wi_1",
    title: "Record a walkthrough video",
    classification: "promise",
    source_quote: "I'll actually record a walkthrough video next week",
    source_segment_ids: [seg(2)]
  });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [laterPromise],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "promise",
          status: "open",
          acceptance_state: "accepted",
          source_quote: "I'll actually record a walkthrough video next week",
          source_segment_ids: [seg(2)],
          reconciliation_reason: null
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [laterPromise], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged[0].status, "open");
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[L6] duplicate conversational representations of the same action reconcile to at most one active representation", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you show us the demo?"),
    transcriptLine(seg(2), "Person B", "sure, I can do that"),
    transcriptLine(seg(3), "Person A", "great, go ahead and share your screen then")
  ].join("\n");
  const asAssignment = lifecycleCandidate({ ref: "wi_1", title: "Show the demo (assignment)", classification: "assignment", source_quote: "sure, I can do that", source_segment_ids: [seg(2)] });
  const asAcceptedRequest = lifecycleCandidate({ ref: "wi_2", title: "Show the demo (accepted request)", source_quote: "great, go ahead and share your screen then", source_segment_ids: [seg(3)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [asAssignment, asAcceptedRequest],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "assignment",
          status: "open",
          acceptance_state: "accepted",
          scope_state: "superseded",
          superseded_item_refs: ["wi_2"],
          superseding_segment_ids: [seg(3)],
          source_quote: "sure, I can do that",
          source_segment_ids: [seg(2)]
        }),
        correction({
          ref: "wi_2",
          classification: "accepted_request",
          status: "open",
          acceptance_state: "accepted",
          source_quote: "great, go ahead and share your screen then",
          source_segment_ids: [seg(3)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [asAssignment, asAcceptedRequest], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged.filter(isExecutionEligible).length, 1);
});

test("[L7] duplicate representations where the canonical action is later completed leave ZERO active representations", async () => {
  const transcript = [
    transcriptLine(seg(1), "Person A", "can you show us the demo?"),
    transcriptLine(seg(2), "Person B", "sure, I can do that"),
    transcriptLine(seg(3), "Person A", "great, go ahead and share your screen then"),
    transcriptLine(seg(4), "Person B", "so here's the whole walkthrough")
  ].join("\n");
  const asAssignment = lifecycleCandidate({ ref: "wi_1", title: "Show the demo (assignment)", classification: "assignment", source_quote: "sure, I can do that", source_segment_ids: [seg(2)] });
  const asAcceptedRequest = lifecycleCandidate({ ref: "wi_2", title: "Show the demo (accepted request)", source_quote: "great, go ahead and share your screen then", source_segment_ids: [seg(3)] });

  const result = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: [asAssignment, asAcceptedRequest],
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: "wi_1",
          classification: "assignment",
          scope_state: "superseded",
          superseded_item_refs: ["wi_2"],
          superseding_segment_ids: [seg(3)],
          source_quote: "sure, I can do that",
          source_segment_ids: [seg(2)]
        }),
        correction({
          ref: "wi_2",
          classification: "completed_work",
          status: "completed",
          acceptance_state: "none",
          source_quote: "great, go ahead and share your screen then",
          source_segment_ids: [seg(3), seg(4)],
          reconciliation_reason: "Walked through in seg 4."
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = applyGlobalCorrections({ workItems: [asAssignment, asAcceptedRequest], corrections: result.reviews, additions: [], transcript });
  assert.equal(merged.filter(isExecutionEligible).length, 0);
});

test("[L8] a ref omitted from the model's first response is recovered via targeted retry, not silently dropped", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll do the first thing"),
    transcriptLine(seg(2), "Speaker", "I'll do the second thing"),
    transcriptLine(seg(3), "Speaker", "I'll do the third thing")
  ].join("\n");
  const items = [
    lifecycleCandidate({ ref: "wi_1", title: "First thing", source_quote: "I'll do the first thing", source_segment_ids: [seg(1)] }),
    lifecycleCandidate({ ref: "wi_2", title: "Second thing", source_quote: "I'll do the second thing", source_segment_ids: [seg(2)] }),
    lifecycleCandidate({ ref: "wi_3", title: "Third thing", source_quote: "I'll do the third thing", source_segment_ids: [seg(3)] })
  ];

  let callCount = 0;
  const createResponse = async () => {
    callCount += 1;
    if (callCount === 1) {
      // Omits wi_3 entirely -- simulates the generation-6 failure mode.
      return {
        output_text: JSON.stringify({
          reviews: [
            correction({ ref: "wi_1", source_quote: "I'll do the first thing", source_segment_ids: [seg(1)] }),
            correction({ ref: "wi_2", source_quote: "I'll do the second thing", source_segment_ids: [seg(2)] })
          ]
        })
      };
    }
    return {
      output_text: JSON.stringify({
        reviews: [correction({ ref: "wi_3", source_quote: "I'll do the third thing", source_segment_ids: [seg(3)] })]
      })
    };
  };

  const result = await runLifecycleReconciliationPass({ source: source({ transcript }), workItems: items, createResponse });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(callCount, 2, "a retry call must have been made for the omitted ref");
  assert.equal(result.reviews.length, 3, "all three refs are reviewed once the retry recovers the omitted one");
  assert.deepEqual(result.missingRefsAfterRetry, []);
  const refsReviewed = result.reviews.map((review) => review.ref).sort();
  assert.deepEqual(refsReviewed, ["wi_1", "wi_2", "wi_3"]);
});

test("[L8 continued] a ref still missing after the retry is left unreviewed rather than dropped from the ledger or falsely marked reviewed", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "I'll do the first thing"),
    transcriptLine(seg(2), "Speaker", "I'll do the second thing")
  ].join("\n");
  const items = [
    lifecycleCandidate({ ref: "wi_1", title: "First thing", source_quote: "I'll do the first thing", source_segment_ids: [seg(1)] }),
    lifecycleCandidate({ ref: "wi_2", title: "Second thing", source_quote: "I'll do the second thing", source_segment_ids: [seg(2)] })
  ];

  // The model omits wi_2 on both the initial call AND the retry.
  const createResponse = fakeModelResponse({
    reviews: [correction({ ref: "wi_1", source_quote: "I'll do the first thing", source_segment_ids: [seg(1)] })]
  });

  const result = await runLifecycleReconciliationPass({ source: source({ transcript }), workItems: items, createResponse });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reviews.length, 1);
  assert.deepEqual(result.missingRefsAfterRetry, ["wi_2"]);

  // The pipeline must never silently treat this as "successfully reviewed" -- the unreviewed item
  // passes through applyGlobalCorrections completely unchanged (still present, still whatever it
  // was before this pass ran), not dropped from the ledger.
  const merged = applyGlobalCorrections({ workItems: items, corrections: result.reviews, additions: [], transcript });
  assert.equal(merged.length, 2);
  const untouched = merged.find((entry) => entry.ref === "wi_2")!;
  assert.equal(untouched.source_quote, "I'll do the second thing");
  assert.equal(isExecutionEligible(untouched), true, "an unreviewed-but-previously-eligible item keeps its prior eligibility, it is not silently excluded");
});

test("[coverage] validateLifecycleReviewCoverage rejects hallucinated refs and collapses duplicate reviews for the same ref", () => {
  const { covered, missingRefs } = validateLifecycleReviewCoverage(
    ["wi_1", "wi_2"],
    [
      correction({ ref: "wi_1" }),
      correction({ ref: "wi_1", classification_reason: "duplicate response for the same ref" }),
      correction({ ref: "wi_99" }) // not requested -- must be dropped
    ]
  );
  assert.equal(covered.length, 1);
  assert.equal(covered[0].ref, "wi_1");
  assert.deepEqual(missingRefs, ["wi_2"]);
});

test("[candidate selection] isLifecycleReviewCandidate includes accepted current_scope and future_scope work, excludes informational/completed/non-project items", () => {
  const currentScope = item({ ref: "wi_1", title: "a", source_quote: "q", classification: "promise", acceptance_state: "accepted", scope_state: "current_scope", execution_scope: "project_work", work_item_role: "action" });
  const misclassifiedFutureScope = item({ ref: "wi_2", title: "b", source_quote: "q", classification: "accepted_request", acceptance_state: "accepted", scope_state: "future_scope", execution_scope: "project_work", work_item_role: "action" });
  const merelyRequested = item({ ref: "wi_3", title: "c", source_quote: "q", classification: "request", acceptance_state: "requested", scope_state: "current_scope", execution_scope: "project_work", work_item_role: "action" });
  const alreadyCompleted = item({ ref: "wi_4", title: "d", source_quote: "q", classification: "completed_work", acceptance_state: "none", status: "completed", scope_state: "current_scope", execution_scope: "project_work", work_item_role: "action" });
  const informational = item({ ref: "wi_5", title: "e", source_quote: "q", classification: "promise", acceptance_state: "accepted", scope_state: "current_scope", execution_scope: "informational", work_item_role: "action" });
  const ideaRole = item({ ref: "wi_6", title: "f", source_quote: "q", classification: "idea", acceptance_state: "none", scope_state: "current_scope", execution_scope: "project_work", work_item_role: "idea" });

  assert.equal(isLifecycleReviewCandidate(currentScope), true);
  assert.equal(isLifecycleReviewCandidate(misclassifiedFutureScope), true, "a plausibly-misclassified future_scope item must still be reviewable");
  assert.equal(isLifecycleReviewCandidate(merelyRequested), true, "a merely-requested item is a candidate for potential acceptance repair");
  assert.equal(isLifecycleReviewCandidate(alreadyCompleted), false, "a completed item does not need lifecycle re-review");
  assert.equal(isLifecycleReviewCandidate(informational), false);
  assert.equal(isLifecycleReviewCandidate(ideaRole), false);
});

// ===========================================================================
// Pipeline-order integration: Pass A's grounded addition is itself reviewable by Pass B in the
// same run, exactly as runV4GlobalCorrection (v4-pipeline.ts) sequences them.
// ===========================================================================

test("[pipeline order] an item recovered by completeness recovery is itself a lifecycle-review candidate in the same pass sequence", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Sam the article we discussed");

  const passA = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({ title: "Send Sam the article", source_quote: "I'll send Sam the article we discussed", source_segment_ids: [seg(1)] })
      ]
    })
  });
  assert.equal(passA.ok, true);
  if (!passA.ok) return;

  const ledgerAfterAdditions = applyGlobalCorrections({
    workItems: [],
    corrections: [],
    additions: passA.additions,
    transcript
  });
  assert.equal(ledgerAfterAdditions.length, 1);
  const recoveredRef = ledgerAfterAdditions[0].ref;
  assert.equal(isLifecycleReviewCandidate(ledgerAfterAdditions[0]), true);

  const passB = await runLifecycleReconciliationPass({
    source: source({ transcript }),
    workItems: ledgerAfterAdditions,
    createResponse: fakeModelResponse({
      reviews: [
        correction({
          ref: recoveredRef,
          source_quote: "I'll send Sam the article we discussed",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(passB.ok, true);
  if (!passB.ok) return;
  assert.equal(passB.reviews.length, 1);

  const finalItems = applyGlobalCorrections({
    workItems: ledgerAfterAdditions,
    corrections: passB.reviews,
    additions: [],
    transcript
  });
  assert.equal(finalItems.length, 1);
  assert.equal(isExecutionEligible(finalItems[0]), true);
});
