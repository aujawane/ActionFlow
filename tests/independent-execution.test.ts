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
  assert.match(page, /<StandaloneTasksPanel tasks=\{partitioned\.standaloneTasks\}/);
  assert.match(page, /<CommitmentsPanel/);
});

test("recent meeting fixture records the required independent outputs", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/recent-meeting-independent-execution.json", import.meta.url),
    "utf8"
  )) as {
    expected_commitments: string[];
    expected_tasks: string[];
    expected_exclusions: string[];
  };
  assert.deepEqual(fixture.expected_commitments, [
    "Deliver Parfait on Vercel before next Tuesday",
    "Validate Chatter using real Parfait meeting context",
    "Establish or clarify enterprise OpenAI/Codex access"
  ]);
  assert.ok(fixture.expected_tasks.includes("Contact OpenAI sales"));
  assert.ok(fixture.expected_exclusions.includes("Completed script fixes"));
});
