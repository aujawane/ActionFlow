import assert from "node:assert/strict";
import test from "node:test";

import { evaluateChatterGate } from "../lib/execution-intelligence/gates/chatter-gate";
import { assembleExecutionTree } from "../lib/execution-intelligence/execution-tree";
import type { GroupProposal, RawWorkItem, VerifiedGroup, WorkItem } from "../lib/execution-intelligence/work-item-schemas";

/**
 * Items 21-26 (website fixture, enterprise commitment, AI-loop filtering, generation filtering,
 * Project Brain, full final validation) are proven unchanged by the full pre-existing suite
 * continuing to pass after this patch (see the final report) -- none of those files or fixtures
 * were touched this turn. This file adds the one genuinely new integration check: that a tree
 * exercising BOTH new mechanisms together (an explicit-deliverable recovery for Vercel, since
 * grouping missed it, plus an already-consolidated Chatter commitment) still clears the real
 * go/no-go chatter gate end to end -- not just each mechanism in isolation.
 */

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

test("recovery + an already-consolidated Chatter/enterprise tree together clear the real chatter gate", () => {
  const deploy = workItem({
    ref: "wi_10",
    title: "Deploy a Parfait version to Vercel",
    owner: "Aditya Ujawane",
    classification: "promise",
    due_date: "2026-08-11",
    due_date_text: "before next Tuesday",
    status: "in_progress",
    source_quote:
      "i think we should have a version before next tuesday ... i'll deploy one because the extraction layer is still working"
  });

  const chatterSetup = workItem({
    ref: "wi_6",
    title: "Start the Chatter pilot using the prior week's transcript and manual workflow",
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"]
  });
  const chatterTest = workItem({
    ref: "wi_9",
    title: "Test the supplied transcript with Chatter and evaluate its behavior",
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"]
  });
  const chatterShare = workItem({
    ref: "wi_18",
    title: "Message the group and open the tested Chatter pilot to the team",
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"]
  });

  const contactSales = workItem({
    ref: "wi_4",
    title: "Contact Codex sales about enterprise pricing and account structure",
    owner: "Aditya Ujawane"
  });
  const research = workItem({
    ref: "wi_12",
    title: "Research how the enterprise Codex account works",
    owner: "Aditya Ujawane"
  });

  // Vercel is intentionally given NO verified group at all -- grouping "missed" it, exactly the
  // observed live failure -- while Chatter and Enterprise arrive as already-verified,
  // already-consolidated groups (post task-consolidation shape).
  const verified: VerifiedGroup[] = [
    {
      ref: null,
      title: "Pilot Chatter with a real meeting transcript and open it to the team",
      description: null,
      owner: "Laura Wetherhold",
      owners: ["Laura Wetherhold"],
      due_date: null,
      due_date_text: null,
      group_basis: "multi_item_shared_purpose",
      member_refs: ["wi_6", "wi_9", "wi_18"],
      acceptance_criteria_refs: [],
      purpose_reason: "x",
      explicit_outcome_evidence: null
    },
    {
      ref: null,
      title: "Clarify enterprise Codex access, subscriptions, and account structure",
      description: null,
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: null,
      due_date_text: null,
      group_basis: "multi_item_shared_purpose",
      member_refs: ["wi_4", "wi_12"],
      acceptance_criteria_refs: [],
      purpose_reason: "x",
      explicit_outcome_evidence: null
    }
  ];

  const result = assembleExecutionTree({
    transcript,
    workItems: [deploy, chatterSetup, chatterTest, chatterShare, contactSales, research],
    draftGroups: [] as GroupProposal[],
    verifiedGroups: verified
  });

  assert.equal(result.tree.commitments.length, 3);
  assert.equal(result.tree.standalone_tasks.length, 0);
  const vercelRecovery = result.recoveryDecisions.find((d) => d.work_item_ref === "wi_10");
  assert.equal(vercelRecovery?.disposition, "recovered");

  const gateResult = evaluateChatterGate(result.tree);
  assert.equal(gateResult.ok, true, JSON.stringify(gateResult.failures));
});
