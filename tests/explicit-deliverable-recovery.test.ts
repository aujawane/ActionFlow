import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleExecutionTree,
  hasExplicitDeliverableEvidence
} from "../lib/execution-intelligence/execution-tree";
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

const validSegments = new Set([segment]);

function vercelItem(overrides: Partial<WorkItem> = {}) {
  return workItem({
    ref: "wi_10",
    title: "Deploy a Parfait version to Vercel",
    owner: "Aditya Ujawane",
    classification: "promise",
    due_date: "2026-08-11",
    due_date_text: "before next Tuesday",
    status: "in_progress",
    source_quote:
      "i think we should have a version before next tuesday ... i'll deploy one because the extraction layer is still working",
    ...overrides
  });
}

// ============================================================
// 1-3: recovery itself
// ============================================================

test("1. ungrouped Vercel work recovers to a commitment when grouping left it completely unclaimed", () => {
  const deploy = vercelItem();
  // No verified groups at all -- exactly "grouping failed to claim it."
  const result = assemble({ workItems: [deploy], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].group_basis, "explicit_deliverable");
  assert.equal(result.tree.commitments[0].tasks[0].ref, "wi_10");
  assert.equal(result.tree.commitments[0].owner, "Aditya Ujawane");
});

test("2. Vercel work with an existing (working) grouping proposal is unaffected by recovery -- no duplicate commitment", () => {
  const deploy = vercelItem();
  const verified: VerifiedGroup[] = [
    {
      ref: null,
      title: "Deploy a usable Parfait version on Vercel before next Tuesday",
      description: null,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday",
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      acceptance_criteria_refs: [],
      purpose_reason: "x",
      explicit_outcome_evidence: { source_quote: deploy.source_quote, source_segment_ids: [segment] }
    }
  ];
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(
    result.recoveryDecisions.some((d) => d.disposition === "recovered"),
    false,
    "already-claimed work must never be double-processed by recovery"
  );
});

test("3. the recovered item disappears from the standalone complement", () => {
  const deploy = vercelItem();
  const result = assemble({ workItems: [deploy], verifiedGroups: [] });
  assert.equal(result.tree.standalone_tasks.length, 0);
});

// ============================================================
// 4-6: negative cases (no false promotion)
// ============================================================

test("4. a plain 'contact sales' task never recovers to its own commitment", () => {
  const contactSales = workItem({
    ref: "wi_20",
    title: "Contact sales",
    owner: "Aditya Ujawane",
    classification: "open_task",
    source_quote: "i'll contact sales"
  });
  const result = assemble({ workItems: [contactSales], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "wi_20");
});

test("5. the Launch Made transcript-test task remains standalone, not recovered, absent broader outcome evidence", () => {
  const launchMade = workItem({
    ref: "wi_30",
    title: "Test the Launch Made flow using the transcript",
    owner: "Laura Wetherhold",
    classification: "promise",
    source_quote: "i'll test the launch made flow"
  });
  const result = assemble({ workItems: [launchMade], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 1);
});

test("6b. a routine handoff assignment with only a vague timing phrase ('soon') does not recover -- real-replay regression", () => {
  // Exact real-fixture shape that initially over-recovered: classification=assignment (not
  // promise/accepted_request), due_date=null, due_date_text="soon", but recipient set -- "provide
  // Craig the login" reads structurally like a routine child action of enterprise access, not an
  // independent deliverable, and must not become its own commitment on a vague due_date_text or a
  // handoff field alone when the classification itself never signaled an accepted future outcome.
  const login = workItem({
    ref: "wi_3",
    title: "Provide Craig with the OpenAI account login",
    owner: "Aditya Ujawane",
    recipient: "Craig Lauer",
    classification: "assignment",
    due_date: null,
    due_date_text: "soon",
    source_quote: "i'll make sure you have the login for it and you can add yourself as a user for the business account"
  });
  const evidence = hasExplicitDeliverableEvidence(login, validSegments);
  assert.equal(evidence.eligible, false);
  const result = assemble({ workItems: [login], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 1);
});

test("6c. a due_date_text-only timing phrase never independently qualifies even with a strong classification -- only the resolved due_date does", () => {
  const vagueTiming = workItem({
    ref: "wi_50",
    title: "Send the finished proposal",
    owner: "Aditya Ujawane",
    classification: "promise",
    due_date: null,
    due_date_text: "sometime soon",
    source_quote: "i'll send the finished proposal sometime soon"
  });
  // Still recovers here -- but via the deliverable-outcome verb pattern ("send the finished"),
  // not via due_date_text -- proving due_date_text alone is never the deciding signal.
  const evidence = hasExplicitDeliverableEvidence(vagueTiming, validSegments);
  assert.equal(evidence.eligible, true);
  assert.doesNotMatch(evidence.reason, /due_date_text/i);
});

test("6. a communication-process statement ('I'll text you if I have questions') is not execution-eligible and never recovers", () => {
  const textStatement = workItem({
    ref: "wi_31",
    title: "Text if there are questions",
    owner: "Aditya Ujawane",
    execution_scope: "personal_logistics",
    source_quote: "i'll text you if i have questions"
  });
  const evidence = hasExplicitDeliverableEvidence(textStatement, validSegments);
  assert.equal(evidence.eligible, false);
  const result = assemble({ workItems: [textStatement], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
});

// ============================================================
// 7-8: evidence grounding and preservation
// ============================================================

test("7. member evidence (quote + valid segment id) grounds the recovered explicit deliverable directly", () => {
  const deploy = vercelItem();
  const evidence = hasExplicitDeliverableEvidence(deploy, validSegments);
  assert.equal(evidence.eligible, true);
  const result = assemble({ workItems: [deploy], verifiedGroups: [] });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.explicit_outcome_evidence?.source_quote, deploy.source_quote);
  assert.deepEqual(commitment.explicit_outcome_evidence?.source_segment_ids, deploy.source_segment_ids);
});

test("8. the recovered commitment preserves owner, due date, and evidence from the work item unchanged", () => {
  const deploy = vercelItem();
  const result = assemble({ workItems: [deploy], verifiedGroups: [] });
  const commitment = result.tree.commitments[0];
  assert.equal(commitment.owner, "Aditya Ujawane");
  assert.equal(commitment.due_date, "2026-08-11");
  assert.equal(commitment.due_date_text, "before next Tuesday");
  assert.equal(commitment.tasks[0].status, "in_progress");
  assert.equal(commitment.tasks[0].confidence, 0.9);
});

// ============================================================
// 9-10: recovery safety (no duplicates, no child theft)
// ============================================================

test("9. recovery does not duplicate an existing commitment whose outcome the item is already completion-equivalent to", () => {
  const deploy = vercelItem();
  const verified: VerifiedGroup[] = [
    {
      ref: null,
      title: "Deploy a Parfait version to Vercel for the team",
      description: null,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday",
      group_basis: "explicit_zero_task_outcome",
      member_refs: [],
      acceptance_criteria_refs: [],
      purpose_reason: "x",
      explicit_outcome_evidence: { source_quote: "we'll deploy it", source_segment_ids: [segment] }
    }
  ];
  // deploy (wi_10) itself is left unclaimed by this zero-task-outcome group, but its title is
  // near-identical to the existing commitment's own outcome -- recovery must not create a second,
  // duplicate commitment for the same deployment.
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  const decision = result.recoveryDecisions.find((d) => d.work_item_ref === "wi_10");
  assert.equal(decision?.disposition, "already_equivalent");
});

test("10. recovery does not steal a work item that is really just a child action of a broader existing commitment", () => {
  const deploy = vercelItem();
  const relatedChild = workItem({
    ref: "wi_11",
    title: "Deploy the Parfait Vercel build",
    owner: "Aditya Ujawane",
    classification: "promise",
    due_date: "2026-08-11",
    due_date_text: "before next Tuesday",
    source_quote: "i'll also deploy the vercel build before next tuesday"
  });
  const verified: VerifiedGroup[] = [
    {
      ref: null,
      title: "Deploy a Parfait version to Vercel for team access",
      description: null,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday",
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      acceptance_criteria_refs: [],
      purpose_reason: "x",
      explicit_outcome_evidence: { source_quote: deploy.source_quote, source_segment_ids: [segment] }
    }
  ];
  // relatedChild (wi_11) is left unclaimed (only wi_10 was grouped), but it's a near-duplicate of
  // the existing commitment's own outcome -- recovery must not spin up a second commitment for it.
  const result = assemble({ workItems: [deploy, relatedChild], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  const decision = result.recoveryDecisions.find((d) => d.work_item_ref === "wi_11");
  assert.equal(decision?.disposition, "already_equivalent");
});
