import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import { COMPLETENESS_RECOVERY_PROMPT } from "../lib/execution-intelligence/work-item-prompts";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  dedupeCompletenessAdditions,
  isLifecycleReviewCandidate,
  runCompletenessRecoveryPass
} from "../lib/execution-intelligence/work-item-stages";
import type { GlobalWorkItemAddition, RawWorkItem, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Completeness-recovery outcome atomicity (missed-voluntary-promise recall follow-up).
//
// Forensic audit of generation 10 (meeting e9dcc8fe-..., job 03d52a9e-...) found three GT items
// still never extracted -- GT3-B ("confirm the drops flow works," embedded after "and then" inside
// a much longer turn that ALSO restates already-covered Chatter work), GT5 ("I'll send you a link
// of an article," embedded inside a longer turn about AI-engineer skills), and GT6 ("I will walk
// them through explaining product-founder fit," embedded inside the SAME segment as a DIFFERENT,
// already-extracted "chaperone" commitment). All three trace to the same root cause: the
// completeness-recovery pass operates at TURN/TOPIC atomicity, not OUTCOME atomicity, so a distinct
// commitment sharing a segment with an already-covered (or more prominent) outcome from the same
// turn is silently dropped. wi_g5's own stored quote for GT6's segment literally elides the
// product-founder-fit clause with an ellipsis while keeping the chaperone clause -- direct evidence
// of turn-level (not outcome-level) collapsing. These tests exercise the real
// runCompletenessRecoveryPass and the real (redesigned) dedupeCompletenessAdditions to prove the
// pipeline can now represent multiple distinct outcomes sharing one segment, without either
// flooding the ledger with artificial splits or breaking genuine duplicate suppression.
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

// ===========================================================================
// PART 1 -- dedupeCompletenessAdditions unit coverage (the corrected primitive itself)
// ===========================================================================

test("[dedup unit] same segment set + same statement (normalized-equal quotes) is a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "I'll send Sam the article", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "dup", source_quote: "I'll send Sam the article", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 0);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].matchedTitle, "Send the article");
});

test("[dedup unit] same segment set but a DIFFERENT statement is NOT a duplicate -- the compound-turn fix", () => {
  const existing = item({ ref: "wi_1", title: "Finish the Chatter work", source_quote: "i'll finish up what i was working on", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "Confirm the drops flow works", source_quote: "and then confirm that the drops works", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 1, "a distinct outcome sharing a segment with an existing item must survive");
  assert.equal(removed.length, 0);
});

test("[dedup unit] quote containment (one quote is a substring of the other) on the same segment set is still treated as a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article we discussed tonight", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "dup (shorter excerpt)", source_quote: "send sam the article", source_segment_ids: [seg(1)] })]
  );
  assert.equal(kept.length, 0);
  assert.equal(removed.length, 1);
});

test("[dedup unit] a PARTIAL segment overlap (not a full set match) is NOT treated as a duplicate", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "different outcome spanning two segments", source_quote: "i'll send sam the article and also call him", source_segment_ids: [seg(1), seg(2)] })]
  );
  assert.equal(kept.length, 1, "an addition whose segment set is not an exact match to any existing item's segment set must not be silently dropped");
});

test("[dedup unit] different segment sets are never deduped by this primitive, even with identical quotes -- cross-segment duplicate suppression is the model's job via the ledger summary, not this deterministic check", () => {
  const existing = item({ ref: "wi_1", title: "Send the article", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept } = dedupeCompletenessAdditions(
    [existing],
    [addition({ title: "paraphrase elsewhere", source_quote: "i'll send sam the article", source_segment_ids: [seg(2)] })]
  );
  assert.equal(kept.length, 1);
});

test("[dedup unit] cross-window duplicate proposals (same segment, same quote) collapse to one, first occurrence wins", () => {
  const candidateA = addition({ title: "A", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const candidateB = addition({ title: "B", source_quote: "i'll send sam the article", source_segment_ids: [seg(1)] });
  const { kept, removed } = dedupeCompletenessAdditions([], [candidateA, candidateB]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "A");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].matchedTitle, "A");
});

// ===========================================================================
// PART 2 -- pipeline-boundary tests via the real runCompletenessRecoveryPass
// ===========================================================================

test("[C1] a small voluntary promise is recovered as a grounded addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll send Laura the article.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [addition({ title: "Send Laura the article", source_quote: "I'll send Laura the article.", source_segment_ids: [seg(1)] })]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C2] a promise at the end of a long conversational turn is recovered despite surrounding discussion", async () => {
  const longTurn =
    "so basically our challenge is going to be getting everyone up to speed on the process and there's a lot of moving parts here, we've been discussing the format for weeks now, and I will walk the incoming group through the process.";
  const transcript = transcriptLine(seg(1), "Speaker", longTurn);
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [addition({ title: "Walk the incoming group through the process", source_quote: "I will walk the incoming group through the process.", source_segment_ids: [seg(1)] })]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

test("[C3] a compound turn's second, distinct outcome is recovered even though the first outcome already has a ledger item citing the same segment", async () => {
  const transcript = transcriptLine(
    seg(1),
    "Speaker",
    "I'll finish the Chatter work and then confirm the drops flow works."
  );
  const existingChatterWork = item({
    ref: "wi_1",
    title: "Finish the Chatter work",
    source_quote: "I'll finish the Chatter work",
    source_segment_ids: [seg(1)]
  });

  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existingChatterWork],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Confirm the drops flow works",
          source_quote: "confirm the drops flow works",
          source_segment_ids: [seg(1)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1, "the distinct second outcome must not be suppressed merely because the first outcome from the same turn is already in the ledger");
  assert.equal(result.duplicatesRemoved.length, 0);

  const merged = applyGlobalCorrections({ workItems: [existingChatterWork], corrections: [], additions: result.additions, transcript });
  assert.equal(merged.length, 2);
  const recovered = merged.find((entry) => entry.title === "Confirm the drops flow works")!;
  assert.equal(isExecutionEligible(recovered), true);
  assert.equal(isLifecycleReviewCandidate(recovered), true, "the recovered outcome must also be visible to lifecycle reconciliation");
});

test("[C4] three distinct outcomes from one compound turn can all be represented", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll fix the build, verify deployment, and send the link.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({ title: "Fix the build", source_quote: "I'll fix the build", source_segment_ids: [seg(1)] }),
        addition({ title: "Verify deployment", source_quote: "verify deployment", source_segment_ids: [seg(1)] }),
        addition({ title: "Send the link", source_quote: "send the link", source_segment_ids: [seg(1)] })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 3, "three semantically distinct outcomes sharing one segment must all survive");
  assert.equal(result.duplicatesRemoved.length, 0);
});

test("[C5] a same-outcome paraphrase already covered by the ledger produces no duplicate addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I'll forward that article to Laura tonight.");
  const existingArticlePromise = item({
    ref: "wi_1",
    title: "Send Laura the article",
    source_quote: "I'll send Laura the article",
    source_segment_ids: [seg(2)]
  });
  // A correctly-behaving model recognizes this as already covered by the ledger summary it was
  // shown, and proposes nothing -- this proves the pipeline never forces a duplicate through.
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [existingArticlePromise],
    createResponse: fakeModelResponse({ additions: [] })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[C6] a distinct verification outcome adjacent to an existing implementation item is recovered", async () => {
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
    createResponse: fakeModelResponse({
      additions: [addition({ title: "Verify the integration works", source_quote: "verify the integration works", source_segment_ids: [seg(1)] })]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [existingImplementation], corrections: [], additions: result.additions, transcript });
  const recovered = merged.find((entry) => entry.title === "Verify the integration works")!;
  assert.equal(isExecutionEligible(recovered), true);
});

test("[C7] speculative language produces no addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "Maybe I'll send that article sometime.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({ additions: [] })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[C8] retrospective (already-completed) language produces no open addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "I already sent the article yesterday.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({ additions: [] })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[C9] an unactivated conditional offer produces no active addition", async () => {
  const transcript = transcriptLine(seg(1), "Speaker", "If you need it, I can send you the article.");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({ additions: [] })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 0);
});

test("[C10] an activated conditional offer is recoverable as active accepted work", async () => {
  const transcript = [
    transcriptLine(seg(1), "Speaker", "If you need it, I can send you the article."),
    transcriptLine(seg(2), "Person A", "Yes, please.")
  ].join("\n");
  const result = await runCompletenessRecoveryPass({
    source: source({ transcript }),
    workItems: [],
    createResponse: fakeModelResponse({
      additions: [
        addition({
          title: "Send the article",
          source_quote: "If you need it, I can send you the article.",
          source_segment_ids: [seg(1), seg(2)]
        })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.additions.length, 1);
  const merged = applyGlobalCorrections({ workItems: [], corrections: [], additions: result.additions, transcript });
  assert.equal(isExecutionEligible(merged[0]), true);
});

// ===========================================================================
// PART 3 -- observability
// ===========================================================================

test("[observability] proposedByWindow, acceptedByWindow, and duplicatesRemoved are populated correctly", async () => {
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
    createResponse: fakeModelResponse({
      additions: [
        // Proposes the already-covered outcome again (should be deduped) AND the genuinely new one.
        addition({ title: "Finish the Chatter work (re-proposed)", source_quote: "I'll finish the Chatter work", source_segment_ids: [seg(1)] }),
        addition({ title: "Confirm the drops flow works", source_quote: "confirm the drops flow works", source_segment_ids: [seg(1)] })
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.groundedCount, 2);
  assert.equal(result.additions.length, 1);
  assert.equal(result.duplicatesRemoved.length, 1);
  assert.equal(result.duplicatesRemoved[0].matchedTitle, "Finish the Chatter work");
  assert.equal(result.proposedByWindow.length, 1, "one window for a short transcript");
  assert.equal(result.proposedByWindow[0].proposed, 2);
  assert.equal(result.acceptedByWindow.length, 1);
  assert.equal(result.acceptedByWindow[0].title, "Confirm the drops flow works");
  assert.equal(result.acceptedByWindow[0].windowIndex, 0);
});

// ===========================================================================
// PART 4 -- prompt-content assertions
// ===========================================================================

test("[prompt] COMPLETENESS_RECOVERY_PROMPT instructs action-level (not turn-level) atomicity", () => {
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /ACTION-LEVEL ATOMICITY/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /the ledger already covering one of them never implies the others are covered/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /not a mechanical instruction to split every "and" into separate items/);
});

test("[prompt] COMPLETENESS_RECOVERY_PROMPT instructs conditional offers stay non-active until activated", () => {
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /CONDITIONAL OFFERS/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /unless this same window's transcript shows the condition\s*\nactually being invoked or accepted/);
});

test("[prompt] the new sections are generic -- no hardcoded benchmark names", () => {
  const forbidden = ["Laura", "Craig", "Jay", "Parfait", "Chatter", "drops"];
  const startIndex = COMPLETENESS_RECOVERY_PROMPT.indexOf("ACTION-LEVEL ATOMICITY");
  const endIndex = COMPLETENESS_RECOVERY_PROMPT.indexOf("Every addition must be grounded");
  const newSection = COMPLETENESS_RECOVERY_PROMPT.slice(startIndex, endIndex);
  for (const name of forbidden) {
    assert.doesNotMatch(newSection, new RegExp(name, "i"), name);
  }
});
