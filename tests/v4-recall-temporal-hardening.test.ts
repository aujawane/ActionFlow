import assert from "node:assert/strict";
import test from "node:test";

import { applyGlobalCorrections } from "../lib/execution-intelligence/v4-pipeline";
import { isExecutionEligible, isEligibleAcceptanceCriterion } from "../lib/execution-intelligence/execution-tree";
import {
  COMPLETENESS_RECOVERY_PROMPT,
  LIFECYCLE_RECONCILIATION_PROMPT,
  WORK_ITEM_EXTRACTION_PROMPT
} from "../lib/execution-intelligence/work-item-prompts";
import {
  workItemSchema,
  type GlobalWorkItemAddition,
  type GlobalWorkItemCorrection,
  type RawWorkItem,
  type WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Generic fixtures. Deliberately no benchmark participant/product names
// (Aditya/Laura/Craig/Jay/Parfait/Chatter) anywhere in this file -- these tests validate
// CATEGORIES of behavior, not the specific benchmark meeting. See "V4 recall + temporal-state
// hardening" pass notes.
// ---------------------------------------------------------------------------

const SEG_1 = "11111111-1111-4111-8111-111111111111";
const SEG_2 = "22222222-2222-4222-8222-222222222222";
const SEG_3 = "33333333-3333-4333-8333-333333333333";
const SEG_4 = "44444444-4444-4444-8444-444444444444";
const SEG_5 = "55555555-5555-4555-8555-555555555555";
const SEG_6 = "66666666-6666-4666-8666-666666666666";

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
    source_segment_ids: [SEG_1],
    extraction_reason: "Fixture.",
    confidence: 0.9,
    ...overrides
  };
}

function item(overrides: Partial<WorkItem> & { ref: string; title: string; source_quote: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
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
    source_segment_ids: [SEG_1],
    classification_reason: "Fixture correction.",
    reconciliation_reason: null,
    superseding_segment_ids: [],
    superseded_item_refs: [],
    completion_segment_ids: [],
    completion_reason: null,
    ...overrides
  };
}

function addition(
  overrides: Partial<GlobalWorkItemAddition> & { title: string; source_quote: string; source_segment_ids: string[] }
): GlobalWorkItemAddition {
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
    classification_reason: "Fixture addition.",
    extraction_reason: "Global correction recovered a missed promise.",
    confidence: 0.85,
    ...overrides
  };
}

function transcriptLine(id: string, speaker: string, text: string) {
  return `[${id}] [2026-01-01T00:00:00.000Z] ${speaker}: ${text}`;
}

// ===========================================================================
// PART 1 -- schema + REAL isExecutionEligible() contract tests
//
// Each case constructs the WorkItem shape the strengthened prompts (see PART 3) are now
// instructed to produce, then proves the field combination (a) parses against the real schema and
// (b) the UNMODIFIED isExecutionEligible() gate includes/excludes it as expected. The prompt
// behavior itself cannot be asserted without a live model call (see PART 3 for what IS checked
// about the prompt text); this is the deterministic half of the regression, exactly like the
// existing "Fix 2" tests in tests/v4-execution-intelligence.test.ts.
// ===========================================================================

test("[CASE A] explicit voluntary promise with no prior request is active current-scope work", () => {
  const promise = item({
    ref: "wi_1",
    title: "Send the article",
    source_quote: "I'll send you that article tomorrow",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action"
  });
  assert.equal(workItemSchema.safeParse(promise).success, true);
  assert.equal(isExecutionEligible(promise), true);
});

test("[CASE B] a future timeframe inside the sentence does not make it future_scope", () => {
  const promise = item({
    ref: "wi_1",
    title: "Finish security checks then send the link",
    source_quote: "I need about three hours to finish the security checks, then I'll send the team the link",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope", // NOT future_scope, despite "three hours" / future timing
    status: "open",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(promise), true);
});

test("[CASE C] multi-person accepted work preserves every named owner", () => {
  const teamWork = item({
    ref: "wi_1",
    title: "Test the build and send feedback",
    source_quote: "we're going to test the build, and Sam and Priya will send feedback",
    owner: "Speaker",
    owners: ["Speaker", "Sam", "Priya"],
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(teamWork), true);
  assert.deepEqual(teamWork.owners, ["Speaker", "Sam", "Priya"]);
});

test("[CASE D] continuing/finishing work followed by a confirmation step is active current-scope work", () => {
  const continuingWork = item({
    ref: "wi_1",
    title: "Finish the integration changes and confirm the pipeline works",
    source_quote: "I'll finish the integration changes and then confirm the pipeline works",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(continuingWork), true);
});

test("[CASE E] an accepted experiment ('I can definitely try that') is active future action, current scope", () => {
  const experiment = item({
    ref: "wi_1",
    title: "Try the concept with their own tool and observe the result",
    source_quote: "I can definitely try that with my agent and see how it works",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(experiment), true);
});

test("[CASE F] explicit future facilitation ('I will walk them through X') is active work", () => {
  const facilitation = item({
    ref: "wi_1",
    title: "Walk the group through the onboarding concept",
    source_quote: "I will walk the incoming group through the onboarding concept",
    classification: "promise",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "open",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(facilitation), true);
});

test("[N1] speculative backlog phrasing ('maybe ... someday') is future_scope, not active", () => {
  const speculative = item({
    ref: "wi_1",
    title: "Build voice support",
    source_quote: "maybe we should build voice support someday",
    classification: "idea",
    acceptance_state: "proposed",
    execution_scope: "project_work",
    scope_state: "future_scope",
    status: "non_execution",
    work_item_role: "idea"
  });
  assert.equal(isExecutionEligible(speculative), false);
});

test("[N2] 'we can do that in the next version' with no clear commitment is not automatically active", () => {
  const nextVersion = item({
    ref: "wi_1",
    title: "Do that in the next version",
    source_quote: "we can do that in the next version",
    classification: "idea",
    acceptance_state: "none",
    execution_scope: "project_work",
    scope_state: "future_scope",
    status: "non_execution",
    work_item_role: "future_feature"
  });
  assert.equal(isExecutionEligible(nextVersion), false);
});

test("[N3] a request with no acceptance stays request/requested, not active", () => {
  const unaccepted = item({
    ref: "wi_1",
    title: "Deploy this",
    source_quote: "can you deploy this?",
    classification: "request",
    acceptance_state: "requested",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "non_execution",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(unaccepted), false);
});

test("[N4] past-tense completed work is not active", () => {
  const completed = item({
    ref: "wi_1",
    title: "Deploy it",
    source_quote: "we deployed it yesterday",
    classification: "completed_work",
    acceptance_state: "none",
    execution_scope: "project_work",
    scope_state: "current_scope",
    status: "completed",
    work_item_role: "action"
  });
  assert.equal(isExecutionEligible(completed), false);
});

test("[N5] a hypothetical/illustrative example is not real execution work for a real participant", () => {
  const hypothetical = item({
    ref: "wi_1",
    title: "Take photos and add them to the page (illustrative example)",
    source_quote: "let's say a user had to take photos and add them to the page",
    classification: "idea",
    acceptance_state: "none",
    execution_scope: "informational",
    scope_state: "informational",
    status: "non_execution",
    work_item_role: "reference"
  });
  assert.equal(isExecutionEligible(hypothetical), false);
});

// ===========================================================================
// PART 2 -- pipeline-boundary tests against the REAL applyGlobalCorrections() (v4-pipeline.ts),
// not just prompt strings. These would fail if the pipeline regressed to generation 5's observed
// behavior (three eligible representations of one already-completed action).
// ===========================================================================

test("[completeness] a grounded addition (missing explicit promise recovered by global correction) becomes eligible", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "I'll send you that article tomorrow");
  const result = applyGlobalCorrections({
    workItems: [], // topic-scoped extraction missed it entirely
    corrections: [],
    additions: [
      addition({
        title: "Send the article",
        source_quote: "I'll send you that article tomorrow",
        source_segment_ids: [SEG_1]
      })
    ],
    transcript
  });
  assert.equal(result.length, 1);
  assert.equal(isExecutionEligible(result[0]), true);
});

test("[completeness] an ungrounded addition (no valid segment id) is dropped, never invented -- existing guard preserved", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "I'll send you that article tomorrow");
  const result = applyGlobalCorrections({
    workItems: [],
    corrections: [],
    additions: [
      addition({
        title: "Invented work with no real evidence",
        source_quote: "this never actually appears in the transcript",
        source_segment_ids: ["99999999-9999-4999-8999-999999999999"] // not in the transcript
      })
    ],
    transcript
  });
  assert.equal(result.length, 0);
});

test("[completeness] an addition with an empty quote is dropped even if the segment id is valid", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "I'll send you that article tomorrow");
  const result = applyGlobalCorrections({
    workItems: [],
    corrections: [],
    additions: [addition({ title: "No quote", source_quote: "   ", source_segment_ids: [SEG_1] })],
    transcript
  });
  assert.equal(result.length, 0);
});

test("[scope correction] future_scope misclassified acceptance is corrected to current_scope and becomes eligible", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "I'll send you that article tomorrow");
  const misclassified = item({
    ref: "wi_1",
    title: "Send the article",
    source_quote: "I'll send you that article tomorrow",
    scope_state: "future_scope" // topic-scoped extraction got this wrong
  });
  assert.equal(isExecutionEligible(misclassified), false);

  const result = applyGlobalCorrections({
    workItems: [misclassified],
    corrections: [correction({ ref: "wi_1", scope_state: "current_scope" })],
    additions: [],
    transcript
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].scope_state, "current_scope");
  assert.equal(isExecutionEligible(result[0]), true);
});

test("[acceptance correction] a requested-but-unaccepted item is corrected to accepted once later evidence supports it", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "yeah, I'll do that");
  const requested = item({
    ref: "wi_1",
    title: "Do that",
    source_quote: "can you do that?",
    classification: "request",
    acceptance_state: "requested",
    status: "non_execution"
  });
  assert.equal(isExecutionEligible(requested), false);

  const result = applyGlobalCorrections({
    workItems: [requested],
    corrections: [
      correction({
        ref: "wi_1",
        classification: "accepted_request",
        acceptance_state: "accepted",
        status: "open",
        source_quote: "yeah, I'll do that",
        source_segment_ids: [SEG_1]
      })
    ],
    additions: [],
    transcript
  });
  assert.equal(isExecutionEligible(result[0]), true);
});

test("[CASE G / temporal completion] an accepted request whose action is then performed later in the meeting is corrected to completed, not left as open work", () => {
  const transcript = [
    transcriptLine(SEG_1, "Person A", "can you show us the demo?"),
    transcriptLine(SEG_2, "Person B", "yeah, I'll share my screen"),
    transcriptLine(SEG_3, "Person B", "so here on the left you can see the main view..."),
    transcriptLine(SEG_4, "Person B", "...and that's how the whole flow works end to end"),
    transcriptLine(SEG_5, "Person A", "that looks great")
  ].join("\n");

  const acceptedDemo = item({
    ref: "wi_1",
    title: "Share the demo",
    source_quote: "yeah, I'll share my screen",
    source_segment_ids: [SEG_2],
    classification: "accepted_request",
    acceptance_state: "accepted",
    status: "open"
  });
  assert.equal(isExecutionEligible(acceptedDemo), true, "sanity check: before correction this reads as active");

  // Global correction, having seen the rest of the transcript, recognizes the demo was actually
  // walked through (SEG_3/SEG_4) and corrects the item to completed.
  const result = applyGlobalCorrections({
    workItems: [acceptedDemo],
    corrections: [
      correction({
        ref: "wi_1",
        classification: "completed_work",
        status: "completed",
        acceptance_state: "none",
        source_quote: "yeah, I'll share my screen",
        source_segment_ids: [SEG_2, SEG_3, SEG_4],
        reconciliation_reason: "The meeting subsequently walked through the demo (SEG_3-SEG_4)."
      })
    ],
    additions: [],
    transcript
  });

  assert.equal(result[0].status, "completed");
  assert.equal(result[0].classification, "completed_work");
  assert.equal(isExecutionEligible(result[0]), false, "a completed-in-meeting action must never survive as open work");
});

test("[temporal completion, negative] an earlier similar-sounding topic must NOT be used to mark a later promise complete (chronological order matters)", () => {
  // An earlier segment discusses a similar topic informationally; a LATER segment is the actual
  // accepted promise. The earlier discussion must never be mistaken for evidence that the later
  // promise is already done.
  const transcript = [
    transcriptLine(SEG_1, "Person A", "we talked about doing a walkthrough like this before"),
    transcriptLine(SEG_2, "Person B", "I'll actually record a walkthrough video next week")
  ].join("\n");

  const laterPromise = item({
    ref: "wi_1",
    title: "Record a walkthrough video",
    source_quote: "I'll actually record a walkthrough video next week",
    source_segment_ids: [SEG_2],
    classification: "promise",
    acceptance_state: "accepted",
    status: "open",
    scope_state: "current_scope"
  });
  // No correction is issued for this item -- the earlier, unrelated discussion is not treated as
  // completion evidence. It must remain exactly as extracted: active, not completed.
  const result = applyGlobalCorrections({
    workItems: [laterPromise],
    corrections: [],
    additions: [],
    transcript
  });
  assert.equal(result[0].status, "open");
  assert.equal(isExecutionEligible(result[0]), true);
});

test("[CASE H / duplicate reconciliation] request + assignment + accepted_request for the same action are reconciled to at most one active representation", () => {
  const transcript = [
    transcriptLine(SEG_1, "Person A", "can you show us the demo?"),
    transcriptLine(SEG_2, "Person B", "sure, I can do that"),
    transcriptLine(SEG_3, "Person A", "great, go ahead and share your screen then")
  ].join("\n");

  const asRequest = item({
    ref: "wi_1",
    title: "Show the demo (request)",
    source_quote: "can you show us the demo?",
    source_segment_ids: [SEG_1],
    classification: "request",
    acceptance_state: "requested",
    status: "non_execution"
  });
  const asAssignment = item({
    ref: "wi_2",
    title: "Show the demo (assignment)",
    source_quote: "sure, I can do that",
    source_segment_ids: [SEG_2],
    classification: "assignment",
    acceptance_state: "accepted",
    status: "open"
  });
  const asAcceptedRequest = item({
    ref: "wi_3",
    title: "Show the demo (accepted request)",
    source_quote: "great, go ahead and share your screen then",
    source_segment_ids: [SEG_3],
    classification: "accepted_request",
    acceptance_state: "accepted",
    status: "open"
  });

  // Global correction reconciles: wi_1 stays a non-active request record (untouched, no
  // correction needed since it was never eligible); wi_2 is superseded by the canonical wi_3;
  // wi_3 is the canonical active representation.
  const result = applyGlobalCorrections({
    workItems: [asRequest, asAssignment, asAcceptedRequest],
    corrections: [
      correction({
        ref: "wi_2",
        classification: "assignment",
        acceptance_state: "accepted",
        status: "open",
        scope_state: "superseded",
        superseded_item_refs: ["wi_3"],
        superseding_segment_ids: [SEG_3],
        source_quote: "sure, I can do that",
        source_segment_ids: [SEG_2]
      })
    ],
    additions: [],
    transcript
  });

  const byRef = new Map(result.map((r) => [r.ref, r]));
  assert.equal(isExecutionEligible(byRef.get("wi_1")!), false, "the bare request never becomes active");
  assert.equal(isExecutionEligible(byRef.get("wi_2")!), false, "superseded duplicate must not independently pass eligibility");
  assert.equal(isExecutionEligible(byRef.get("wi_3")!), true, "exactly one canonical active representation survives");
  const activeCount = result.filter(isExecutionEligible).length;
  assert.equal(activeCount, 1, "at most one active representation of the same completion event");
});

test("[CASE H continued] if the canonical representation is later completed, ZERO active representations remain -- not one", () => {
  const transcript = [
    transcriptLine(SEG_1, "Person A", "can you show us the demo?"),
    transcriptLine(SEG_2, "Person B", "sure, I can do that"),
    transcriptLine(SEG_3, "Person A", "great, go ahead and share your screen then"),
    transcriptLine(SEG_4, "Person B", "so here's how it works, walking through the whole thing"),
    transcriptLine(SEG_5, "Person A", "awesome, thanks")
  ].join("\n");

  const asAssignment = item({
    ref: "wi_2",
    title: "Show the demo (assignment)",
    source_quote: "sure, I can do that",
    source_segment_ids: [SEG_2],
    classification: "assignment",
    acceptance_state: "accepted",
    status: "open"
  });
  const asAcceptedRequest = item({
    ref: "wi_3",
    title: "Show the demo (accepted request)",
    source_quote: "great, go ahead and share your screen then",
    source_segment_ids: [SEG_3],
    classification: "accepted_request",
    acceptance_state: "accepted",
    status: "open"
  });

  const result = applyGlobalCorrections({
    workItems: [asAssignment, asAcceptedRequest],
    corrections: [
      correction({
        ref: "wi_2",
        scope_state: "superseded",
        superseded_item_refs: ["wi_3"],
        superseding_segment_ids: [SEG_3],
        source_quote: "sure, I can do that",
        source_segment_ids: [SEG_2]
      }),
      correction({
        ref: "wi_3",
        classification: "completed_work",
        status: "completed",
        acceptance_state: "none",
        source_quote: "great, go ahead and share your screen then",
        source_segment_ids: [SEG_3, SEG_4],
        reconciliation_reason: "The demo was actually walked through in SEG_4."
      })
    ],
    additions: [],
    transcript
  });

  const activeCount = result.filter(isExecutionEligible).length;
  assert.equal(activeCount, 0, "once the canonical item completes, no duplicate may remain active");
});

test("[owner preservation] a correction can restore a dropped multi-person owners list without inventing a generic 'Team'", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "we're going to test the build");
  const singleOwnerOnly = item({
    ref: "wi_1",
    title: "Test the build",
    source_quote: "we're going to test the build",
    owner: "Speaker",
    owners: ["Speaker"] // extraction dropped the other two named participants
  });
  const result = applyGlobalCorrections({
    workItems: [singleOwnerOnly],
    corrections: [
      correction({
        ref: "wi_1",
        owner: "Speaker",
        owners: ["Speaker", "Sam", "Priya"],
        source_quote: "we're going to test the build",
        source_segment_ids: [SEG_1]
      })
    ],
    additions: [],
    transcript
  });
  assert.deepEqual(result[0].owners, ["Speaker", "Sam", "Priya"]);
  assert.notEqual(result[0].owner, "Team");
});

test("[grounding regression] a correction's evidence change is rejected when unsupported, preserving the item's original evidence", () => {
  const transcript = transcriptLine(SEG_1, "Speaker", "I'll send you that article tomorrow");
  const original = item({
    ref: "wi_1",
    title: "Send the article",
    source_quote: "I'll send you that article tomorrow",
    source_segment_ids: [SEG_1]
  });
  const result = applyGlobalCorrections({
    workItems: [original],
    corrections: [
      correction({
        ref: "wi_1",
        source_quote: "fabricated quote never said by anyone",
        source_segment_ids: ["99999999-9999-4999-8999-999999999999"] // not in this transcript
      })
    ],
    additions: [],
    transcript
  });
  // Evidence-gating (pre-existing behavior) means the fabricated evidence is rejected and the
  // original, real evidence is preserved even though the correction otherwise applied.
  assert.equal(result[0].source_quote, "I'll send you that article tomorrow");
  assert.deepEqual(result[0].source_segment_ids, [SEG_1]);
});

// ===========================================================================
// PART 3 -- prompt content: proves the semantic instructions actually exist in the live prompts,
// and that the new sections stay generic (no hardcoded benchmark participant/product names).
// ===========================================================================

const FORBIDDEN_BENCHMARK_NAMES = ["Laura", "Craig", "Jay", "Parfait", "Chatter"];

test("[prompt] WORK_ITEM_EXTRACTION_PROMPT states the voluntary-promise principle and that no prior request is required", () => {
  assert.match(WORK_ITEM_EXTRACTION_PROMPT, /VOLUNTARY PROMISE PRINCIPLE/);
  assert.match(WORK_ITEM_EXTRACTION_PROMPT, /regardless of whether anyone else requested it first/);
});

test("[prompt] WORK_ITEM_EXTRACTION_PROMPT defines current_scope vs future_scope explicitly, not by tense", () => {
  assert.match(WORK_ITEM_EXTRACTION_PROMPT, /CURRENT_SCOPE VS FUTURE_SCOPE/);
  assert.match(WORK_ITEM_EXTRACTION_PROMPT, /A future-tense verb is not itself evidence of future_scope/);
});

test("[prompt] WORK_ITEM_EXTRACTION_PROMPT excludes hypothetical/illustrative examples", () => {
  assert.match(WORK_ITEM_EXTRACTION_PROMPT, /hypothetical, illustrative, or example scenario/);
});

test("[prompt] the new WORK_ITEM_EXTRACTION_PROMPT sections are generic -- no hardcoded benchmark names", () => {
  const startIndex = WORK_ITEM_EXTRACTION_PROMPT.indexOf("VOLUNTARY PROMISE PRINCIPLE");
  const endIndex = WORK_ITEM_EXTRACTION_PROMPT.indexOf("Rules:");
  const newSection = WORK_ITEM_EXTRACTION_PROMPT.slice(startIndex, endIndex);
  for (const name of FORBIDDEN_BENCHMARK_NAMES) {
    assert.doesNotMatch(newSection, new RegExp(name), name);
  }
});

test("[prompt] COMPLETENESS_RECOVERY_PROMPT scopes itself to additions only, over one chronological window", () => {
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /completeness-recovery pass for one chronological window/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /COMPLETELY\s*\nABSENT from the existing ledger/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /Do not repair, re-describe, or re-emit/);
});

test("[prompt] COMPLETENESS_RECOVERY_PROMPT distinguishes future execution from future_scope and requires no prior request for self-initiated promises", () => {
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /future execution is not the same as future_scope/);
  assert.match(COMPLETENESS_RECOVERY_PROMPT, /a self-initiated promise never requires an earlier matching request/);
});

test("[prompt] the new COMPLETENESS_RECOVERY_PROMPT is generic -- no hardcoded benchmark names", () => {
  for (const name of FORBIDDEN_BENCHMARK_NAMES) {
    assert.doesNotMatch(COMPLETENESS_RECOVERY_PROMPT, new RegExp(name), name);
  }
});

test("[prompt] LIFECYCLE_RECONCILIATION_PROMPT defines current_scope vs future_scope explicitly", () => {
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /CURRENT_SCOPE VS FUTURE_SCOPE/);
});

test("[prompt] LIFECYCLE_RECONCILIATION_PROMPT requires exhaustive per-ref coverage", () => {
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /EXHAUSTIVE COVERAGE/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /exactly one review for every ref you were given/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /Omitting a ref from your response is never acceptable/);
});

test("[prompt] LIFECYCLE_RECONCILIATION_PROMPT instructs forward-looking temporal completion reasoning, not backward topic-similarity matching", () => {
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /TEMPORAL COMPLETION RULE/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /strictly forward-looking/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /never by topic similarity alone/);
});

test("[prompt] LIFECYCLE_RECONCILIATION_PROMPT instructs reconciling duplicate request/acceptance representations via existing superseded fields", () => {
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /DUPLICATE COMPLETION EVENT RECONCILIATION/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /scope_state=superseded/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /superseded_item_refs/);
});

test("[prompt] LIFECYCLE_RECONCILIATION_PROMPT reminds the model to preserve true negatives (hypotheticals, unaccepted requests, brainstorming, etc.)", () => {
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /TRUE-NEGATIVE REMINDER/);
  assert.match(LIFECYCLE_RECONCILIATION_PROMPT, /hypothetical or illustrative examples\n/);
});

test("[prompt] the new LIFECYCLE_RECONCILIATION_PROMPT sections are generic -- no hardcoded benchmark names", () => {
  for (const name of FORBIDDEN_BENCHMARK_NAMES) {
    assert.doesNotMatch(LIFECYCLE_RECONCILIATION_PROMPT, new RegExp(name), name);
  }
});

test("[scope] isExecutionEligible itself was not modified by this pass -- still gated on exactly these six fields", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../lib/execution-intelligence/execution-tree.ts", import.meta.url),
    "utf8"
  );
  const fnMatch = source.match(/export function isExecutionEligible\(item: WorkItem\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /execution_scope === "project_work"/);
  assert.match(fnMatch![0], /acceptance_state === "accepted"/);
  assert.match(fnMatch![0], /scope_state === "current_scope"/);
  assert.match(fnMatch![0], /ELIGIBLE_STATUSES\.includes\(item\.status\)/);
  assert.match(fnMatch![0], /ELIGIBLE_CLASSIFICATIONS\.includes\(item\.classification\)/);
  assert.match(fnMatch![0], /ELIGIBLE_ROLES\.includes\(item\.work_item_role\)/);
});
