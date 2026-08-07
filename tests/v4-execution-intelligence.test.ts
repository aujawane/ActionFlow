import assert from "node:assert/strict";
import test from "node:test";

import { assembleExecutionTree, isExecutionEligible } from "../lib/execution-intelligence/execution-tree";
import { mergeTopicWorkItems } from "../lib/execution-intelligence/work-item-merge";
import type {
  GroupProposal,
  RawWorkItem,
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
    classification_reason: "First-person accepted future action.",
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
  groupBasis: GroupProposal["group_basis"] = "multi_item_shared_purpose"
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
    purpose_reason: "Shared purpose.",
    scope_added_beyond_members: null,
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
    purpose_reason: "Shared purpose.",
    scope_added_beyond_members: null,
    explicit_outcome_evidence: null,
    ...overrides
  };
}

function assemble(input: {
  workItems: WorkItem[];
  draftGroups?: GroupProposal[];
  verifiedGroups?: VerifiedGroup[];
}) {
  return assembleExecutionTree({
    transcript,
    workItems: input.workItems,
    draftGroups: input.draftGroups ?? [],
    verifiedGroups: input.verifiedGroups ?? []
  });
}

// --- isExecutionEligible ---

test("isExecutionEligible requires project_work + accepted + open/in_progress/blocked + eligible classification", () => {
  const eligible = workItem({ ref: "wi_1", title: "Deploy Parfait" });
  assert.equal(isExecutionEligible(eligible), true);

  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_2", title: "x", execution_scope: "personal_logistics" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_3", title: "x", execution_scope: "informational" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_4", title: "x", acceptance_state: "requested" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_5", title: "x", acceptance_state: "proposed" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_6", title: "x", status: "completed" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_7", title: "x", classification: "decision" })),
    false
  );
  assert.equal(
    isExecutionEligible(workItem({ ref: "wi_8", title: "x", classification: "proposal" })),
    false
  );
  assert.equal(
    isExecutionEligible(
      workItem({ ref: "wi_9", title: "x", classification: "in_progress", status: "in_progress" })
    ),
    true
  );
});

// --- deterministic assembly: group_basis rules ---

test("multiple eligible leaves roll up into one multi_item_shared_purpose commitment", () => {
  const items = [
    workItem({ ref: "wi_1", title: "Create Chatter session" }),
    workItem({ ref: "wi_2", title: "Test transcript input" }),
    workItem({ ref: "wi_3", title: "Observe behavior" }),
    workItem({ ref: "wi_4", title: "Give feedback" })
  ];
  const draft = [draftGroup("group_g1", "Validate Chatter using real meeting context", items.map((i) => i.ref))];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: draft[0].member_refs,
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "These all serve validating Chatter in real meeting context."
    })
  ];
  const result = assemble({ workItems: items, draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 4);
});

test("multi_item_shared_purpose group with fewer than two eligible members after filtering is removed", () => {
  const item = workItem({ ref: "wi_1", title: "Contact sales" });
  const draft = [draftGroup("group_g1", "Establish enterprise access", ["wi_1"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "Only one real member."
    })
  ];
  const result = assemble({ workItems: [item], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref), ["wi_1"]);
});

test("explicit_outcome group with two or more members is rejected", () => {
  const items = [workItem({ ref: "wi_1", title: "Deploy" }), workItem({ ref: "wi_2", title: "Grant access" })];
  const draft = [draftGroup("group_g1", "Deliver before Tuesday", ["wi_1", "wi_2"], "explicit_outcome")];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: { source_quote: "we should have a version before tuesday", source_segment_ids: [segment] },
      scope_added_beyond_members: "A hard deadline neither member states alone."
    })
  ];
  const result = assemble({ workItems: items, draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 2);
  const decision = result.groupDecisions.find((d) => d.group_ref === "group_g1");
  assert.match(decision?.reason ?? "", /at most one member/);
});

test("single-member explicit_outcome group requires BOTH valid evidence and non-vacuous scope", () => {
  const item = workItem({ ref: "wi_1", title: "Deploy Parfait" });

  // Vacuous scope, even with valid evidence -> demoted.
  const vacuousDraft = [draftGroup("group_g1", item.title, ["wi_1"], "explicit_outcome")];
  const vacuousVerified = [
    verifiedGroup({
      ref: "group_g1",
      title: item.title,
      member_refs: ["wi_1"],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: { source_quote: item.source_quote, source_segment_ids: [segment] },
      scope_added_beyond_members: null
    })
  ];
  const vacuousResult = assemble({ workItems: [item], draftGroups: vacuousDraft, verifiedGroups: vacuousVerified });
  assert.equal(vacuousResult.tree.commitments.length, 0);

  // No evidence, even with real scope text -> removed. "Verbose scope text alone is not sufficient."
  const noEvidenceDraft = [draftGroup("group_g2", "Deliver before Tuesday", ["wi_1"], "explicit_outcome")];
  const noEvidenceVerified = [
    verifiedGroup({
      ref: "group_g2",
      title: "Deliver before Tuesday",
      member_refs: ["wi_1"],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: null,
      scope_added_beyond_members: "Adds a hard internal-use deadline this action alone doesn't state."
    })
  ];
  const noEvidenceResult = assemble({ workItems: [item], draftGroups: noEvidenceDraft, verifiedGroups: noEvidenceVerified });
  assert.equal(noEvidenceResult.tree.commitments.length, 0);

  // Both present -> survives.
  const goodDraft = [draftGroup("group_g3", "Deliver before Tuesday", ["wi_1"], "explicit_outcome")];
  const goodVerified = [
    verifiedGroup({
      ref: "group_g3",
      title: "Deliver before Tuesday",
      member_refs: ["wi_1"],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: { source_quote: "we should have a version before tuesday", source_segment_ids: [segment] },
      scope_added_beyond_members: "Adds a hard internal-use deadline this action alone doesn't state."
    })
  ];
  const goodResult = assemble({ workItems: [item], draftGroups: goodDraft, verifiedGroups: goodVerified });
  assert.equal(goodResult.tree.commitments.length, 1);
});

test("zero-member explicit_outcome group requires valid evidence", () => {
  const draftValid = [draftGroup("group_g1", "Deliver before Tuesday", [], "explicit_outcome")];
  const verifiedValid = [
    verifiedGroup({
      ref: "group_g1",
      title: "Deliver before Tuesday",
      member_refs: [],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: { source_quote: "we should have a version before tuesday", source_segment_ids: [segment] }
    })
  ];
  const validResult = assemble({ workItems: [], draftGroups: draftValid, verifiedGroups: verifiedValid });
  assert.equal(validResult.tree.commitments.length, 1);

  const draftInvalid = [draftGroup("group_g2", "Some vague theme", [], "explicit_outcome")];
  const verifiedInvalid = [
    verifiedGroup({
      ref: "group_g2",
      title: "Some vague theme",
      member_refs: [],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: null
    })
  ];
  const invalidResult = assemble({ workItems: [], draftGroups: draftInvalid, verifiedGroups: verifiedInvalid });
  assert.equal(invalidResult.tree.commitments.length, 0);
});

test("a group referencing any unknown or ineligible ref is rejected outright, not silently trimmed", () => {
  const eligible = workItem({ ref: "wi_1", title: "Contact sales" });
  const ineligible = workItem({ ref: "wi_2", title: "Discuss pricing ideas", classification: "proposal", acceptance_state: "proposed" });
  const draft = [draftGroup("group_g1", "Establish enterprise access", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({
      ref: "group_g1",
      title: draft[0].title,
      member_refs: ["wi_1", "wi_2"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "Enterprise access."
    })
  ];
  const result = assemble({ workItems: [eligible, ineligible], draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref), ["wi_1"]);
  const decision = result.groupDecisions.find((d) => d.group_ref === "group_g1");
  assert.equal(decision?.disposition, "removed");
  assert.match(decision?.reason ?? "", /unknown or ineligible/);
});

test("no eligible ref can be claimed by two groups; the second loses the contested ref", () => {
  const shared = workItem({ ref: "wi_1", title: "Contact sales" });
  const other = workItem({ ref: "wi_2", title: "Research billing" });
  const third = workItem({ ref: "wi_3", title: "Follow up" });
  const draft = [
    draftGroup("group_g1", "Establish enterprise access", ["wi_1", "wi_2"]),
    draftGroup("group_g2", "Competing bucket", ["wi_1", "wi_3"])
  ];
  const verified = [
    verifiedGroup({ ref: "group_g1", title: draft[0].title, member_refs: ["wi_1", "wi_2"], group_basis: "multi_item_shared_purpose", purpose_reason: "Enterprise access." }),
    verifiedGroup({ ref: "group_g2", title: draft[1].title, member_refs: ["wi_1", "wi_3"], group_basis: "multi_item_shared_purpose", purpose_reason: "Competing purpose." })
  ];
  const result = assemble({ workItems: [shared, other, third], draftGroups: draft, verifiedGroups: verified });
  const claims = result.tree.commitments.flatMap((c) => c.member_refs);
  assert.equal(claims.filter((ref) => ref === "wi_1").length, 1);
});

test("standalone is always the computed complement, never a modeled field, and no ref is ever both child and standalone", () => {
  const claimed1 = workItem({ ref: "wi_1", title: "Contact sales" });
  const claimed2 = workItem({ ref: "wi_2", title: "Research billing" });
  const unclaimed = workItem({ ref: "wi_3", title: "Continue Cursor support" });
  const draft = [draftGroup("group_g1", "Establish enterprise access", ["wi_1", "wi_2"])];
  const verified = [
    verifiedGroup({ ref: "group_g1", title: draft[0].title, member_refs: ["wi_1", "wi_2"], group_basis: "multi_item_shared_purpose", purpose_reason: "Enterprise access." })
  ];
  const result = assemble({ workItems: [claimed1, claimed2, unclaimed], draftGroups: draft, verifiedGroups: verified });
  const childRefs = new Set(result.tree.commitments.flatMap((c) => c.member_refs));
  const standaloneRefs = new Set(result.tree.standalone_tasks.map((t) => t.ref));
  assert.deepEqual([...childRefs].filter((ref) => standaloneRefs.has(ref)), []);
  assert.deepEqual(standaloneRefs, new Set(["wi_3"]));
});

test("zero standalone tasks is allowed and no minimum or maximum commitment count is enforced", () => {
  const items = Array.from({ length: 6 }, (_, i) => workItem({ ref: `wi_${i + 1}`, title: `Task ${i + 1}` }));
  const draft = items.map((item, i) =>
    draftGroup(`group_g${i + 1}`, `Outcome ${i + 1}`, [item.ref], "explicit_outcome")
  );
  const verified = draft.map((group, i) =>
    verifiedGroup({
      ref: group.ref,
      title: group.title,
      member_refs: group.member_refs,
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: { source_quote: items[i].source_quote, source_segment_ids: [segment] },
      scope_added_beyond_members: `Real broader outcome number ${i + 1}, not a restatement.`
    })
  );
  const result = assemble({ workItems: items, draftGroups: draft, verifiedGroups: verified });
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.tree.commitments.length, 6);
});

// --- merge (Phase I) ---

test("merge deduplicates same segment IDs + same quote even when classification differs", () => {
  const a = rawItem({ title: "Message group chat when ready", classification: "accepted_request", source_quote: "yeah that sounds good i'll message the group chat when it's ready" });
  const b = rawItem({ title: "Will message group chat when ready", classification: "promise", source_quote: "yeah that sounds good i'll message the group chat when it's ready" });
  const merged = mergeTopicWorkItems([
    { topicId: null, topicTitle: "A", transcript: "", items: [a] },
    { topicId: null, topicTitle: "B", transcript: "", items: [b] }
  ]);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.deduplicated, 1);
  assert.deepEqual(new Set(merged.items[0].merge_conflict_classifications), new Set(["accepted_request", "promise"]));
});

test("merge still refuses to fold completed work into open work when evidence is not identical", () => {
  const open = rawItem({ title: "Test Chatter", status: "open", classification: "open_task", source_quote: "i'll test chatter" });
  const completed = rawItem({ title: "Test Chatter", status: "completed", classification: "completed_work", source_quote: "i tested chatter and it worked" });
  const merged = mergeTopicWorkItems([
    { topicId: null, topicTitle: "Topic", transcript: "", items: [open, completed] }
  ]);
  assert.equal(merged.items.length, 2);
});

// --- Phase L: locked regression fixture, meeting 0296bd90-fd8d-4ad1-ab83-5866dab6f6f8 ---
// Modeled on the live generation-16 audit: real content, hardened classifications applied.

const kathySegment = "423be0e9-e32e-4949-a389-54ee9f6d91f6";
const contactSalesSegment = "e993a121-ecb2-4c5b-aacf-3e395e4e0462";
const vercelAskSegment = "a8b384a4-f166-4d02-8446-1ac9062fbd61";
const vercelAcceptSegment = "1943345c-c32c-471c-a5ac-59a3ec3f0d08";
const lauraAug17Segment = "f113f653-b4a8-422f-a799-964f1f9160c2";
const macMiniSegment = "58e0a25b-09a9-40fe-8072-ce2b4e3b7a2e";
const scriptsSegment = "00b418de-6b03-44dd-8eb4-67369128fe0b";
const chatterSessionSegment = "3e541ed8-a59f-446d-a8d3-ac6c62396220";
const chatterFeedbackSegment = "9dfc766d-7e53-4389-af0f-75929acfe1ba";

const liveFixtureTranscript = [
  `[${kathySegment}] Craig: and then i will follow up with kathy to figure out where we are on the codec subscriptions`,
  `[${contactSalesSegment}] Aditya: i'll contact sales and see what they say okay`,
  `[${vercelAskSegment}] Craig: are you going to get a version this week of parfait running on vercel`,
  `[${vercelAcceptSegment}] Aditya: definitely like i'll think we should have a version before next tuesday`,
  `[${lauraAug17Segment}] Laura: i'll come back on the 17th`,
  `[${macMiniSegment}] Aditya: mac mini apparently is on back order`,
  `[${scriptsSegment}] Laura: i fixed some scripts to automate the tidbits dashboard`,
  `[${chatterSessionSegment}] Laura: i'm gonna start with the transcript from last week`,
  `[${chatterFeedbackSegment}] Aditya: yes so that's basically where it's going to start a corporate account`
].join("\n");

function liveFixtureWorkItems(): WorkItem[] {
  return [
    workItem({
      ref: "wi_kathy",
      title: "Follow up with Kathy on codec subscriptions",
      owner: "Craig Lauer",
      owners: ["Craig Lauer"],
      classification: "accepted_request",
      classification_reason: "First-person acceptance to follow up with a named contact.",
      source_quote: "and then i will follow up with kathy to figure out where we are on the codec subscriptions",
      source_segment_ids: [kathySegment]
    }),
    workItem({
      ref: "wi_contact_sales",
      title: "Contact OpenAI sales",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      classification: "accepted_request",
      classification_reason: "\"I'll contact sales\" is an acceptance, not a bare decision.",
      source_quote: "i'll contact sales and see what they say okay",
      source_segment_ids: [contactSalesSegment]
    }),
    workItem({
      ref: "wi_vercel_ask",
      title: "Request to get Parfait running on Vercel this week",
      owner: null,
      owners: [],
      classification: "request",
      acceptance_state: "requested",
      classification_reason: "A request with no acceptance yet.",
      source_quote: "are you going to get a version this week of parfait running on vercel",
      source_segment_ids: [vercelAskSegment]
    }),
    workItem({
      ref: "wi_vercel_accept",
      title: "Accept to have Parfait running on Vercel before next Tuesday",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday",
      classification: "accepted_request",
      classification_reason: "Explicit acceptance of a deadline outcome.",
      source_quote: "definitely like i'll think we should have a version before next tuesday",
      source_segment_ids: [vercelAcceptSegment]
    }),
    workItem({
      ref: "wi_laura_aug17",
      title: "Laura returns on the 17th",
      owner: "Laura Wetherhold",
      owners: ["Laura Wetherhold"],
      classification: "scheduling",
      execution_scope: "personal_logistics",
      classification_reason: "Personal availability, not a project deliverable.",
      source_quote: "i'll come back on the 17th",
      source_segment_ids: [lauraAug17Segment]
    }),
    workItem({
      ref: "wi_mac_mini",
      title: "Mac Mini backorder status",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      classification: "in_progress",
      status: "in_progress",
      acceptance_state: "none",
      execution_scope: "informational",
      classification_reason: "A status update about an order already placed elsewhere.",
      source_quote: "mac mini apparently is on back order",
      source_segment_ids: [macMiniSegment]
    }),
    workItem({
      ref: "wi_scripts_fixed",
      title: "Fixed scripts to automate tidbits dashboard",
      owner: "Laura Wetherhold",
      owners: ["Laura Wetherhold"],
      classification: "completed_work",
      status: "completed",
      acceptance_state: "none",
      classification_reason: "Completed work stated in the past tense.",
      source_quote: "i fixed some scripts to automate the tidbits dashboard",
      source_segment_ids: [scriptsSegment]
    }),
    workItem({
      ref: "wi_chatter_session",
      title: "Create initial Chatter session from last week's transcript",
      owner: "Laura Wetherhold",
      owners: ["Laura Wetherhold"],
      classification: "accepted_request",
      classification_reason: "Accepted plan to build the Chatter session.",
      source_quote: "i'm gonna start with the transcript from last week",
      source_segment_ids: [chatterSessionSegment]
    }),
    workItem({
      ref: "wi_chatter_export",
      title: "Manually export Parfait insights to Chatter",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      classification: "accepted_request",
      classification_reason: "Accepted starting point for the Chatter integration.",
      source_quote: "yes so that's basically where it's going to start a corporate account",
      source_segment_ids: [chatterFeedbackSegment]
    })
  ];
}

test("locked fixture: Kathy follow-up is extracted and eligible", () => {
  const items = liveFixtureWorkItems();
  const kathy = items.find((item) => item.ref === "wi_kathy");
  assert.ok(kathy, "Kathy follow-up must be present in the corrected ledger");
  assert.equal(isExecutionEligible(kathy!), true);
});

test("locked fixture: contact sales is accepted work, not a decision", () => {
  const items = liveFixtureWorkItems();
  const contactSales = items.find((item) => item.ref === "wi_contact_sales")!;
  assert.notEqual(contactSales.classification, "decision");
  assert.equal(contactSales.acceptance_state, "accepted");
  assert.equal(isExecutionEligible(contactSales), true);
});

test("locked fixture: unaccepted Vercel request is ineligible, the accepted outcome is eligible", () => {
  const items = liveFixtureWorkItems();
  const ask = items.find((item) => item.ref === "wi_vercel_ask")!;
  const accept = items.find((item) => item.ref === "wi_vercel_accept")!;
  assert.equal(isExecutionEligible(ask), false);
  assert.equal(isExecutionEligible(accept), true);
});

test("locked fixture: Laura's August 17 return is excluded as personal logistics", () => {
  const items = liveFixtureWorkItems();
  const laura = items.find((item) => item.ref === "wi_laura_aug17")!;
  assert.equal(isExecutionEligible(laura), false);
  assert.equal(laura.execution_scope, "personal_logistics");
});

test("locked fixture: Mac Mini backorder is not active execution", () => {
  const items = liveFixtureWorkItems();
  const macMini = items.find((item) => item.ref === "wi_mac_mini")!;
  assert.equal(isExecutionEligible(macMini), false);
  assert.equal(macMini.execution_scope, "informational");
});

test("locked fixture: completed scripts are never pending", () => {
  const items = liveFixtureWorkItems();
  const scripts = items.find((item) => item.ref === "wi_scripts_fixed")!;
  assert.equal(isExecutionEligible(scripts), false);
  assert.equal(scripts.status, "completed");
});

test("locked fixture: Vercel forms its own commitment and is not a Chatter member", () => {
  const items = liveFixtureWorkItems();
  const draft = [
    draftGroup("group_deploy", "Deliver Parfait before next Tuesday", ["wi_vercel_accept"], "explicit_outcome"),
    draftGroup("group_chatter", "Validate Chatter using real meeting context", ["wi_chatter_session", "wi_chatter_export"])
  ];
  const verified = [
    verifiedGroup({
      ref: "group_deploy",
      title: draft[0].title,
      member_refs: ["wi_vercel_accept"],
      group_basis: "explicit_outcome",
      explicit_outcome_evidence: {
        source_quote: "definitely like i'll think we should have a version before next tuesday",
        source_segment_ids: [vercelAcceptSegment]
      },
      scope_added_beyond_members: "A firm delivery deadline, not just the deploy step alone.",
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday"
    }),
    verifiedGroup({
      ref: "group_chatter",
      title: draft[1].title,
      member_refs: ["wi_chatter_session", "wi_chatter_export"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "Both steps serve validating Chatter with real meeting data."
    })
  ];
  const result = assembleExecutionTree({
    transcript: liveFixtureTranscript,
    workItems: items,
    draftGroups: draft,
    verifiedGroups: verified
  });
  const deployCommitment = result.tree.commitments.find((c) => c.ref === "group_deploy");
  const chatterCommitment = result.tree.commitments.find((c) => c.ref === "group_chatter");
  assert.ok(deployCommitment);
  assert.ok(chatterCommitment);
  assert.deepEqual(deployCommitment!.member_refs, ["wi_vercel_accept"]);
  assert.equal(chatterCommitment!.member_refs.includes("wi_vercel_accept"), false);
});

test("locked fixture: enterprise accepted actions (sales + Kathy) form one coherent commitment", () => {
  const items = liveFixtureWorkItems();
  const draft = [draftGroup("group_enterprise", "Establish or clarify enterprise OpenAI/Codex access", ["wi_contact_sales", "wi_kathy"])];
  const verified = [
    verifiedGroup({
      ref: "group_enterprise",
      title: draft[0].title,
      member_refs: ["wi_contact_sales", "wi_kathy"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "Both steps work toward clarifying enterprise access and licensing."
    })
  ];
  const result = assembleExecutionTree({
    transcript: liveFixtureTranscript,
    workItems: items,
    draftGroups: draft,
    verifiedGroups: verified
  });
  assert.equal(result.tree.commitments.length, 1);
  assert.deepEqual(result.tree.commitments[0].member_refs.sort(), ["wi_contact_sales", "wi_kathy"]);
});

test("locked fixture: no group ever contains proposals, questions, completed work, or personal logistics", () => {
  const items = liveFixtureWorkItems();
  const draft = [
    draftGroup("group_bad", "Padded discussion commitment", [
      "wi_laura_aug17",
      "wi_mac_mini",
      "wi_scripts_fixed"
    ])
  ];
  const verified = [
    verifiedGroup({
      ref: "group_bad",
      title: draft[0].title,
      member_refs: ["wi_laura_aug17", "wi_mac_mini", "wi_scripts_fixed"],
      group_basis: "multi_item_shared_purpose",
      purpose_reason: "Attempted padding with non-eligible items."
    })
  ];
  const result = assembleExecutionTree({
    transcript: liveFixtureTranscript,
    workItems: items,
    draftGroups: draft,
    verifiedGroups: verified
  });
  assert.equal(result.tree.commitments.length, 0);
  const decision = result.groupDecisions.find((d) => d.group_ref === "group_bad");
  assert.equal(decision?.disposition, "removed");
});

test("locked fixture: unclaimed eligible work becomes standalone and nothing is lost or duplicated", () => {
  const items = liveFixtureWorkItems();
  const result = assembleExecutionTree({
    transcript: liveFixtureTranscript,
    workItems: items,
    draftGroups: [],
    verifiedGroups: []
  });
  const eligibleRefs = items.filter(isExecutionEligible).map((i) => i.ref).sort();
  assert.deepEqual(result.tree.standalone_tasks.map((t) => t.ref).sort(), eligibleRefs);
  assert.equal(result.tree.commitments.length, 0);
});
