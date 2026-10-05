import assert from "node:assert/strict";
import test from "node:test";

import { reconcileFinalGraph } from "../lib/execution-intelligence/final-reconciliation";
import type { ExecutionTree, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Acceptance-criteria false-merge fix (forensic-audit follow-up, real production trace).
//
// final-reconciliation.ts's clusterCriteria/criteriaEquivalent uses normalized lexical token
// overlap (intersection / max(token counts) >= CRITERION_MERGE_THRESHOLD) to decide which
// acceptance criteria on the same commitment describe the same requirement. Two real, semantically
// DISTINCT criteria -- "retry/regenerate the generated video" and "review/edit the generated
// script" -- were merged because both happened to contain the extraction model's own recurring
// boilerplate phrasing ("the user should be able to..."). Verified by direct computation against
// two separate real replays: removing "user"/"should"/"able" from the shared-token count alone
// drops both real false-merge instances from just-over-threshold (~0.22-0.25) to well under it
// (~0.05-0.07), without raising CRITERION_MERGE_THRESHOLD and without touching the deterministic,
// no-model-call architecture at all. These tests exercise the real, public, deterministic
// reconcileFinalGraph surface -- never exporting criteriaEquivalent/criterionTokens, per
// instruction -- mirroring the existing convention in tests/final-reconciliation-quality.test.ts.
// ---------------------------------------------------------------------------

const segment = "11111111-1111-4111-8111-111111111111";

function workItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return {
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "decision",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "acceptance_criterion",
    classification_reason: "x",
    source_quote: `I'll ${overrides.title.toLowerCase()}`,
    source_segment_ids: [segment],
    extraction_reason: "x",
    confidence: 0.9,
    topic_id: null,
    ...overrides
  };
}

function criterion(ref: string, title: string, description: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return workItem({ ref, title, description, owner: null, owners: [], ...overrides });
}

function commitment(
  overrides: Partial<ExecutionTree["commitments"][number]> & { ref: string; title: string; tasks: WorkItem[] }
): ExecutionTree["commitments"][number] {
  return {
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    due_date: null,
    due_date_text: null,
    group_basis: "multi_item_shared_purpose",
    member_refs: overrides.tasks.map((t) => t.ref),
    acceptance_criteria_refs: [],
    purpose_reason: "x",
    explicit_outcome_evidence: null,
    acceptance_criteria: [],
    primary_owner_reason: "x",
    ...overrides
  };
}

function reconcile(commitments: ExecutionTree["commitments"]) {
  return reconcileFinalGraph({ tree: { commitments, standalone_tasks: [] } });
}

function mainTask(ref = "t1") {
  return workItem({ ref, title: "Build the video-generation agent workflow", work_item_role: "action" });
}

// ============================================================
// Test 1 -- the exact real production false merge must no longer cluster
// ============================================================

test("[1] retry/regenerate-video criterion no longer false-merges with review/edit-script criterion", () => {
  // Mirrors the real production strings (recomputed directly against the real criteriaEquivalent
  // function during the audit): shared content before this fix was "generated"/"video" plus the
  // boilerplate "user"/"should"/"able" -- enough to just cross the 0.2 threshold (score ~0.25).
  // Stripping the boilerplate drops it to ~0.13, safely under threshold, while the two remaining
  // genuinely-shared domain words ("generated", "video") are not enough on their own to merge
  // these two much larger, otherwise-unrelated criteria.
  const scriptReview = criterion(
    "ac1",
    "Allow the generated script to be reviewed and edited or revised with AI",
    "The user should be able to read the generated script, assess whether it is correct, edit it, or ask the AI to edit it before video generation."
  );
  const retryVideo = criterion(
    "ac2",
    "Use a retry or try-again flow instead of editing the generated video",
    "If the generated video output is wrong, the user should be able to redo the prompt directly, not require manual editing of the video result."
  );
  const tree = commitment({
    ref: "c1",
    title: "Deliver the video-generation workflow",
    tasks: [mainTask()],
    acceptance_criteria: [scriptReview, retryVideo],
    acceptance_criteria_refs: ["ac1", "ac2"]
  });

  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];

  assert.equal(resolved.acceptance_criteria.length, 2, "script review and video retry are distinct requirements and must not be merged");
  const refs = resolved.acceptance_criteria.map((c) => c.ref).sort();
  assert.deepEqual(refs, ["ac1", "ac2"]);
  const decisions = result.acceptanceCriteriaDecisions.filter((d) => d.commitment_ref === "c1");
  assert.ok(decisions.every((d) => d.disposition === "kept"), "both criteria should be kept, not merged");
});

// ============================================================
// Test 2 -- regression guard: genuine near-duplicates still merge correctly
// ============================================================

test("[2] genuine near-duplicate script-review criteria still consolidate into one", () => {
  const a = criterion("ac1", "Script can be reviewed and edited", "The generated script can be reviewed and edited.");
  const b = criterion("ac2", "Allow review and editing of the script", "Allow review and editing of the generated script.");
  const tree = commitment({
    ref: "c1",
    title: "Deliver the video-generation workflow",
    tasks: [mainTask()],
    acceptance_criteria: [a, b],
    acceptance_criteria_refs: ["ac1", "ac2"]
  });

  const result = reconcile([tree]);
  const resolved = result.tree.commitments[0];

  assert.equal(resolved.acceptance_criteria.length, 1, "genuinely equivalent criteria must still consolidate -- the stopword fix must not over-correct into never merging anything");
  const decision = result.acceptanceCriteriaDecisions.find((d) => d.commitment_ref === "c1" && d.disposition === "merged");
  assert.ok(decision, "a merge decision should still be recorded");
  assert.equal(decision!.merged_from_refs.length, 1);
});

// ============================================================
// Test 3 -- tokenization regression: boilerplate stripped, domain words preserved
// ============================================================

test("[3] boilerplate 'user'/'should'/'able' no longer drive a match, but shared domain words still do", () => {
  // Two criteria that share ONLY boilerplate ("the user should be able to...") and otherwise
  // describe completely unrelated requirements -- must not merge now that the boilerplate is
  // stripped from the comparison.
  const unrelatedA = criterion(
    "ac1",
    "Keep execution within four weeks",
    "The user should be able to see the project finish within approximately four weeks."
  );
  const unrelatedB = criterion(
    "ac2",
    "Use a talking-head video format",
    "The user should be able to watch a talking-head character seated on a bike."
  );
  const unrelatedTree = commitment({
    ref: "c1",
    title: "Deliver the video-generation workflow",
    tasks: [mainTask()],
    acceptance_criteria: [unrelatedA, unrelatedB],
    acceptance_criteria_refs: ["ac1", "ac2"]
  });
  const unrelatedResult = reconcile([unrelatedTree]);
  assert.equal(unrelatedResult.tree.commitments[0].acceptance_criteria.length, 2, "sharing only boilerplate phrasing must never be enough to merge");

  // Two criteria sharing a REAL, specific domain word ("video") beyond the stripped boilerplate
  // still correctly merge -- confirms the fix removes false signal without blinding the matcher
  // to genuine shared topical content.
  const domainA = criterion("ac3", "Generate a 30-second video", "The user should be able to generate a 30 second video.");
  const domainB = criterion("ac4", "Produce a 30-second video", "The user should be able to produce a 30 second video.");
  const domainTree = commitment({
    ref: "c2",
    title: "Deliver the video-generation workflow",
    tasks: [mainTask("t2")],
    acceptance_criteria: [domainA, domainB],
    acceptance_criteria_refs: ["ac3", "ac4"]
  });
  const domainResult = reconcile([domainTree]);
  assert.equal(domainResult.tree.commitments[0].acceptance_criteria.length, 1, "shared, specific domain content beyond boilerplate must still merge correctly");
});
