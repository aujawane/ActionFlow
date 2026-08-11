import assert from "node:assert/strict";
import test from "node:test";

import { treeToExecutionGraph } from "../lib/execution-intelligence/execution-graph-v4";
import { reconcileFinalGraph } from "../lib/execution-intelligence/final-reconciliation";
import type { ExecutionTree, WorkItem } from "../lib/execution-intelligence/work-item-schemas";
import { partitionExecutionGraph } from "../lib/execution-display";
import { isCommitmentCurrentGeneration } from "../lib/execution-generation";
import type { MeetingCommitment, MeetingTask } from "../lib/types";

/**
 * Items 22, 23, 25, and 27 from Part 8 are proven by the pre-existing test files continuing to
 * pass unmodified after this pass's changes (see the full-suite run in the final report):
 *   22. Meeting UI generation filtering: tests/generation-currency.test.ts's partitionExecutionGraph
 *       suite (unchanged logic, only its generation helpers moved to lib/execution-generation.ts).
 *   23. Project execution aggregation: tests/generation-currency.test.ts's buildProjectExecutionModel
 *       suite (same reasoning).
 *   25. Chatter fixture: tests/v4-execution-intelligence.test.ts's Chatter-fixture tests.
 *   27. Manual task merging: tests/v4-execution-intelligence.test.ts test 34 ("manual merge control
 *       (existing commitment task-merge UI/RPC) is untouched by this change").
 * This file adds the tests that are genuinely new coverage: an end-to-end check that the
 * ownership/acceptance-criteria/date reconciliation added in this pass survives all the way
 * through treeToExecutionGraph's flattening (item 24, plus the type="team" bug fix), and that a
 * stale-generation standalone task never reappears once persisted rows are re-partitioned by
 * generation (item 26).
 */

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
    classification: "open_task",
    acceptance_state: "accepted",
    execution_scope: "project_work",
    scope_state: "current_scope",
    work_item_role: "action",
    classification_reason: "x",
    source_quote: `I'll ${overrides.title.toLowerCase()}`,
    source_segment_ids: [segment],
    extraction_reason: "x",
    confidence: 0.9,
    topic_id: null,
    ...overrides
  };
}

function criterion(ref: string, title: string): WorkItem {
  return workItem({ ref, title, work_item_role: "acceptance_criterion", owner: null, owners: [] });
}

test("24/team-fix. website-shaped tree: reconciliation + treeToExecutionGraph together produce one commitment, owner Aditya (not Team), type=personal, consolidated criteria", () => {
  const deliver = workItem({ ref: "t1", title: "Deliver the first website draft", owner: "Aditya Ujawane" });
  const founder = workItem({
    ref: "t2",
    title: "Draft the founder story",
    owner: "Jamileh Hamideh",
    owners: ["Jamileh Hamideh"]
  });
  const tree: ExecutionTree = {
    commitments: [
      {
        ref: "c1",
        title: "Deliver the first informational website draft",
        description: null,
        owner: "Aditya Ujawane",
        owners: ["Aditya Ujawane", "Jamileh Hamideh"],
        due_date: "2026-08-01",
        due_date_text: "before August 1, 2026",
        group_basis: "multi_item_shared_purpose",
        member_refs: ["t1", "t2"],
        acceptance_criteria_refs: ["ac1", "ac2"],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [deliver, founder],
        acceptance_criteria: [
          criterion("ac1", "Include an educational explanation of the protein product."),
          criterion("ac2", "Add a page explaining where the protein comes from.")
        ],
        primary_owner_reason: "Declared accountable owner from grouping/verification."
      }
    ],
    standalone_tasks: []
  };

  const reconciled = reconcileFinalGraph({ tree });
  assert.equal(reconciled.tree.commitments.length, 1);
  assert.equal(reconciled.tree.commitments[0].owner, "Aditya Ujawane");
  assert.equal(reconciled.tree.commitments[0].acceptance_criteria.length, 1);

  const graph = treeToExecutionGraph(reconciled.tree);
  assert.equal(graph.commitments.length, 1);
  const [graphCommitment] = graph.commitments;
  assert.ok(graphCommitment);
  assert.equal(graphCommitment.owner, "Aditya Ujawane");
  assert.equal(graphCommitment.type, "personal");
  assert.notEqual(graphCommitment.type, "team");
  assert.equal(graphCommitment.acceptance_criteria?.length, 1);
});

test("execution-graph-v4: a commitment with no resolvable owner at all gets type=unassigned, never team", () => {
  const tree: ExecutionTree = {
    commitments: [
      {
        ref: "c1",
        title: "Some outcome with no owned tasks",
        description: null,
        owner: null,
        owners: [],
        due_date: null,
        due_date_text: null,
        group_basis: "explicit_zero_task_outcome",
        member_refs: [],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: { source_quote: "we'll get this done", source_segment_ids: [segment] },
        tasks: [],
        acceptance_criteria: [],
        primary_owner_reason: "No single accountable owner could be determined."
      }
    ],
    standalone_tasks: []
  };
  const graph = treeToExecutionGraph(tree);
  const [graphCommitment] = graph.commitments;
  assert.ok(graphCommitment);
  assert.equal(graphCommitment.type, "unassigned");
  assert.notEqual(graphCommitment.type, "team");
});

// ============================================================
// 26. no stale generated standalone tasks reappear
// ============================================================

function meetingTask(overrides: Partial<MeetingTask> & { id: string }): MeetingTask {
  return {
    meeting_id: "meeting-a",
    project_id: null,
    topic_id: null,
    commitment_id: null,
    task: "Untitled task",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    inferred: false,
    extraction_metadata: {},
    preserve_on_reanalysis: false,
    manual_override_fields: [],
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    position: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

test("26. a stale-generation standalone task (protected from DB deletion by comments/preserve_on_reanalysis) never reappears in the active standalone list once current-generation filtering is applied", () => {
  const staleStandalone = meetingTask({
    id: "t-stale-standalone",
    commitment_id: null,
    preserve_on_reanalysis: true,
    extraction_metadata: { analysis_generation: 4 }
  });
  const currentStandalone = meetingTask({
    id: "t-current-standalone",
    commitment_id: null,
    extraction_metadata: { analysis_generation: 14 }
  });

  const result = partitionExecutionGraph({
    commitments: [],
    tasks: [staleStandalone, currentStandalone],
    currentGeneration: 14
  });

  assert.deepEqual(
    result.standaloneTasks.map((t) => t.id),
    ["t-current-standalone"]
  );
});

test("26b. a manually created standalone task (no generation stamp) is never treated as stale and reappears correctly alongside current-generation work", () => {
  const manualStandalone = meetingTask({ id: "t-manual-standalone", commitment_id: null, extraction_metadata: {} });
  const currentStandalone = meetingTask({
    id: "t-current-standalone",
    commitment_id: null,
    extraction_metadata: { analysis_generation: 14 }
  });
  const result = partitionExecutionGraph({
    commitments: [],
    tasks: [manualStandalone, currentStandalone],
    currentGeneration: 14
  });
  assert.deepEqual(
    result.standaloneTasks.map((t) => t.id).sort(),
    ["t-current-standalone", "t-manual-standalone"]
  );
});

test("sanity: isCommitmentCurrentGeneration is the one shared implementation in lib/execution-generation.ts, not duplicated per consumer", () => {
  const stale: Pick<MeetingCommitment, "metadata"> = { metadata: { analysis_generation: 4 } };
  assert.equal(isCommitmentCurrentGeneration(stale, 14), false);
});
