import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCommitmentPromotionGuard,
  buildResponsibilityLedger,
  finalizeResponsibilityTrace,
  responsibilitiesOnlyGraph
} from "../lib/execution-intelligence/execution-v2";
import type {
  CommitmentCandidate,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";

const segmentId = "11111111-1111-4111-8111-111111111111";

function task(
  client_ref: string,
  title: string,
  commitment_ref: string | null = null
): TaskCandidate {
  return {
    client_ref,
    commitment_ref,
    topic_id: null,
    title,
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.95,
    source_quote: title,
    source_segment_ids: [segmentId],
    evidence_source: "conversation_event",
    conversation_event_ids: [`event_${client_ref}`],
    inferred: false,
    task_type: "commitment",
    workspace_type: "other",
    suggested_steps: [],
    execution_classification: "committed",
    consolidated_from_refs: []
  };
}

function commitment(client_ref: string, title: string): CommitmentCandidate {
  const source = task(client_ref, title);
  return {
    client_ref,
    topic_id: null,
    title,
    description: null,
    owner: source.owner,
    owners: source.owners,
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.95,
    source_quote: title,
    source_segment_ids: [segmentId],
    evidence_source: "conversation_event",
    conversation_event_ids: source.conversation_event_ids,
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    consolidated_from_refs: []
  };
}

test("V2 candidate adapter makes every early object a standalone responsibility", () => {
  const graph = responsibilitiesOnlyGraph({
    commitments: [commitment("c1", "Set up enterprise OpenAI access")],
    tasks: [task("t1", "Contact OpenAI sales", "c1")]
  });
  assert.equal(graph.commitments.length, 0);
  assert.equal(graph.tasks.length, 2);
  assert.ok(graph.tasks.every((item) => item.commitment_ref === null));
  assert.ok(graph.tasks.some((item) => item.client_ref === "responsibility_c1"));
});

test("promotion guard keeps broad owned outcomes with multiple responsibilities", () => {
  const graph = {
    commitments: [commitment("deploy", "Deploy Parfait internally")],
    tasks: [
      task("finish", "Finish extraction layer", "deploy"),
      task("link", "Share deployment link", "deploy")
    ]
  };
  const result = applyCommitmentPromotionGuard(graph);
  assert.deepEqual(result.graph.commitments.map((item) => item.client_ref), ["deploy"]);
  assert.equal(result.judgments[0].decision, "kept");
});

test("promotion guard demotes straightforward action verbs and preserves provenance", () => {
  const narrow = commitment("send", "Send transcript to Laura");
  narrow.conversation_event_ids = ["accepted_request_1"];
  const result = applyCommitmentPromotionGuard({ commitments: [narrow], tasks: [] });
  assert.equal(result.graph.commitments.length, 0);
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  assert.deepEqual(result.graph.tasks[0].conversation_event_ids, ["accepted_request_1"]);
  assert.equal(result.judgments[0].decision, "demoted");
});

test("reasoning trace explains standalone accepted work and passive meeting records", () => {
  const candidate = task("send", "Send transcript to Laura");
  candidate.conversation_event_ids = ["acceptance_1"];
  const ledger = buildResponsibilityLedger({
    graph: { commitments: [], tasks: [candidate] },
    events: [{
      client_ref: "acceptance_1",
      type: "acceptance",
      actors: ["Aditya"],
      action: "send",
      object: "transcript",
      temporal_state: "future",
      commitment_signal: "accepted",
      source_quote: "I can send you that",
      source_segment_ids: [segmentId],
      linked_event_refs: [],
      confidence: 0.98
    }]
  });
  const trace = finalizeResponsibilityTrace({
    ledger,
    graph: { commitments: [], tasks: [candidate] },
    judgments: []
  });
  assert.equal(trace.version, "responsibility-first-v2");
  assert.equal(trace.responsibilities[0].action_state, "accepted");
  assert.equal(trace.responsibilities[0].disposition, "standalone_task");
  assert.match(trace.responsibilities[0].reason, /no promoted broader outcome/i);
});
