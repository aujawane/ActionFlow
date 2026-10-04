import assert from "node:assert/strict";
import test from "node:test";

import { assembleExecutionTree, isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import type {
  GroupProposal,
  RawWorkItem,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

// ---------------------------------------------------------------------------
// Final-deliverable-recap-as-grouping-anchor (forensic-audit follow-up, generation-3 production
// trace). The audit found that a later explicit recap ("Phase 1: one character, one 30-second
// video...") was correctly extracted as an eligible acceptance-criterion item, and WAS visible to
// grouping, but grouping only ever attached it to an unrelated administrative "write/send the
// project plan document" group -- it never used the recap as an anchor to recognize that four
// scattered, already-eligible implementation items (character generator, script generator,
// human-in-the-loop review, try-again) were all pieces of the SAME Phase-1 outcome the recap
// describes. The fix for this is prompt-only (GROUPING_PROMPT / GROUPING_VERIFICATION_PROMPT in
// work-item-prompts.ts) -- there is no new deterministic code, since assembleExecutionTree already
// correctly turns a verified group's member/acceptance-criteria refs into a commitment, already
// declares group-level ownership independent of any one member's own owner field, and already
// rejects a whole group outright if it references an ineligible (e.g. future-scope) member. These
// tests prove that EXISTING deterministic machinery correctly produces (and protects) the intended
// structure once grouping (under the new prompt) proposes it -- they simulate the model's expected
// output, they do not test prompt wording itself.
// ---------------------------------------------------------------------------

const segment = "11111111-1111-4111-8111-111111111111";
const transcript = `[${segment}] Aditya: I'll deliver it.`;

function rawItem(overrides: Partial<RawWorkItem> & { title: string }): RawWorkItem {
  return {
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    requester: null,
    recipient: null,
    due_date: null,
    due_date_text: null,
    status: "open",
    classification: "open_task",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "Fixture classification.",
    source_quote: `I'll ${overrides.title.toLowerCase()}`,
    source_segment_ids: [segment],
    extraction_reason: "Fixture classification",
    confidence: 0.9,
    ...overrides
  };
}

function workItem(overrides: Partial<WorkItem> & { ref: string; title: string }): WorkItem {
  return { ...rawItem(overrides), topic_id: null, ...overrides };
}

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

function assemble(input: { workItems: WorkItem[]; draftGroups?: GroupProposal[]; verifiedGroups?: VerifiedGroup[] }) {
  return assembleExecutionTree({
    transcript,
    workItems: input.workItems,
    draftGroups: input.draftGroups ?? [],
    verifiedGroups: input.verifiedGroups ?? []
  });
}

// The real audit's five refs, by their real titles.
function scriptGenerator() {
  return workItem({ ref: "wi_g2", title: "Develop script generator to create video scripts based on topic and length" });
}
function humanInLoop() {
  return workItem({ ref: "wi_g3", title: "Implement human-in-the-loop script review and iterative adjustments" });
}
function tryAgain(overrides: Partial<WorkItem> = {}) {
  return workItem({
    ref: "wi_16",
    title: "Accept video redo via 'try again' button rather than editing incorrect videos",
    owner: null,
    owners: [],
    ...overrides
  });
}
function phase1Recap() {
  return workItem({
    ref: "wi_54",
    title: "Define phased deliverables for video generation project with approvals",
    work_item_role: "acceptance_criterion",
    description: "Phase 1: one character, 30-second video; Phase 2: multiple characters; Phase 3: varying durations."
  });
}
function characterGeneratorFutureScope() {
  return workItem({
    ref: "wi_g1",
    title: "Develop character generator to create named characters with characteristics and background",
    scope_state: "future_scope",
    work_item_role: "future_feature"
  });
}

const PHASE1_TITLE = "Build and deliver Phase 1 motorcycle marketing-video prototype";

// ============================================================
// A. explicit recap + scattered matching implementation items -> one shared parent proposed
// ============================================================

test("[A] a recap-anchored group claims script generator, human-in-the-loop, and try-again as one Phase 1 commitment", () => {
  const items = [scriptGenerator(), humanInLoop(), tryAgain(), phase1Recap()];
  const verified = [
    verifiedGroup({
      ref: null,
      title: PHASE1_TITLE,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_g2", "wi_g3", "wi_16"],
      acceptance_criteria_refs: ["wi_54"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "All three are implementation pieces of the Phase 1 outcome the recap describes."
    })
  ];
  const result = assemble({ workItems: items, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 1);
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.title, PHASE1_TITLE);
  assert.deepEqual(new Set(commitment.tasks.map((t) => t.ref)), new Set(["wi_g2", "wi_g3", "wi_16"]));
  assert.deepEqual(commitment.acceptance_criteria.map((c) => c.ref), ["wi_54"]);
  assert.equal(result.tree.standalone_tasks.length, 0);
});

// ============================================================
// B. a member with no local owner -> group still forms correctly with the accountable group owner
// ============================================================

test("[B] 'try again' (owner=null locally) still resolves to the group's declared accountable owner at the commitment level", () => {
  const items = [scriptGenerator(), humanInLoop(), tryAgain(), phase1Recap()];
  assert.equal(tryAgain().owner, null, "sanity check: the member's own local owner is genuinely null");
  const verified = [
    verifiedGroup({
      ref: null,
      title: PHASE1_TITLE,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_g2", "wi_g3", "wi_16"],
      acceptance_criteria_refs: ["wi_54"],
      group_basis: "multi_item_shared_purpose"
    })
  ];
  const result = assemble({ workItems: items, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 1);
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.owner, "Aditya Ujawane");
  assert.equal(commitment.primary_owner_reason, "Declared accountable owner from grouping/verification.");
  const tryAgainTask = commitment.tasks.find((t) => t.ref === "wi_16")!;
  assert.equal(tryAgainTask.owner, null, "the member's own row is never mutated to fabricate an owner it has no local evidence for");
});

// ============================================================
// C. recap + unrelated standalone item -> unrelated item excluded
// ============================================================

test("[C] an unrelated eligible item not supported by the recap stays standalone, not swept into the Phase 1 group", () => {
  const unrelated = workItem({ ref: "wi_99", title: "Draft the founder story for the website" });
  const items = [scriptGenerator(), humanInLoop(), tryAgain(), phase1Recap(), unrelated];
  const verified = [
    verifiedGroup({
      ref: null,
      title: PHASE1_TITLE,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_g2", "wi_g3", "wi_16"],
      acceptance_criteria_refs: ["wi_54"],
      group_basis: "multi_item_shared_purpose"
    })
  ];
  const result = assemble({ workItems: items, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 1);
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref), ["wi_99"]);
});

// ============================================================
// D. no recap / no shared outcome -> no new group created
// ============================================================

test("[D] with no proposed group at all, every eligible item remains standalone (default behavior unchanged)", () => {
  const items = [scriptGenerator(), humanInLoop(), tryAgain()];
  const result = assemble({ workItems: items, verifiedGroups: [] });

  assert.equal(result.tree.commitments.length, 0);
  assert.deepEqual(new Set(result.tree.standalone_tasks.map((t) => t.ref)), new Set(["wi_g2", "wi_g3", "wi_16"]));
});

// ============================================================
// E. existing administrative project-plan grouping behavior is unchanged
// ============================================================

test("[E] the administrative 'write and send the project plan' group still assembles correctly, separate from the Phase 1 implementation group", () => {
  const writeDeliverables = workItem({ ref: "wi_22", title: "Write down phased deliverables in the project plan" });
  const sendPlan = workItem({ ref: "wi_33", title: "Send the completed project plan document to all participants" });
  const items = [scriptGenerator(), humanInLoop(), tryAgain(), phase1Recap(), writeDeliverables, sendPlan];
  const verified = [
    verifiedGroup({
      ref: null,
      title: PHASE1_TITLE,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_g2", "wi_g3", "wi_16"],
      acceptance_criteria_refs: ["wi_54"],
      group_basis: "multi_item_shared_purpose"
    }),
    verifiedGroup({
      ref: null,
      title: "Deliver phased video generation project deliverables and completed project plan document",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_22", "wi_33"],
      group_basis: "multi_item_shared_purpose"
    })
  ];
  const result = assemble({ workItems: items, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 2, "the two outcomes remain two separate commitments, never merged");
  const titles = result.tree.commitments.map((c) => c.title).sort();
  assert.deepEqual(titles, [
    "Build and deliver Phase 1 motorcycle marketing-video prototype",
    "Deliver phased video generation project deliverables and completed project plan document"
  ]);
  const adminCommitment = result.tree.commitments.find((c) => c.title.startsWith("Deliver phased"))!;
  assert.deepEqual(new Set(adminCommitment.tasks.map((t) => t.ref)), new Set(["wi_22", "wi_33"]));
});

// ============================================================
// F. a future-scope character-generator item must never be grouped into the Phase 1 commitment
// ============================================================

test("[F] character generator marked future_scope is never eligible, and a group that wrongly names it as a member is rejected outright", () => {
  const futureCharacterGenerator = characterGeneratorFutureScope();
  assert.equal(isExecutionEligible(futureCharacterGenerator), false, "sanity check: future_scope is never eligible, independent of this fix");

  const items = [scriptGenerator(), humanInLoop(), tryAgain(), phase1Recap(), futureCharacterGenerator];
  // Simulates a hypothetical malformed proposal that wrongly includes the deferred, ineligible
  // character generator as a member alongside the genuinely eligible Phase 1 pieces.
  const verified = [
    verifiedGroup({
      ref: null,
      title: PHASE1_TITLE,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      member_refs: ["wi_g2", "wi_g3", "wi_16", "wi_g1"],
      acceptance_criteria_refs: ["wi_54"],
      group_basis: "multi_item_shared_purpose"
    })
  ];
  const result = assemble({ workItems: items, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 0, "referencing even one ineligible member rejects the whole group outright -- existing safeguard, unweakened by this fix");
  assert.deepEqual(
    new Set(result.tree.standalone_tasks.map((t) => t.ref)),
    new Set(["wi_g2", "wi_g3", "wi_16"]),
    "the genuinely eligible pieces fall back to standalone rather than silently disappearing"
  );
  assert.equal(
    result.workItemDecisions.find((d) => d.work_item_ref === "wi_g1")?.disposition,
    "excluded_ineligible",
    "the future-scope item itself is excluded, never a member or a standalone task"
  );
});
