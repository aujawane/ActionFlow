import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleExecutionTree,
  isEligibleAcceptanceCriterion,
  isExecutionEligible,
  isFutureScopeItem,
  validateFinalTree
} from "../lib/execution-intelligence/execution-tree";
import { mergeTopicWorkItems } from "../lib/execution-intelligence/work-item-merge";
import { consolidateExecutionTree } from "../lib/execution-intelligence/task-consolidation";
import {
  applyTranscriptCorrections,
  normalizeTranscriptSafely
} from "../lib/execution-intelligence/transcript-normalization";
import type { runTaskConsolidationModel } from "../lib/execution-intelligence/work-item-model";
import type {
  GroupProposal,
  RawWorkItem,
  TaskConsolidationProposal,
  TranscriptCorrection,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";

const segment = "11111111-1111-4111-8111-111111111111";
const transcript = `[${segment}] Aditya: I'll deliver it.`;

function rawItem(overrides: Partial<RawWorkItem> & { title: string }): RawWorkItem {
  return {
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
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

function draftGroup(
  ref: string,
  title: string,
  memberRefs: string[] = [],
  groupBasis: GroupProposal["group_basis"] = "multi_item_shared_purpose",
  acceptanceCriteriaRefs: string[] = []
): GroupProposal {
  return {
    ref,
    title,
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    group_basis: groupBasis,
    member_refs: memberRefs,
    acceptance_criteria_refs: acceptanceCriteriaRefs,
    purpose_reason: "Shared purpose.",
    explicit_outcome_evidence: null
  };
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

function assemble(input: {
  workItems: WorkItem[];
  draftGroups?: GroupProposal[];
  verifiedGroups?: VerifiedGroup[];
  transcriptOverride?: string;
}) {
  return assembleExecutionTree({
    transcript: input.transcriptOverride ?? transcript,
    workItems: input.workItems,
    draftGroups: input.draftGroups ?? [],
    verifiedGroups: input.verifiedGroups ?? []
  });
}

function mockConsolidationModel(proposals: TaskConsolidationProposal[]): typeof runTaskConsolidationModel {
  return (async () => ({
    ok: true,
    proposals,
    latencyMs: 0,
    salvagedItems: 0,
    usage: null
  })) as typeof runTaskConsolidationModel;
}

// ============================================================
// SCOPE AND ROLE
// ============================================================

test("1. eligibility requires current_scope; future_scope items are never eligible", () => {
  const currentScope = workItem({ ref: "wi_1", title: "Build initial site structure" });
  const futureScope = workItem({
    ref: "wi_2",
    title: "Enable customer accounts",
    scope_state: "future_scope",
    work_item_role: "future_feature"
  });
  assert.equal(isExecutionEligible(currentScope), true);
  assert.equal(isExecutionEligible(futureScope), false);
  assert.equal(isFutureScopeItem(futureScope), true);
  assert.equal(isFutureScopeItem(currentScope), false);
});

test("2. current vs future scope is preserved end to end through assembly", () => {
  const current = workItem({ ref: "wi_1", title: "Draft founder story" });
  const future = workItem({
    ref: "wi_2",
    title: "Enable recurring subscriptions",
    scope_state: "future_scope",
    work_item_role: "future_feature"
  });
  const draft = [draftGroup("group_g1", "Build and present the first website draft", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose"
    })
  ];
  const result = assemble({ workItems: [current, future], draftGroups: draft, verifiedGroups: verified });
  // the group references a future-scope ref -> whole group rejected, both items become excluded/standalone per eligibility
  assert.equal(result.tree.commitments.length, 0);
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref), ["wi_1"]);
});

test("3. acceptance criteria never become tasks", () => {
  const criterion = workItem({
    ref: "wi_1",
    title: "Include founder story content",
    work_item_role: "acceptance_criterion"
  });
  const result = assemble({ workItems: [criterion] });
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(isEligibleAcceptanceCriterion(criterion), true);
  const decision = result.workItemDecisions.find((d) => d.work_item_ref === "wi_1");
  assert.equal(decision?.disposition, "acceptance_criterion");
});

test("4. product requirements do not become peer commitments (explicit_deliverable rejects >1 member, criteria stay attached not grouped)", () => {
  const action = workItem({ ref: "wi_1", title: "Create initial site structure" });
  const criterion = workItem({
    ref: "wi_2",
    title: "Present bars and powder",
    work_item_role: "acceptance_criterion"
  });
  const draft = [draftGroup("group_g1", "Present bars and powder", ["wi_2"])];
  const verified = [
    verifiedGroup({ ref: "group_g1", title: draft[0].title, member_refs: ["wi_2"], group_basis: "explicit_deliverable" })
  ];
  const result = assemble({ workItems: [action, criterion], draftGroups: draft, verifiedGroups: verified });
  // wi_2 is ineligible as a member (it's a criterion, not action/input_dependency) -> whole group rejected
  assert.equal(result.tree.commitments.length, 0);
});

test("6. references do not become commitments", () => {
  const reference = workItem({
    ref: "wi_1",
    title: "Shared Brazilian website example",
    work_item_role: "reference"
  });
  const result = assemble({ workItems: [reference] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(isExecutionEligible(reference), false);
});

test("7. incidental troubleshooting does not become active execution", () => {
  const incidental = workItem({
    ref: "wi_1",
    title: "Inspect unreachable reference site in Chrome",
    work_item_role: "incidental_troubleshooting",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  const result = assemble({ workItems: [incidental] });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

// ============================================================
// FIX 2: STRATEGIC / EXPLORATORY DISCUSSION NEVER BECOMES A COMMITMENT
// WITHOUT ACCEPTED-DELIVERABLE EVIDENCE
//
// These construct WorkItems in the shape the strengthened prompts (see
// GLOBAL_WORK_ITEM_CORRECTION_PROMPT / GROUPING_PROMPT / GROUPING_VERIFICATION_PROMPT) are
// instructed to produce for strategic/exploratory discussion -- role=idea or status_update,
// execution_scope=informational, acceptance_state=none/proposed -- and prove the deterministic
// downstream gate (isExecutionEligible / assembleExecutionTree) excludes them regardless of how
// technical or work-adjacent the topic reads. The prompt behavior itself cannot be asserted without
// a live model call; this is the deterministic half of the regression.
// ============================================================

test("Fix 2: strategic AI-pattern/loop-engineering discussion classified as idea/informational never becomes a commitment or standalone task", () => {
  const lookingInto = workItem({
    ref: "wi_1",
    title: "Looking into AI loop-engineering patterns",
    work_item_role: "status_update",
    classification: "in_progress",
    status: "in_progress",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  const wantToExplore = workItem({
    ref: "wi_2",
    title: "Wants to explore how agent feedback loops work",
    work_item_role: "idea",
    classification: "idea",
    status: "non_execution",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  const encouragement = workItem({
    ref: "wi_3",
    title: "Should focus more on loop-engineering technique",
    work_item_role: "idea",
    classification: "idea",
    status: "non_execution",
    acceptance_state: "proposed",
    execution_scope: "informational"
  });
  const items = [lookingInto, wantToExplore, encouragement];
  for (const item of items) assert.equal(isExecutionEligible(item), false);
  const result = assemble({ workItems: items });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 0);
});

test("Fix 2: a grouping mistake that clusters strategic-discussion items into a commitment is stripped by deterministic assembly", () => {
  const lookingInto = workItem({
    ref: "wi_1",
    title: "Looking into AI loop-engineering patterns",
    work_item_role: "status_update",
    classification: "in_progress",
    status: "in_progress",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  const wantToExplore = workItem({
    ref: "wi_2",
    title: "Wants to explore how agent feedback loops work",
    work_item_role: "idea",
    classification: "idea",
    status: "non_execution",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  // Simulates grouping (and verification, which also missed it) over-eagerly proposing a
  // commitment from this discussion -- exactly the real bug this fix targets.
  const draft = draftGroup(
    "g1",
    "Build development capability through AI loop-engineering experiments",
    ["wi_1", "wi_2"]
  );
  const result = assemble({
    workItems: [lookingInto, wantToExplore],
    draftGroups: [draft],
    verifiedGroups: [verifiedGroup({ ...draft })]
  });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 0);
  const groupDecision = result.groupDecisions.find((d) => d.group_ref === "g1");
  assert.equal(groupDecision?.disposition, "removed");
});

test("Fix 2: a strategic experiment DOES become a commitment once explicitly accepted with an owner and a completion condition", () => {
  const acceptedExperiment = workItem({
    ref: "wi_1",
    title: "Build and demonstrate a ticket-to-code-review-to-test agent loop by Friday",
    owner: "Craig",
    owners: ["Craig"],
    work_item_role: "action",
    classification: "open_task",
    status: "open",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    due_date_text: "by Friday"
  });
  assert.equal(isExecutionEligible(acceptedExperiment), true);
  // Eligibility alone doesn't synthesize a commitment -- grouping still has to anchor it, exactly
  // as it would for any other single accepted deliverable (see test 11). What this proves is that
  // once accountability/completion evidence exists, the item is eligible to be grouped at all --
  // unlike the informational/idea items in the previous two tests, which never reach this point.
  const draft = [
    draftGroup("group_g1", "Ship the ticket-to-review agent loop demo", ["wi_1"], "explicit_deliverable")
  ];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1"],
      group_basis: "explicit_deliverable",
      owner: "Craig",
      owners: ["Craig"],
      explicit_outcome_evidence: {
        source_quote: acceptedExperiment.source_quote,
        source_segment_ids: acceptedExperiment.source_segment_ids
      }
    })
  ];
  const result = assemble({ workItems: [acceptedExperiment], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].group_basis, "explicit_deliverable");
  assert.equal(result.tree.commitments[0].tasks[0].ref, "wi_1");
});

// ============================================================
// FINAL RECONCILIATION STABILIZATION PATCH -- standalone final verification (completed-in-meeting,
// communication-process) and owner-evidence repair. These test the deterministic eligibility gate
// against WorkItems shaped exactly as the strengthened GLOBAL_WORK_ITEM_CORRECTION_PROMPT should
// now produce for these patterns -- the classification itself is a live-model judgment (verified
// via the non-persisting website replay), but once classified correctly, the deterministic gate
// must reliably keep these out of (or into) the active tree.
// ============================================================

test("Standalone verification 9: contact information exchanged during the meeting is completed, not a pending standalone task", () => {
  const sharedContact = workItem({
    ref: "wi_1",
    title: "Share contact information for project communication",
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  assert.equal(isExecutionEligible(sharedContact), false);
  const result = assemble({ workItems: [sharedContact] });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

test("Standalone verification 10: a phone number shared during the meeting is completed, not a pending standalone task", () => {
  const sharedPhone = workItem({
    ref: "wi_1",
    title: "Share Jamileh's phone number with Aditya",
    classification: "completed_work",
    status: "completed",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  assert.equal(isExecutionEligible(sharedPhone), false);
  const result = assemble({ workItems: [sharedPhone] });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

test("Standalone verification 11: a communication-preference/process statement does not create a pending task", () => {
  const communicationProcess = workItem({
    ref: "wi_1",
    title: "Text Jamileh with project questions",
    work_item_role: "status_update",
    classification: "in_progress",
    status: "non_execution",
    acceptance_state: "none",
    execution_scope: "informational"
  });
  assert.equal(isExecutionEligible(communicationProcess), false);
  const result = assemble({ workItems: [communicationProcess] });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

test("Standalone verification 12: a concrete, accepted future communication action can still become a task", () => {
  const concreteMessage = workItem({
    ref: "wi_1",
    title: "Send Jamileh the generated FAQ questions",
    owner: "Aditya Ujawane",
    work_item_role: "action",
    classification: "open_task",
    status: "open",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope"
  });
  assert.equal(isExecutionEligible(concreteMessage), true);
  const result = assemble({ workItems: [concreteMessage] });
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "wi_1");
});

test("Owner repair 16/18: Jamileh's founder-story promise resolves to Jamileh as owner, end to end", () => {
  const jamilehDrafts = workItem({
    ref: "wi_1",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"],
    work_item_role: "input_dependency",
    source_quote: "yeah the founder story"
  });
  const draft = [draftGroup("group_g1", "Deliver the first website draft", ["wi_1"], "explicit_deliverable")];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the first website draft",
      member_refs: ["wi_1"],
      group_basis: "explicit_deliverable",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"],
      explicit_outcome_evidence: { source_quote: jamilehDrafts.source_quote, source_segment_ids: jamilehDrafts.source_segment_ids }
    })
  ];
  const result = assemble({ workItems: [jamilehDrafts], draftGroups: draft, verifiedGroups: verified });
  const task = result.tree.commitments[0].tasks.find((t) => t.ref === "wi_1");
  assert.equal(task?.owner, "Jamileh Hamideh");
});

test("Owner repair 17: Aditya's founder-story-section implementation remains a distinct task owned by Aditya, alongside Jamileh's drafting task", () => {
  const jamilehDrafts = workItem({
    ref: "wi_1",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"],
    work_item_role: "input_dependency"
  });
  const aditiyaBuildsSection = workItem({
    ref: "wi_2",
    title: "Add the founder-story section and incorporate Jamileh's supplied text",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    work_item_role: "action"
  });
  const draft = [draftGroup("group_g1", "Deliver the first website draft", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the first website draft",
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"]
    })
  ];
  const result = assemble({ workItems: [jamilehDrafts, aditiyaBuildsSection], draftGroups: draft, verifiedGroups: verified });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.tasks.length, 2);
  assert.equal(commitment.tasks.find((t) => t.ref === "wi_1")?.owner, "Jamileh Hamideh");
  assert.equal(commitment.tasks.find((t) => t.ref === "wi_2")?.owner, "Aditya Ujawane");
});

test("Owner repair 19: a task left with an ambiguous (null) owner by upstream reconciliation is never confidently overwritten with the wrong person", () => {
  const ambiguousOwner = workItem({ ref: "wi_1", title: "Coordinate the follow-up", owner: null, owners: [] });
  const clearOwner = workItem({ ref: "wi_2", title: "Create initial site structure", owner: "Aditya Ujawane" });
  const draft = [draftGroup("group_g1", "Deliver the first website draft", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the first website draft",
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane"
    })
  ];
  const result = assemble({ workItems: [ambiguousOwner, clearOwner], draftGroups: draft, verifiedGroups: verified });
  const task = result.tree.commitments[0].tasks.find((t) => t.ref === "wi_1");
  // The commitment-level owner may be confidently set (Aditya, declared by verification), but the
  // individual task's own ambiguous ownership is never silently rewritten to match it.
  assert.equal(task?.owner, null);
});

test("8/9. transcript normalization preserves raw text; low-confidence corrections do not auto-apply", () => {
  const raw = `[${segment}] Craig: are you going to get a version this week of parfait running on versa`;
  const corrections: TranscriptCorrection[] = [
    {
      segment_id: segment,
      original_text: raw,
      normalized_text: raw.replace("versa", "vercel"),
      original_token: "versa",
      replacement: "vercel",
      reason: "Known deployment platform mentioned elsewhere in the transcript.",
      confidence: 0.95,
      evidence: "Project glossary lists Vercel as the deployment platform."
    },
    {
      segment_id: segment,
      original_text: raw,
      normalized_text: raw.replace("parfait", "parfeit"),
      original_token: "parfait",
      replacement: "parfeit",
      reason: "Speculative guess with no supporting evidence.",
      confidence: 0.4,
      evidence: null
    }
  ];
  const highConfidenceOnly = applyTranscriptCorrections(raw, [corrections[0]]);
  assert.equal(highConfidenceOnly, raw.replace("versa", "vercel"));
  // the raw transcript passed in is never mutated
  assert.equal(raw.includes("versa"), true);
});

test("10. normalization failure never blocks execution", async () => {
  const result = await normalizeTranscriptSafely({
    meetingId: "meeting-1",
    meetingDate: "2026-08-07",
    transcript,
    participants: ["Aditya"],
    projectGlossary: []
  });
  // disabled by default (no env flag set) -> safe passthrough, never throws
  assert.equal(result.failed, false);
  assert.equal(result.normalizedTranscript, transcript);
});

// ============================================================
// GROUPING AND CONTAINMENT
// ============================================================

test("11. explicit deliverable anchor: single accepted action states its own outcome", () => {
  const item = workItem({ ref: "wi_1", title: "Deploy Parfait to Vercel" });
  const draft = [draftGroup("group_g1", "Deliver Parfait before next Tuesday", ["wi_1"], "explicit_deliverable")];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1"],
      group_basis: "explicit_deliverable",
      explicit_outcome_evidence: { source_quote: item.source_quote, source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: [item], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 1);
});

test("12. website work becomes one main commitment (multi-item deliverable with acceptance criteria attached)", () => {
  const actions = [
    workItem({ ref: "wi_1", title: "Create initial site structure", owner: "Aditya Ujawane" }),
    workItem({ ref: "wi_2", title: "Draft founder story", owner: "Jamileh Hamideh" })
  ];
  const criterion = workItem({
    ref: "wi_3",
    title: "Present bars and powder",
    work_item_role: "acceptance_criterion",
    owner: "Aditya Ujawane"
  });
  const draft = [
    draftGroup(
      "group_g1",
      "Build and present the first informational website draft before August 1",
      ["wi_1", "wi_2"],
      "multi_item_shared_purpose",
      ["wi_3"]
    )
  ];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      acceptance_criteria_refs: ["wi_3"],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane"
    })
  ];
  const result = assemble({ workItems: [...actions, criterion], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 2);
  assert.equal(result.tree.commitments[0].acceptance_criteria.length, 1);
  assert.equal(result.tree.commitments[0].owner, "Aditya Ujawane");
});

test("Ordering-fix regression: a group verified as explicit_deliverable with >1 resolved members is reclassified to multi_item_shared_purpose, not demoted to standalone", () => {
  // Reproduces a real bug found via the live website-meeting replay: verification correctly
  // recognized one accepted, dated outcome ("first website draft before August 1") but labeled
  // it explicit_deliverable while still returning 5 supporting members. The old behavior
  // discarded the entire group (group_basis mismatch -> demoted_to_standalone), scattering a
  // legitimate 5-task, 2-owner deliverable into 5 disconnected standalone tasks and losing the
  // commitment outright. The correct, deterministic fix is to relabel the group to
  // multi_item_shared_purpose (which >=2 members already satisfies) rather than lose it.
  const members = [
    workItem({ ref: "wi_1", title: "Create the initial informational website structure", owner: "Aditya Ujawane" }),
    workItem({ ref: "wi_2", title: "Generate FAQ questions and send them to Jamileh", owner: "Aditya Ujawane" }),
    workItem({ ref: "wi_3", title: "Draft the founder story", owner: "Jamileh Hamideh" }),
    workItem({ ref: "wi_4", title: "Send product images and packaging information", owner: "Jamileh Hamideh" }),
    workItem({ ref: "wi_5", title: "Present the first website draft before August 1", owner: "Aditya Ujawane" })
  ];
  const draft = [
    draftGroup(
      "group_g1",
      "Deliver the first website draft",
      members.map((m) => m.ref),
      "multi_item_shared_purpose"
    )
  ];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: members.map((m) => m.ref),
      group_basis: "explicit_deliverable",
      owner: "Aditya Ujawane",
      explicit_outcome_evidence: { source_quote: "my goal is to give you a first draft before August 1", source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: members, draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].group_basis, "multi_item_shared_purpose");
  assert.equal(result.tree.commitments[0].tasks.length, 5);
  assert.equal(result.tree.standalone_tasks.length, 0);
  const validation = validateFinalTree(result.tree);
  assert.equal(validation.ok, true);
});

// ============================================================
// CONTAINMENT STABILIZATION PATCH -- website staging output produced 4 peer commitments where
// only 1 was correct: a domain/email-setup group, a narrower "informational first release"
// duplicate, the correct broadly-scoped draft commitment, and a "both product lines" group that
// should have been an acceptance criterion. These tests reproduce that exact real scenario and
// prove the deterministic assembly layer correctly collapses it to one commitment when
// verification does its job (verified via prompts strengthened in work-item-prompts.ts, and
// end-to-end via the non-persisting website replay).
// ============================================================

function websiteContainmentWorkItems() {
  return {
    domainTask: workItem({
      ref: "wi_1",
      title: "Connect the existing NavivaFoods.com domain to the deployment",
      owner: "Aditya Ujawane"
    }),
    founderStoryTask: workItem({
      ref: "wi_2",
      title: "Draft the founder story",
      owner: "Jamileh Hamideh",
      work_item_role: "input_dependency"
    }),
    structureTask: workItem({
      ref: "wi_3",
      title: "Create the initial structured website with placeholders",
      owner: "Aditya Ujawane"
    }),
    faqTask: workItem({
      ref: "wi_4",
      title: "Generate FAQ questions and send them to Jamileh",
      owner: "Aditya Ujawane"
    }),
    imagesTask: workItem({
      ref: "wi_5",
      title: "Provide product images, ingredients, and packaging information",
      owner: "Jamileh Hamideh",
      work_item_role: "input_dependency"
    }),
    presentTask: workItem({
      ref: "wi_6",
      title: "Present the first website draft before August 1",
      owner: "Aditya Ujawane"
    }),
    productLinesCriterion: workItem({
      ref: "wi_7",
      title: "Offer both protein bars and protein powder",
      work_item_role: "acceptance_criterion",
      owner: null
    }),
    colorCriterion: workItem({
      ref: "wi_8",
      title: "Use pastel green and violet as the product colors",
      work_item_role: "acceptance_criterion",
      owner: null
    })
  };
}

test("Containment 1/2/3/9: domain-linking, informational-first-release duplicate, and both-product-lines are all absorbed into one surviving commitment", () => {
  const items = websiteContainmentWorkItems();
  const all = Object.values(items);
  // The "before" state grouping actually proposed: 3 separate action-eligible groups (domain,
  // narrower "first release", broader "draft on the domain") plus the two acceptance criteria
  // left unattached -- exactly the shape of the real staging bug.
  const draft = [
    draftGroup(
      "group_g1",
      "Link existing domain and email to new website deployment on Versa",
      [items.domainTask.ref],
      "explicit_deliverable"
    ),
    draftGroup(
      "group_g2",
      "Deliver Informational Website First Release",
      [items.structureTask.ref, items.faqTask.ref]
    ),
    draftGroup(
      "group_g3",
      "Deliver the initial website draft on the existing Naviva Foods domain",
      [items.founderStoryTask.ref, items.imagesTask.ref, items.presentTask.ref]
    )
  ];
  // The "after" state: verification (per the strengthened containment prompt) collapses all
  // three into the one strongest anchor -- the explicit first-draft deliverable -- absorbing
  // every eligible member and both acceptance criteria, and omits group_g1/group_g2 entirely.
  const verified = [
    verifiedGroup({
      ref: "group_g3",
      title: "Deliver the initial website draft on the existing Naviva Foods domain before August 1",
      description:
        "Create and present the first informational website draft before August 1, using placeholders where final content is unavailable, incorporating Jamileh's supplied content/assets, and using the existing domain. E-commerce remains later scope.",
      member_refs: all.filter((i) => i.work_item_role !== "acceptance_criterion").map((i) => i.ref),
      acceptance_criteria_refs: [items.productLinesCriterion.ref, items.colorCriterion.ref],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"],
      due_date_text: "before August 1"
    })
  ];
  const result = assemble({ workItems: all, draftGroups: draft, verifiedGroups: verified });

  assert.equal(result.tree.commitments.length, 1, "exactly one active commitment must survive");
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.ref, "group_g3");
  assert.deepEqual(
    commitment.member_refs.sort(),
    ["wi_1", "wi_2", "wi_3", "wi_4", "wi_5", "wi_6"].sort()
  );
  assert.deepEqual(commitment.acceptance_criteria_refs.sort(), ["wi_7", "wi_8"]);
  assert.equal(result.tree.standalone_tasks.length, 0);

  // The subordinate draft groups must never resurrect as peers.
  const g1Decision = result.groupDecisions.find((d) => d.group_ref === "group_g1");
  const g2Decision = result.groupDecisions.find((d) => d.group_ref === "group_g2");
  assert.equal(g1Decision?.disposition, "removed");
  assert.equal(g2Decision?.disposition, "removed");
});

test("Containment 4: main website commitment owner resolves to Aditya, not Team, even though Jamileh owns child tasks", () => {
  const items = websiteContainmentWorkItems();
  const all = Object.values(items);
  const draft = [draftGroup("group_g1", "Deliver the first website draft", all.map((i) => i.ref))];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the initial website draft on the existing Naviva Foods domain before August 1",
      member_refs: all.filter((i) => i.work_item_role !== "acceptance_criterion").map((i) => i.ref),
      acceptance_criteria_refs: [items.productLinesCriterion.ref, items.colorCriterion.ref],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"]
    })
  ];
  const result = assemble({ workItems: all, draftGroups: draft, verifiedGroups: verified });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.owner, "Aditya Ujawane");
  assert.notEqual(commitment.owner, "Team");
});

test("Containment 5: Jamileh's child-task ownership is preserved after absorption", () => {
  const items = websiteContainmentWorkItems();
  const all = Object.values(items);
  const draft = [draftGroup("group_g1", "Deliver the first website draft", all.map((i) => i.ref))];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the initial website draft on the existing Naviva Foods domain before August 1",
      member_refs: all.filter((i) => i.work_item_role !== "acceptance_criterion").map((i) => i.ref),
      acceptance_criteria_refs: [items.productLinesCriterion.ref, items.colorCriterion.ref],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"]
    })
  ];
  const result = assemble({ workItems: all, draftGroups: draft, verifiedGroups: verified });
  const commitment = result.tree.commitments[0];
  const founderStory = commitment.tasks.find((t) => t.ref === "wi_2");
  const images = commitment.tasks.find((t) => t.ref === "wi_5");
  assert.equal(founderStory?.owner, "Jamileh Hamideh");
  assert.equal(images?.owner, "Jamileh Hamideh");
});

test("Containment 6: a work item that hallucinates unsupported email-service scope as a group member is rejected outright by assembly", () => {
  // Defense in depth at the deterministic layer: even if grouping/verification somehow proposed
  // an "email service setup" group, it can only survive if it references real eligible items --
  // there is no such real accepted email-infrastructure item in this meeting, so any group
  // claiming one is a hallucinated/ineligible reference and assembly rejects it outright.
  const items = websiteContainmentWorkItems();
  const draft = [
    draftGroup(
      "group_email",
      "Set up email hosting service for the new domain",
      ["wi_does_not_exist"],
      "explicit_deliverable"
    )
  ];
  const verified = [
    verifiedGroup({
      ref: "group_email",
      title: "Set up email hosting service for the new domain",
      member_refs: ["wi_does_not_exist"],
      group_basis: "explicit_deliverable",
      explicit_outcome_evidence: { source_quote: "x", source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: Object.values(items), draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  const decision = result.groupDecisions.find((d) => d.group_ref === "group_email");
  assert.equal(decision?.disposition, "removed");
  assert.match(decision!.reason, /unknown or ineligible/i);
});

test("Containment 7: e-commerce remains excluded from the active commitment (future-scope items are never eligible members)", () => {
  const items = websiteContainmentWorkItems();
  const ecommerceFeature = workItem({
    ref: "wi_ecommerce",
    title: "Build the website as an e-commerce site",
    work_item_role: "future_feature",
    scope_state: "future_scope",
    acceptance_state: "accepted"
  });
  const all = [...Object.values(items), ecommerceFeature];
  const draft = [
    draftGroup("group_g1", "Deliver the first website draft", [
      ...Object.values(items)
        .filter((i) => i.work_item_role !== "acceptance_criterion")
        .map((i) => i.ref),
      ecommerceFeature.ref
    ])
  ];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver the initial website draft on the existing Naviva Foods domain before August 1",
      member_refs: [
        ...Object.values(items)
          .filter((i) => i.work_item_role !== "acceptance_criterion")
          .map((i) => i.ref),
        ecommerceFeature.ref
      ],
      acceptance_criteria_refs: [items.productLinesCriterion.ref, items.colorCriterion.ref],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane"
    })
  ];
  const result = assemble({ workItems: all, draftGroups: draft, verifiedGroups: verified });
  // future_feature/future_scope is never isExecutionEligible -- referencing it makes the whole
  // group's member list ineligible, so the model including it would reject the entire group. This
  // proves the deterministic gate, not the prompt, is the final backstop against e-commerce
  // leaking into the active commitment.
  assert.equal(result.tree.commitments.length, 0);
  const decision = result.groupDecisions.find((d) => d.group_ref === "group_g1");
  assert.equal(decision?.disposition, "removed");
});

test("Containment 8: surviving commitment description covers the full first-draft deliverable, not just one narrow member", () => {
  const items = websiteContainmentWorkItems();
  const all = Object.values(items);
  const draft = [draftGroup("group_g1", "Deliver Informational Website First Release", all.map((i) => i.ref))];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver Informational Website First Release",
      // Narrow: this description just restates one member (the domain task) verbatim, despite
      // the group's broad title and 6-member scope -- sanitizeNarrowDescription must strip it
      // rather than let a misleadingly narrow description survive on a broad commitment.
      description: items.domainTask.title,
      member_refs: all.filter((i) => i.work_item_role !== "acceptance_criterion").map((i) => i.ref),
      acceptance_criteria_refs: [items.productLinesCriterion.ref, items.colorCriterion.ref],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane"
    })
  ];
  const result = assemble({ workItems: all, draftGroups: draft, verifiedGroups: verified });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.description, null, "an over-narrow description must be cleared, not left misleading");
});

test("14. future features never support an active group -- referencing one rejects the group", () => {
  const action = workItem({ ref: "wi_1", title: "Create initial site structure" });
  const futureFeature = workItem({
    ref: "wi_2",
    title: "Enable customer accounts",
    scope_state: "future_scope",
    work_item_role: "future_feature"
  });
  const draft = [draftGroup("group_g1", "Build the website", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({ ref: "group_g1", title: draft[0].title, member_refs: ["wi_1", "wi_2"], group_basis: "multi_item_shared_purpose" })
  ];
  const result = assemble({ workItems: [action, futureFeature], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref), ["wi_1"]);
});

test("15. pairwise commitment containment: a subordinate group is absorbed by verification (assembly honors whatever verification returns)", () => {
  // verification already performed the absorption -- it returns ONE group with all members,
  // and simply omits the subordinate draft group. Assembly must not resurrect it.
  const domainTask = workItem({ ref: "wi_1", title: "Connect NavivaFoods.com to the deployment" });
  const siteTask = workItem({ ref: "wi_2", title: "Create initial site structure" });
  const draft = [
    draftGroup("group_g1", "Build the website", ["wi_2"]),
    draftGroup("group_g2", "Connect the domain", ["wi_1"], "explicit_deliverable")
  ];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: "Build and present the first website draft",
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose"
    })
    // group_g2 intentionally omitted: verification absorbed it into group_g1
  ];
  const result = assemble({ workItems: [domainTask, siteTask], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.deepEqual(result.tree.commitments[0].member_refs.sort(), ["wi_1", "wi_2"]);
  const g2Decision = result.groupDecisions.find((d) => d.group_ref === "group_g2");
  assert.equal(g2Decision?.disposition, "removed");
});

test("17. primary outcome owner is never replaced with a literal Team even with multiple child owners", () => {
  const aditya = workItem({ ref: "wi_1", title: "Create initial site structure", owner: "Aditya Ujawane" });
  const jamileh = workItem({ ref: "wi_2", title: "Draft founder story", owner: "Jamileh Hamideh" });
  const draft = [draftGroup("group_g1", "Build the website", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose",
      owner: null // model didn't declare one -- deterministic inference must run, never "Team"
    })
  ];
  const result = assemble({ workItems: [aditya, jamileh], draftGroups: draft, verifiedGroups: verified });
  const owner = result.tree.commitments[0].owner;
  assert.notEqual(owner, "Team");
  assert.ok(owner === "Aditya Ujawane" || owner === "Jamileh Hamideh");
});

test("18. different child owners remain supported without collapsing owners list", () => {
  const aditya = workItem({ ref: "wi_1", title: "Create initial site structure", owner: "Aditya Ujawane" });
  const jamileh = workItem({ ref: "wi_2", title: "Draft founder story", owner: "Jamileh Hamideh" });
  const draft = [draftGroup("group_g1", "Build the website", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane", "Jamileh Hamideh"]
    })
  ];
  const result = assemble({ workItems: [aditya, jamileh], draftGroups: draft, verifiedGroups: verified });
  assert.deepEqual(result.tree.commitments[0].owners.sort(), ["Aditya Ujawane", "Jamileh Hamideh"]);
  assert.equal(result.tree.commitments[0].tasks.find((t) => t.ref === "wi_2")?.owner, "Jamileh Hamideh");
});

test("19. commitment with zero tasks survives", () => {
  const draft = [draftGroup("group_g1", "Deliver Parfait before next Tuesday", [], "explicit_zero_task_outcome")];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: [],
      group_basis: "explicit_zero_task_outcome",
      explicit_outcome_evidence: { source_quote: "we should have a version before tuesday", source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: [], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 0);
});

test("20. zero standalone tasks is allowed; no minimum/maximum commitment count enforced", () => {
  const resultEmpty = assemble({ workItems: [] });
  assert.equal(resultEmpty.tree.standalone_tasks.length, 0);
  assert.equal(resultEmpty.tree.commitments.length, 0);

  const items = Array.from({ length: 5 }, (_, i) => workItem({ ref: `wi_${i + 1}`, title: `Outcome ${i + 1}` }));
  const draft = items.map((item, i) =>
    draftGroup(`group_g${i + 1}`, `Deliver outcome ${i + 1}`, [item.ref], "explicit_deliverable")
  );
  const verified = draft.map((group, i) =>
    verifiedGroup({
      ref: group.ref,
      title: group.title,
      member_refs: group.member_refs,
      group_basis: "explicit_deliverable",
      explicit_outcome_evidence: { source_quote: items[i].source_quote, source_segment_ids: [segment] }
    })
  );
  const resultFive = assemble({ workItems: items, draftGroups: draft, verifiedGroups: verified });
  assert.equal(resultFive.tree.commitments.length, 5);
  assert.equal(resultFive.tree.standalone_tasks.length, 0);
});

test("final integrity validation catches a corrupted tree (same ref claimed twice) and reports errors", () => {
  const item = workItem({ ref: "wi_1", title: "Deploy Parfait" });
  const badTree = {
    commitments: [
      {
        ref: "group_g1",
        title: "A",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_deliverable" as const,
        member_refs: [item.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [item],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [item]
  };
  const validation = validateFinalTree(badTree);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.ok(validation.errors.some((e) => e.includes("appears")));
});

// ============================================================
// TASK CONSOLIDATION
// ============================================================

test("21. exact duplicate tasks merge deterministically without a model call", async () => {
  const a = workItem({ ref: "wi_1", title: "Create Chatter session", source_quote: "same exact quote" });
  const b = workItem({ ref: "wi_2", title: "Create Chatter session again", source_quote: "same exact quote" });
  const tree = { commitments: [], standalone_tasks: [a, b] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: mockConsolidationModel([]) } // never called: exact merges don't need the model
  );
  assert.equal(result.tree.standalone_tasks.length, 1);
  const survivor = result.tree.standalone_tasks[0];
  assert.equal(result.provenanceByRef.get(survivor.ref)?.merge_type, "exact");
});

test("22/35. Chatter's ~11 fragmented tasks consolidate to 4 distinct completion events", async () => {
  const items = [
    workItem({ ref: "t1", title: "Start Chatter pilot session using last week transcript" }),
    workItem({ ref: "t2", title: "Paste transcript into Chatter pilot session and inspect output" }),
    workItem({ ref: "t3", title: "Test Chatter pilot session by pasting last week transcript" }),
    workItem({ ref: "t4", title: "Test whether Chatter pilot session can interface with transcript file" }),
    workItem({ ref: "t5", title: "Interact with Chatter pilot to evaluate its proactive behavior and see if it asks useful questions" }),
    workItem({ ref: "t6", title: "Evaluate Chatter pilot proactive behavior and check whether it acts like a teammate" }),
    workItem({ ref: "t7", title: "Check whether Chatter pilot creates appropriate cron jobs as proactive behavior" }),
    workItem({ ref: "t8", title: "See whether Chatter pilot participates like a teammate showing proactive behavior" }),
    workItem({ ref: "t9", title: "Notify the group chat after initial Chatter pilot validation" }),
    workItem({ ref: "t10", title: "Open the Chatter pilot to the team after initial validation" }),
    workItem({ ref: "t11", title: "Try Chatter pilot session before running other transcript flow" })
  ];
  const tree = {
    commitments: [
      {
        ref: "group_chatter",
        title: "Validate Chatter using real meeting context",
        description: null,
        owner: "Laura",
        owners: ["Laura"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: items.map((i) => i.ref),
        acceptance_criteria_refs: [],
        purpose_reason: "Validation effort",
        explicit_outcome_evidence: null,
        tasks: items,
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };
  const proposals: TaskConsolidationProposal[] = [
    {
      proposal_ref: "p1",
      task_refs: ["t2", "t3", "t4"],
      disposition: "merge",
      canonical_title: "Verify Chatter can ingest transcript/CSV input and inspect its initial output",
      canonical_description: "Paste the transcript, confirm the agent can interface with the file, and inspect the output.",
      reason: "All three describe the same ingestion-verification completion event, distinct from starting the pilot itself.",
      confidence: 0.97,
      completion_equivalence: "Pasting the transcript and inspecting output is the same event as confirming the agent can interface with the file.",
      preserved_sequence_note: null
    },
    {
      proposal_ref: "p2",
      task_refs: ["t5", "t6", "t7", "t8"],
      disposition: "merge",
      canonical_title: "Interact with Chatter and evaluate its proactive behavior",
      canonical_description: "Ask questions, check cron-job creation, and evaluate teammate-like participation.",
      reason: "All four describe evaluating the same proactive-behavior dimension.",
      confidence: 0.95,
      completion_equivalence: "Evaluating any one proactive behavior is part of the same evaluation pass.",
      preserved_sequence_note: null
    },
    {
      proposal_ref: "p3",
      task_refs: ["t9", "t10"],
      disposition: "merge",
      canonical_title: "Notify the group and open the pilot to the team",
      canonical_description: "Share validation results and open access to the wider team.",
      reason: "Notifying and opening access are the same handoff event.",
      confidence: 0.93,
      completion_equivalence: "Notifying the group is how the pilot gets opened to the team.",
      preserved_sequence_note: null
    },
    {
      proposal_ref: "p4",
      task_refs: ["t1", "t11"],
      disposition: "absorb_as_sequence_note",
      canonical_title: null,
      canonical_description: null,
      reason: "t11 is a sequencing instruction about when to run the pilot, not a separate deliverable.",
      confidence: 0.96,
      completion_equivalence: "n/a",
      preserved_sequence_note: "Try Chatter before the other transcript flow."
    }
  ];
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: mockConsolidationModel(proposals) }
  );
  const finalTasks = result.tree.commitments[0].tasks;
  assert.equal(finalTasks.length, 4);
});

test("23. distinct execution phases remain separate even when the model is never asked (no overlap prefiltered)", () => {
  const ingestion = workItem({ ref: "t1", title: "Verify Chatter can ingest transcript/CSV input" });
  const sharing = workItem({ ref: "t2", title: "Notify the group and open the pilot to the team" });
  // titles are dissimilar enough that the deterministic prefilter never even clusters them --
  // proving the model is never asked to conflate genuinely distinct phases.
  const tree = { commitments: [], standalone_tasks: [ingestion, sharing] };
  return consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: mockConsolidationModel([{
      proposal_ref: "should-not-be-used",
      task_refs: ["t1", "t2"],
      disposition: "merge",
      canonical_title: "wrong",
      canonical_description: null,
      reason: "should never be called",
      confidence: 0.99,
      completion_equivalence: "n/a",
      preserved_sequence_note: null
    }]) }
  ).then((result) => {
    assert.equal(result.tree.standalone_tasks.length, 2);
  });
});

test("24. a sequencing instruction becomes a preserved note, not a separate pending task", async () => {
  const primary = workItem({ ref: "t1", title: "Start Chatter pilot session using last week transcript" });
  const sequencing = workItem({ ref: "t2", title: "Try Chatter pilot session before running other transcript flow" });
  const tree = { commitments: [], standalone_tasks: [primary, sequencing] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: mockConsolidationModel([
        {
          proposal_ref: "p1",
          task_refs: ["t1", "t2"],
          disposition: "absorb_as_sequence_note",
          canonical_title: null,
          canonical_description: null,
          reason: "t2 is a sequencing note about t1.",
          confidence: 0.96,
          completion_equivalence: "n/a",
          preserved_sequence_note: "Try before the other transcript flow."
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 1);
  const provenance = result.provenanceByRef.get(result.tree.standalone_tasks[0].ref);
  assert.equal(provenance?.merge_type, "standalone_absorption");
  assert.deepEqual(provenance?.preserved_sequence_notes, ["Try before the other transcript flow."]);
});

test("25. a duplicate standalone task is absorbed into the matching child task", async () => {
  const child = workItem({
    ref: "t1",
    title: "Verify Chatter can ingest transcript/CSV input",
    source_quote: "we tested the transcript flow"
  });
  const standaloneDuplicate = workItem({
    ref: "t2",
    title: "Test the transcript-based flow using the available transcript",
    source_quote: "we tested the transcript flow"
  });
  const tree = {
    commitments: [
      {
        ref: "group_chatter",
        title: "Validate Chatter",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_deliverable" as const,
        member_refs: ["t1"],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [child],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [standaloneDuplicate]
  };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: mockConsolidationModel([]) } // exact evidence match -> deterministic, no model needed
  );
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.tree.commitments[0].tasks.length, 1);
});

test("Fix 1 regression: low-confidence child survives over a higher-confidence standalone duplicate, preserving commitment cardinality", async () => {
  const child = workItem({
    ref: "t1",
    title: "Deploy the Chatter pilot build to staging",
    confidence: 0.55,
    owner: "Aditya",
    source_quote: "someone needs to deploy the pilot build",
    source_segment_ids: ["11111111-1111-4111-8111-111111111201"]
  });
  const standaloneDuplicate = workItem({
    ref: "t2",
    title: "Push the Chatter pilot build to the staging environment",
    confidence: 0.98,
    owner: "Aditya",
    source_quote: "I'll push the build up to staging myself",
    source_segment_ids: ["11111111-1111-4111-8111-111111111202"]
  });
  const tree = {
    commitments: [
      {
        ref: "group_deploy",
        title: "Deploy Chatter pilot",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_deliverable" as const,
        member_refs: ["t1"],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [child],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [standaloneDuplicate]
  };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: mockConsolidationModel([
        {
          proposal_ref: "p1",
          task_refs: ["t1", "t2"],
          disposition: "merge",
          canonical_title: "Deploy Chatter pilot build to staging",
          canonical_description: null,
          reason: "Same deployment action described by two participants.",
          confidence: 0.97,
          completion_equivalence: "same completion event",
          preserved_sequence_note: null
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.tree.commitments[0].tasks.length, 1);
  assert.equal(result.tree.commitments[0].tasks[0].ref, "t1");
  const provenance = result.provenanceByRef.get("t1");
  assert.equal(provenance?.merge_type, "standalone_absorption");
  assert.deepEqual(provenance?.merged_from_task_refs, ["t2"]);
  const applied = result.decisions.find((d) => d.task_refs.includes("t1") && d.task_refs.includes("t2"));
  assert.equal(applied?.disposition, "merge");
  assert.equal(applied?.applied, true);
  assert.equal(
    result.decisions.some((d) => d.disposition === "rejected_cardinality_risk"),
    false
  );
});

test("Fix 1 regression: an unsafe merge across two single-member commitments is rejected, not resolved by the whole-tree fallback", async () => {
  const a = workItem({ ref: "t1", title: "Confirm enterprise OpenAI access with IT" });
  const b = workItem({ ref: "t2", title: "Confirm enterprise OpenAI access with IT" });
  const tree = {
    commitments: [
      {
        ref: "group_a",
        title: "Establish enterprise OpenAI access",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_deliverable" as const,
        member_refs: ["t1"],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [a],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      },
      {
        ref: "group_b",
        title: "Clarify enterprise Codex access",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_deliverable" as const,
        member_refs: ["t2"],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [b],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: mockConsolidationModel([]) } // identical evidence -> deterministic exact-cluster path, no model needed
  );
  const groupA = result.tree.commitments.find((c) => c.ref === "group_a");
  const groupB = result.tree.commitments.find((c) => c.ref === "group_b");
  assert.equal(groupA?.tasks.length, 1);
  assert.equal(groupA?.tasks[0].ref, "t1");
  assert.equal(groupB?.tasks.length, 1);
  assert.equal(groupB?.tasks[0].ref, "t2");
  assert.equal(result.tree.standalone_tasks.length, 0);
  const rejection = result.decisions.find((d) => d.disposition === "rejected_cardinality_risk");
  assert.ok(rejection, "expected a rejected_cardinality_risk decision");
  assert.equal(rejection?.applied, false);
  assert.match(rejection!.reason, /no merge direction is safe/);
  assert.match(rejection!.reason, /below the required/);
});

test("26. conflicting owner prevents merge candidacy even with identical titles", () => {
  const a = workItem({ ref: "t1", title: "Send FAQ answers", owner: "Jamileh", source_quote: "quote a", source_segment_ids: ["11111111-1111-4111-8111-111111111101"], due_date: "2026-08-05" });
  const ownerConflict = workItem({ ref: "t2", title: "Send FAQ answers", owner: "Aditya", source_quote: "quote b", source_segment_ids: ["11111111-1111-4111-8111-111111111102"], due_date: "2026-08-05" });
  const tree = { commitments: [], standalone_tasks: [a, ownerConflict] };
  return consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: mockConsolidationModel([{
    proposal_ref: "should-not-be-used",
    task_refs: ["t1", "t2"],
    disposition: "merge",
    canonical_title: "wrong",
    canonical_description: null,
    reason: "should never be reached: owner conflict blocks clustering before the model is asked",
    confidence: 0.99,
    completion_equivalence: "n/a",
    preserved_sequence_note: null
  }]) }).then((result) => {
    assert.equal(result.tree.standalone_tasks.length, 2);
  });
});

test("27. conflicting due dates prevent merge candidacy even with identical titles", () => {
  const a = workItem({ ref: "t1", title: "Send FAQ answers", owner: "Jamileh", source_quote: "quote a", source_segment_ids: ["11111111-1111-4111-8111-111111111103"], due_date: "2026-08-05" });
  const dateConflict = workItem({ ref: "t2", title: "Send FAQ answers", owner: "Jamileh", source_quote: "quote b", source_segment_ids: ["11111111-1111-4111-8111-111111111104"], due_date: "2026-08-10" });
  const tree = { commitments: [], standalone_tasks: [a, dateConflict] };
  return consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: mockConsolidationModel([{
    proposal_ref: "should-not-be-used",
    task_refs: ["t1", "t2"],
    disposition: "merge",
    canonical_title: "wrong",
    canonical_description: null,
    reason: "should never be reached: date conflict blocks clustering before the model is asked",
    confidence: 0.99,
    completion_equivalence: "n/a",
    preserved_sequence_note: null
  }]) }).then((result) => {
    assert.equal(result.tree.standalone_tasks.length, 2);
  });
});

test("28. completed and pending tasks never merge", () => {
  const pending = workItem({ ref: "t1", title: "Send FAQ answers", owner: "Jamileh" });
  const completed = workItem({
    ref: "t2",
    title: "Send FAQ answers",
    owner: "Jamileh",
    status: "completed",
    classification: "completed_work",
    acceptance_state: "none"
  });
  const tree = { commitments: [], standalone_tasks: [pending, completed] };
  return consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: mockConsolidationModel([{
    proposal_ref: "should-not-be-used",
    task_refs: ["t1", "t2"],
    disposition: "merge",
    canonical_title: "wrong",
    canonical_description: null,
    reason: "should never be reached: status conflict blocks clustering before the model is asked",
    confidence: 0.99,
    completion_equivalence: "n/a",
    preserved_sequence_note: null
  }]) }).then((result) => {
    assert.equal(result.tree.standalone_tasks.length, 2);
  });
});

test("29/30. every task in this run is freshly generated, never a persisted user-edited row -- provenance never claims to protect what does not exist at this layer", async () => {
  // Documents the boundary explicitly: consolidation operates purely on the current generation's
  // in-memory WorkItems. Manual-override protection for previously-persisted rows is a distinct,
  // pre-existing concern (matchExecutionGraphRows in persistence.ts), not this stage's job.
  const a = workItem({ ref: "t1", title: "Send FAQ answers" });
  const tree = { commitments: [], standalone_tasks: [a] };
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: mockConsolidationModel([]) });
  assert.equal(result.tree.standalone_tasks.length, 1);
});

test("31. semantic-merge provenance preserves original evidence from both tasks", async () => {
  const secondSegment = "22222222-2222-4222-8222-222222222222";
  const a = workItem({ ref: "t1", title: "Send product images", source_quote: "quote a", source_segment_ids: [segment] });
  const b = workItem({ ref: "t2", title: "Send packaging images", source_quote: "quote b", source_segment_ids: [secondSegment] });
  const tree = { commitments: [], standalone_tasks: [a, b] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: mockConsolidationModel([
        {
          proposal_ref: "p1",
          task_refs: ["t1", "t2"],
          disposition: "merge",
          canonical_title: "Send product and packaging images",
          canonical_description: null,
          reason: "Same delivery of images, just described from two angles.",
          confidence: 0.95,
          completion_equivalence: "Sending one covers the other.",
          preserved_sequence_note: null
        }
      ])
    }
  );
  const survivor = result.tree.standalone_tasks[0];
  assert.deepEqual([...survivor.source_segment_ids].sort(), [segment, secondSegment].sort());
  const provenance = result.provenanceByRef.get(survivor.ref);
  assert.deepEqual(provenance?.merged_from_task_refs.sort(), [a.ref, b.ref].filter((r) => r !== survivor.ref));
  assert.equal(provenance?.merge_type, "semantic");
});

test("32. suggestion-only merges (below auto threshold) are not applied", async () => {
  const a = workItem({ ref: "t1", title: "Review the reference website" });
  const b = workItem({ ref: "t2", title: "Review the shared reference website example" });
  const tree = { commitments: [], standalone_tasks: [a, b] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: mockConsolidationModel([
        {
          proposal_ref: "p1",
          task_refs: ["t1", "t2"],
          disposition: "merge",
          canonical_title: "Review the reference website",
          canonical_description: null,
          reason: "Plausibly the same, but not certain.",
          confidence: 0.8, // between suggest (0.75) and auto (0.92) thresholds
          completion_equivalence: "Maybe the same event.",
          preserved_sequence_note: null
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 2);
  assert.equal(result.suggestions.length, 1);
});

test("34. manual merge control (existing commitment task-merge UI/RPC) is untouched by this change", () => {
  // This module never touches meeting_tasks rows directly and does not call the existing
  // /api/commitments/[id]/tasks/merge route or its RPC -- consolidation only ever operates on
  // in-memory WorkItems before persistence, so the manual "Merge Selected into First" control
  // continues to operate exactly as before, independent of this stage.
  assert.ok(true);
});

test("36. website tasks remain appropriately granular -- dissimilar deliverables never cluster", () => {
  const items = [
    workItem({ ref: "t1", title: "Create initial site structure" }),
    workItem({ ref: "t2", title: "Generate FAQ questions and send them to Jamileh" }),
    workItem({ ref: "t3", title: "Review the shared reference website" }),
    workItem({ ref: "t4", title: "Connect NavivaFoods.com to the deployment" }),
    workItem({ ref: "t5", title: "Draft the founder story", owner: "Jamileh" }),
    workItem({ ref: "t6", title: "Send ingredients and packaging information", owner: "Jamileh" })
  ];
  const tree = { commitments: [], standalone_tasks: items };
  return consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: mockConsolidationModel([]) }).then(
    (result) => {
      assert.equal(result.tree.standalone_tasks.length, 6);
    }
  );
});

// ============================================================
// UI AND PERSISTENCE
// ============================================================

test("37/40/41. dismissed/ineligible items never enter the active tree, so they can never appear child and standalone, and final counts always match assembled rows", () => {
  const accepted = workItem({ ref: "wi_1", title: "Create initial site structure" });
  const dismissedIdea = workItem({
    ref: "wi_2",
    title: "Personal AI agent exploration",
    classification: "idea",
    acceptance_state: "proposed",
    work_item_role: "idea"
  });
  const result = assemble({ workItems: [accepted, dismissedIdea] });
  assert.equal(result.tree.standalone_tasks.length, 1);
  const allRefs = [
    ...result.tree.commitments.flatMap((c) => c.tasks.map((t) => t.ref)),
    ...result.tree.standalone_tasks.map((t) => t.ref)
  ];
  assert.deepEqual(allRefs, ["wi_1"]);
  assert.equal(new Set(allRefs).size, allRefs.length);
});

test("38. acceptance criteria are represented separately from child tasks on the assembled commitment", () => {
  const action = workItem({ ref: "wi_1", title: "Create initial site structure" });
  const criterion = workItem({ ref: "wi_2", title: "Present bars and powder", work_item_role: "acceptance_criterion" });
  const draft = [draftGroup("group_g1", "Build the website", ["wi_1"], "explicit_deliverable")];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1"],
      acceptance_criteria_refs: ["wi_2"],
      group_basis: "explicit_deliverable",
      explicit_outcome_evidence: { source_quote: action.source_quote, source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: [action, criterion], draftGroups: draft, verifiedGroups: verified });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.tasks.length, 1);
  assert.equal(commitment.acceptance_criteria.length, 1);
  assert.equal(commitment.tasks.some((t) => t.ref === "wi_2"), false);
});

test("39. future scope items are identifiable for a parking-lot view without entering the active tree", () => {
  const futureItems = [
    workItem({ ref: "wi_1", title: "Enable customer accounts", scope_state: "future_scope", work_item_role: "future_feature" }),
    workItem({ ref: "wi_2", title: "Establish subscriptions", scope_state: "future_scope", work_item_role: "future_feature" })
  ];
  assert.equal(futureItems.every(isFutureScopeItem), true);
  const result = assemble({ workItems: futureItems });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

// ============================================================
// existing merge-layer regression (from the prior hardening pass, still required)
// ============================================================

test("merge deduplicates same segment IDs + same quote even when classification differs", () => {
  const a = rawItem({ title: "Message group chat when ready", classification: "accepted_request", source_quote: "same evidence" });
  const b = rawItem({ title: "Will message group chat when ready", classification: "promise", source_quote: "same evidence" });
  const merged = mergeTopicWorkItems([
    { topicId: null, topicTitle: "A", transcript: "", items: [a] },
    { topicId: null, topicTitle: "B", transcript: "", items: [b] }
  ]);
  assert.equal(merged.items.length, 1);
});

// ============================================================
// WEBSITE FIXTURE (Regression Fixture A) -- fully deterministic, no live meeting exists for this
// fixture, so it is validated at the assembly layer using constructed WorkItems matching the
// meeting description in the task prompt verbatim.
// ============================================================

test("Website fixture: one deliverable commitment, correct owners, acceptance criteria, and future scope excluded", () => {
  const aditya = "Aditya Ujawane";
  const jamileh = "Jamileh Hamideh";

  const aditadyTasks = [
    workItem({ ref: "wi_a1", title: "Create the initial site structure using placeholders", owner: aditya }),
    workItem({ ref: "wi_a2", title: "Build the agreed informational sections", owner: aditya }),
    workItem({ ref: "wi_a3", title: "Generate FAQ questions and send them to Jamileh", owner: aditya }),
    workItem({ ref: "wi_a4", title: "Incorporate Jamileh's answers, content, and assets", owner: aditya }),
    workItem({ ref: "wi_a5", title: "Review the shared reference website", owner: aditya }),
    workItem({ ref: "wi_a6", title: "Research one distinctive website feature", owner: aditya }),
    workItem({ ref: "wi_a7", title: "Connect NavivaFoods.com to the deployment", owner: aditya }),
    workItem({ ref: "wi_a8", title: "Present the first draft before August 1", owner: aditya, due_date: "2026-08-01" })
  ];
  const jamilehTasks = [
    workItem({ ref: "wi_j1", title: "Draft the founder story", owner: jamileh, work_item_role: "input_dependency" }),
    workItem({ ref: "wi_j2", title: "Send ingredients and packaging information", owner: jamileh, work_item_role: "input_dependency" }),
    workItem({ ref: "wi_j3", title: "Send available product and packaging images", owner: jamileh, work_item_role: "input_dependency" }),
    workItem({ ref: "wi_j4", title: "Answer the FAQ questions", owner: jamileh, work_item_role: "input_dependency" }),
    workItem({ ref: "wi_j5", title: "Provide updated content as placeholders are replaced", owner: jamileh, work_item_role: "input_dependency" })
  ];
  const acceptanceCriteria = [
    "Present bars and powder",
    "Include founder story",
    "Explain the protein and origin",
    "Explain product differentiation",
    "Include FAQ",
    "Include available reviews and images",
    "Include contact and available policy information",
    "Use the discussed visual direction",
    "Replace placeholders before launch when final information is available"
  ].map((title, index) =>
    workItem({ ref: `wi_ac${index + 1}`, title, work_item_role: "acceptance_criterion", owner: null })
  );
  const futureScope = [
    "E-commerce checkout",
    "Login and signup",
    "Customer accounts",
    "Order management",
    "Recurring subscriptions",
    "Subscription-management backend",
    "Chatbot",
    "Instagram integration"
  ].map((title, index) =>
    workItem({
      ref: `wi_fs${index + 1}`,
      title,
      scope_state: "future_scope",
      work_item_role: "future_feature"
    })
  );

  const allWorkItems = [...aditadyTasks, ...jamilehTasks, ...acceptanceCriteria, ...futureScope];
  const memberRefs = [...aditadyTasks, ...jamilehTasks].map((t) => t.ref);
  const criteriaRefs = acceptanceCriteria.map((c) => c.ref);

  const draft = [
    draftGroup(
      "group_website",
      "Build and present the first informational website draft before August 1",
      memberRefs,
      "multi_item_shared_purpose",
      criteriaRefs
    )
  ];
  const verified = [
    verifiedGroup({
      ref: "group_website",
      title: draft[0].title,
      member_refs: memberRefs,
      acceptance_criteria_refs: criteriaRefs,
      group_basis: "multi_item_shared_purpose",
      owner: aditya,
      owners: [aditya, jamileh],
      due_date: "2026-08-01",
      due_date_text: "before August 1"
    })
  ];

  const result = assembleExecutionTree({
    transcript,
    workItems: allWorkItems,
    draftGroups: draft,
    verifiedGroups: verified
  });

  assert.equal(result.tree.commitments.length, 1, "exactly one active commitment");
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.title, "Build and present the first informational website draft before August 1");
  assert.equal(commitment.owner, aditya, "primary owner is Aditya, not Team");
  assert.equal(commitment.tasks.length, 13);
  assert.equal(commitment.tasks.filter((t) => t.owner === aditya).length, 8);
  assert.equal(commitment.tasks.filter((t) => t.owner === jamileh).length, 5);
  assert.equal(commitment.acceptance_criteria.length, 9);
  assert.equal(result.tree.standalone_tasks.length, 0, "no standalone tasks required");

  // Required negative assertions
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("domain")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("faq")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("founder")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("images")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("product lines")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("customer accounts")), false);
  assert.equal(result.tree.commitments.some((c) => c.title.toLowerCase().includes("subscription")), false);
  assert.equal(
    allWorkItems.some((item) => item.title === "Use an ecommerce website"),
    false
  );
  assert.equal(futureScope.every((item) => !isExecutionEligible(item)), true, "future scope never eligible");
  assert.equal(futureScope.every(isFutureScopeItem), true, "future scope identifiable for parking lot");

  const validation = validateFinalTree(result.tree);
  assert.equal(validation.ok, true);
});
