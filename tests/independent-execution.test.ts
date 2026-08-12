import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deterministicallyValidateIndependentGraph,
  mergeTopicActions,
  reconcileRelationshipEvaluation
} from "../lib/execution-intelligence/independent-execution";
import type {
  CommitmentCandidate,
  ExecutionGraph,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";

const segment = "11111111-1111-4111-8111-111111111111";

function task(
  ref: string,
  classification: TaskCandidate["action_classification"] = "open_task",
  status: TaskCandidate["action_status"] = "open"
): TaskCandidate {
  return {
    client_ref: ref,
    commitment_ref: null,
    topic_id: null,
    title: ref.replaceAll("_", " "),
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.95,
    source_quote: `I'll ${ref.replaceAll("_", " ")}`,
    source_segment_ids: [segment],
    evidence_source: "transcript",
    conversation_event_ids: [],
    inferred: false,
    task_type: "commitment",
    workspace_type: "other",
    suggested_steps: [],
    execution_classification: status === "open" ? "committed" : "requirement",
    consolidated_from_refs: [],
    action_classification: classification,
    action_status: status,
    requester: null,
    recipient: null,
    extraction_reason: "Fixture classification",
    relationship_confidence: null,
    relationship_reason: null,
    relationship_evidence: []
  };
}

function commitment(ref: string): CommitmentCandidate {
  return {
    client_ref: ref,
    topic_id: null,
    title: ref.replaceAll("_", " "),
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.95,
    source_quote: `I'll deliver ${ref}`,
    source_segment_ids: [segment],
    evidence_source: "transcript",
    conversation_event_ids: [],
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    consolidated_from_refs: [],
    supporting_action_refs: [],
    commitment_reason: "Accepted future outcome"
  };
}

const source: ExecutionSourceContext = {
  meetingId: "meeting-1",
  transcript: `[${segment}] Aditya: I'll deliver it.`,
  transcriptSegmentCount: 1,
  topics: [],
  insights: [],
  meetingDate: "2026-08-06"
};

function validate(proposed: ExecutionGraph, verified = proposed) {
  return deterministicallyValidateIndependentGraph({ source, proposed, verified });
}

test("independent graph supports a commitment with child tasks", () => {
  const child = { ...task("deploy_parfait"), commitment_ref: "deliver_parfait" };
  const result = validate({ commitments: [commitment("deliver_parfait")], tasks: [child] });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, "deliver_parfait");
});

test("independent graph preserves a commitment with zero tasks", () => {
  const result = validate({ commitments: [commitment("validate_chatter")], tasks: [] });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 0);
});

test("independent graph preserves standalone open tasks", () => {
  const result = validate({ commitments: [], tasks: [task("contact_sales")] });
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  assert.equal(result.decisions[0].disposition, "standalone");
});

test("request without acceptance is excluded while accepted request remains open", () => {
  const request = task("send_transcript_request", "request", "non_execution");
  const accepted = task("send_transcript", "accepted_request", "open");
  const result = validate({ commitments: [], tasks: [request, accepted] });
  assert.deepEqual(result.graph.tasks.map((item) => item.client_ref), ["send_transcript"]);
});

test("completed work, progress, proposals, ideas, decisions, and questions stay out of pending execution", () => {
  const passive = [
    task("fixed_scripts", "completed_work", "completed"),
    task("working_on_chatter", "in_progress", "in_progress"),
    task("maybe_slack", "proposal", "non_execution"),
    task("personal_agent", "idea", "non_execution"),
    task("selected_stack", "decision", "non_execution"),
    task("which_plan", "question", "non_execution")
  ];
  assert.equal(validate({ commitments: [], tasks: passive }).graph.tasks.length, 0);
});

test("global action merge never merges completed work with open work", () => {
  const open = task("test_chatter", "open_task", "open");
  const completed = { ...task("test_chatter_done", "completed_work", "completed"), title: open.title };
  const result = mergeTopicActions([
    { topicId: null, topicTitle: "Topic", transcript: source.transcript, actions: [open, completed] }
  ]);
  assert.equal(result.actions.length, 2);
});

test("relationship evaluation prefers standalone when same-topic evidence does not advance a commitment", () => {
  const proposed = { commitments: [commitment("enterprise_access")], tasks: [task("schedule_lunch")] };
  const evaluated = {
    commitments: proposed.commitments,
    tasks: [{
      ...proposed.tasks[0],
      commitment_ref: null,
      relationship_confidence: 0.2,
      relationship_reason: "Same topic but does not advance enterprise access."
    }]
  };
  const result = reconcileRelationshipEvaluation({ proposed, evaluated });
  assert.equal(result.graph.tasks[0].commitment_ref, null);
});

test("relationship evaluation links a task that materially advances a commitment", () => {
  const proposed = { commitments: [commitment("enterprise_access")], tasks: [task("contact_sales")] };
  const evaluated = {
    commitments: proposed.commitments,
    tasks: [{
      ...proposed.tasks[0],
      commitment_ref: "enterprise_access",
      relationship_confidence: 0.94,
      relationship_reason: "Sales clarification materially advances enterprise access."
    }]
  };
  const result = reconcileRelationshipEvaluation({ proposed, evaluated });
  assert.equal(result.graph.tasks[0].commitment_ref, "enterprise_access");
});

test("deterministic validation has no commitment count or title-verb promotion rule", () => {
  const commitments = Array.from({ length: 9 }, (_, index) =>
    commitment(index === 0 ? "Contact sales outcome" : `outcome_${index}`)
  );
  assert.equal(validate({ commitments, tasks: [] }).graph.commitments.length, 9);
  assert.equal(validate({ commitments: [], tasks: [] }).graph.commitments.length, 0);
});

test("meeting UI renders standalone tasks and commitments independently", async () => {
  const page = await readFile(new URL("../app/meetings/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<StandaloneTasksPanel\s+tasks=\{partitioned\.standaloneTasks\}/);
  assert.match(page, /<CommitmentsPanel/);
});

test("commitment with multiple linked tasks is never collapsed", () => {
  const createSession = { ...task("create_chatter_session"), commitment_ref: "validate_chatter" };
  const testCsv = { ...task("test_csv_support"), commitment_ref: "validate_chatter" };
  const result = validate({
    commitments: [commitment("validate_chatter")],
    tasks: [createSession, testCsv]
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(
    result.graph.tasks.filter((item) => item.commitment_ref === "validate_chatter").length,
    2
  );
});

test("commitment stated directly with no supporting tasks survives as the zero-task fallback", () => {
  const result = validate({ commitments: [commitment("establish_enterprise_access")], tasks: [] });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.decisions[0].disposition, "kept");
});

test("commitment with one linked task remains separate when it adds broader scope", () => {
  const linkedTask = { ...task("contact_openai_sales"), commitment_ref: "establish_enterprise_access" };
  const broaderCommitment = {
    ...commitment("establish_enterprise_access"),
    title: "Establish enterprise OpenAI/Codex access",
    due_date: "2026-08-20",
    due_date_text: "by August 20"
  };
  const result = validate({ commitments: [broaderCommitment], tasks: [linkedTask] });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, "establish_enterprise_access");
});

test("commitment collapses into its single linked task when they share identical evidence", () => {
  const duplicateTask = {
    ...task("contact_openai_sales"),
    commitment_ref: "contact_openai_sales_commitment"
  };
  const duplicateCommitment = {
    ...commitment("contact_openai_sales_commitment"),
    title: duplicateTask.title,
    description: duplicateTask.description,
    source_quote: duplicateTask.source_quote,
    source_segment_ids: duplicateTask.source_segment_ids,
    due_date: duplicateTask.due_date,
    due_date_text: duplicateTask.due_date_text
  };
  const result = validate({ commitments: [duplicateCommitment], tasks: [duplicateTask] });
  assert.equal(result.graph.commitments.length, 0);
  assert.equal(result.graph.tasks.length, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  const commitmentDecision = result.decisions.find(
    (decision) => decision.item_ref === "contact_openai_sales_commitment"
  );
  const taskDecision = result.decisions.find((decision) => decision.item_ref === "contact_openai_sales");
  assert.equal(commitmentDecision?.disposition, "excluded");
  assert.match(commitmentDecision?.reason ?? "", /Collapsed/);
  assert.equal(taskDecision?.disposition, "standalone");
  assert.match(taskDecision?.reason ?? "", /absorbed/);
});

test("commitment proposed from mere topic discussion is dropped when verification rejects it", () => {
  const discussionOnly = commitment("memory_architecture_discussion");
  const result = validate({ commitments: [discussionOnly], tasks: [] }, { commitments: [], tasks: [] });
  assert.equal(result.graph.commitments.length, 0);
  const decision = result.decisions.find(
    (item) => item.item_ref === "memory_architecture_discussion"
  );
  assert.equal(decision?.disposition, "excluded");
  assert.doesNotMatch(decision?.reason ?? "", /Collapsed/);
});

test("accepted tasks with no broader outcome remain standalone tasks", () => {
  const result = validate({
    commitments: [],
    tasks: [task("share_deployment_link"), task("message_group_when_ready")]
  });
  assert.equal(result.graph.commitments.length, 0);
  assert.equal(result.graph.tasks.length, 2);
  for (const decision of result.decisions) {
    assert.equal(decision.disposition, "standalone");
  }
});

test("four related Chatter actions roll up into one broader commitment, not four", () => {
  const createSession = { ...task("create_chatter_session"), commitment_ref: "validate_chatter" };
  const testInput = { ...task("test_transcript_input"), commitment_ref: "validate_chatter" };
  const observeBehavior = { ...task("observe_chatter_behavior"), commitment_ref: "validate_chatter" };
  const messageGroup = { ...task("message_group_when_ready"), commitment_ref: "validate_chatter" };
  const validateChatter = {
    ...commitment("validate_chatter"),
    title: "Validate Chatter using real Parfait meeting context",
    scope_added_beyond_actions:
      "Confirms Chatter is useful across the whole session/testing/feedback loop, not any one step."
  };
  const result = validate({
    commitments: [validateChatter],
    tasks: [createSession, testInput, observeBehavior, messageGroup]
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.deepEqual(
    result.graph.tasks.map((item) => item.commitment_ref),
    ["validate_chatter", "validate_chatter", "validate_chatter", "validate_chatter"]
  );
  assert.equal(result.graph.commitments.filter((item) => /chatter/i.test(item.title)).length, 1);
});

test("enterprise research and follow-up actions roll up into one enterprise-access commitment", () => {
  const contactSales = { ...task("contact_openai_sales"), commitment_ref: "enterprise_access" };
  const researchBilling = { ...task("research_enterprise_billing"), commitment_ref: "enterprise_access" };
  const followUpKathy = { ...task("follow_up_with_kathy"), commitment_ref: "enterprise_access" };
  const enterpriseAccess = {
    ...commitment("enterprise_access"),
    title: "Establish or clarify enterprise OpenAI/Codex access",
    scope_added_beyond_actions:
      "The point of these three actions together is landing enterprise account access, not any one call."
  };
  const result = validate({
    commitments: [enterpriseAccess],
    tasks: [contactSales, researchBilling, followUpKathy]
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(
    result.graph.tasks.filter((item) => item.commitment_ref === "enterprise_access").length,
    3
  );
});

test("explicit Vercel deadline commitment survives even when supporting tasks are incomplete", () => {
  const deliverParfait = {
    ...commitment("deliver_parfait"),
    title: "Deliver Parfait for internal team use before next Tuesday",
    due_date: "2026-08-11",
    due_date_text: "before next Tuesday",
    scope_added_beyond_actions:
      "Commits to a working, accessible deployment by a specific date, not just one deploy step.",
    supporting_action_refs: []
  };
  const result = validate({ commitments: [deliverParfait], tasks: [] });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(
    result.decisions.find((decision) => decision.item_ref === "deliver_parfait")?.disposition,
    "kept"
  );
});

test("a commitment with a non-empty but vacuous scope statement still collapses into its task", () => {
  const duplicateTask = {
    ...task("share_credentials_with_team"),
    commitment_ref: "share_credentials_commitment"
  };
  const duplicateCommitment = {
    ...commitment("share_credentials_commitment"),
    title: duplicateTask.title,
    description: duplicateTask.description,
    source_quote: duplicateTask.source_quote,
    source_segment_ids: duplicateTask.source_segment_ids,
    due_date: duplicateTask.due_date,
    due_date_text: duplicateTask.due_date_text,
    scope_added_beyond_actions: duplicateTask.title
  };
  const result = validate({ commitments: [duplicateCommitment], tasks: [duplicateTask] });
  assert.equal(result.graph.commitments.length, 0);
  assert.equal(result.graph.tasks[0].commitment_ref, null);
});

test("deferred automation is never returned as an active commitment or task", () => {
  const deferredIdea = task("automate_parfait_chatter_integration", "idea", "non_execution");
  const deferredCommitment = commitment("automate_integration_commitment");
  const result = validate(
    { commitments: [deferredCommitment], tasks: [deferredIdea] },
    { commitments: [], tasks: [] }
  );
  assert.equal(result.graph.commitments.length, 0);
  assert.equal(result.graph.tasks.length, 0);
});

test("backorder status update remains a status report, not a new commitment or task", () => {
  const backorderUpdate = task("mac_mini_backorder_status", "in_progress", "in_progress");
  const result = validate({ commitments: [], tasks: [backorderUpdate] });
  assert.equal(result.graph.tasks.length, 0);
});

test("completed work stays out of the active graph regardless of title", () => {
  const completedItems = [
    task("completed_credentials_delivery", "completed_work", "completed"),
    task("completed_dashboard_fixes", "completed_work", "completed"),
    task("completed_cron_job_cleanup", "completed_work", "completed")
  ];
  const result = validate({ commitments: [], tasks: completedItems });
  assert.equal(result.graph.tasks.length, 0);
});

test("Cursor follow-up remains a standalone task with no commitment to roll up into", () => {
  const cursorFollowUp = task("continue_following_up_with_cursor_support");
  const unrelatedCommitment = commitment("validate_chatter");
  const result = validate({
    commitments: [unrelatedCommitment],
    tasks: [cursorFollowUp]
  });
  const decision = result.decisions.find(
    (item) => item.item_ref === "continue_following_up_with_cursor_support"
  );
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  assert.equal(decision?.disposition, "standalone");
});

test("uncertain relationship decision is reconciled to standalone even if a commitment_ref was set", () => {
  const proposed = { commitments: [commitment("enterprise_access")], tasks: [task("test_letta_memory_flow")] };
  const evaluated = {
    commitments: proposed.commitments,
    tasks: [{
      ...proposed.tasks[0],
      commitment_ref: "enterprise_access",
      relationship_decision: "uncertain" as const,
      relationship_confidence: 0.4,
      relationship_reason: "Unclear whether this memory experiment is part of enterprise access."
    }]
  };
  const result = reconcileRelationshipEvaluation({ proposed, evaluated });
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  assert.equal(result.graph.tasks[0].relationship_decision, "uncertain");
});

test("reconciled relationship_decision reflects child_task vs standalone_task outcomes", () => {
  const proposed = {
    commitments: [commitment("enterprise_access")],
    tasks: [task("contact_openai_sales"), task("schedule_lunch")]
  };
  const evaluated = {
    commitments: proposed.commitments,
    tasks: [
      {
        ...proposed.tasks[0],
        commitment_ref: "enterprise_access",
        relationship_decision: "child_task" as const,
        relationship_reason: "Directly pursues enterprise access."
      },
      {
        ...proposed.tasks[1],
        commitment_ref: null,
        relationship_decision: "standalone_task" as const,
        relationship_reason: "Unrelated personal scheduling."
      }
    ]
  };
  const result = reconcileRelationshipEvaluation({ proposed, evaluated });
  const salesTask = result.graph.tasks.find((item) => item.client_ref === "contact_openai_sales");
  const lunchTask = result.graph.tasks.find((item) => item.client_ref === "schedule_lunch");
  assert.equal(salesTask?.relationship_decision, "child_task");
  assert.equal(salesTask?.commitment_ref, "enterprise_access");
  assert.equal(lunchTask?.relationship_decision, "standalone_task");
  assert.equal(lunchTask?.commitment_ref, null);
});

test("no accepted task ever survives alongside an identical zero-child commitment", () => {
  const chatterTask = { ...task("create_chatter_session"), commitment_ref: "validate_chatter" };
  const otherChatterTask = { ...task("give_chatter_feedback"), commitment_ref: "validate_chatter" };
  const duplicateTask = task("follow_up_with_kathy");
  const duplicateCommitment = {
    ...commitment("follow_up_with_kathy_commitment"),
    title: duplicateTask.title,
    description: duplicateTask.description,
    source_quote: duplicateTask.source_quote,
    source_segment_ids: duplicateTask.source_segment_ids
  };
  const validateChatter = commitment("validate_chatter");
  const linkedDuplicateTask = { ...duplicateTask, commitment_ref: "follow_up_with_kathy_commitment" };
  const result = validate({
    commitments: [validateChatter, duplicateCommitment],
    tasks: [chatterTask, otherChatterTask, linkedDuplicateTask]
  });
  for (const finalTask of result.graph.tasks.filter((item) => !item.commitment_ref)) {
    const shadowCommitment = result.graph.commitments.find(
      (item) =>
        item.title.trim().toLowerCase() === finalTask.title.trim().toLowerCase() &&
        item.source_quote.trim().toLowerCase() === finalTask.source_quote.trim().toLowerCase()
    );
    assert.equal(shadowCommitment, undefined);
  }
  assert.equal(
    result.graph.commitments.some((item) => item.client_ref === "follow_up_with_kathy_commitment"),
    false
  );
});

test("recent meeting fixture records the required independent outputs", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/recent-meeting-independent-execution.json", import.meta.url),
    "utf8"
  )) as {
    expected_commitments: Array<{ title: string; owners: string[]; child_tasks: string[] }>;
    expected_standalone_tasks: string[];
    expected_uncertain_items: string[];
    expected_exclusions: string[];
  };
  assert.deepEqual(
    fixture.expected_commitments.map((commitment) => commitment.title),
    [
      "Deliver Parfait for internal team use before next Tuesday",
      "Validate Chatter using real Parfait meeting context",
      "Establish or clarify enterprise OpenAI/Codex access"
    ]
  );
  const chatterCommitment = fixture.expected_commitments.find((commitment) =>
    commitment.title.startsWith("Validate Chatter")
  );
  assert.equal(chatterCommitment?.child_tasks.length, 7);
  assert.ok(!chatterCommitment?.child_tasks.some((title) => /^validate chatter/i.test(title)));
  const enterpriseCommitment = fixture.expected_commitments.find((commitment) =>
    commitment.title.startsWith("Establish or clarify")
  );
  assert.ok(enterpriseCommitment?.child_tasks.includes("Contact OpenAI sales"));
  assert.ok(fixture.expected_standalone_tasks.includes("Continue following up with Cursor support"));
  assert.ok(fixture.expected_exclusions.includes("Automate Parfait and Chatter integration"));
  assert.ok(fixture.expected_exclusions.includes("Manage Mac Mini backorder"));
  assert.ok(fixture.expected_exclusions.includes("Completed dashboard fixes"));
});
