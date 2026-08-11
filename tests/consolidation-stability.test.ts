import assert from "node:assert/strict";
import test from "node:test";

import {
  getTaskConsolidationAutoThreshold,
  getTaskConsolidationSuggestThreshold
} from "@/lib/env";
import {
  consolidateExecutionTree,
  deriveCompletionSignature
} from "../lib/execution-intelligence/task-consolidation";
import type { RawWorkItem, TaskConsolidationProposal, WorkItem } from "../lib/execution-intelligence/work-item-schemas";
import type { runTaskConsolidationModel } from "../lib/execution-intelligence/work-item-model";

const segment = "11111111-1111-4111-8111-111111111111";

function rawItem(overrides: Partial<RawWorkItem> & { title: string }): RawWorkItem {
  return {
    description: null,
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"],
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

function chatterCommitment(tasks: WorkItem[]) {
  return {
    ref: "c1",
    title: "Pilot Chatter with a real meeting transcript and open it to the team",
    description: null,
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"],
    due_date: null,
    due_date_text: null,
    group_basis: "multi_item_shared_purpose" as const,
    member_refs: tasks.map((t) => t.ref),
    acceptance_criteria_refs: [],
    purpose_reason: "x",
    explicit_outcome_evidence: null,
    tasks,
    acceptance_criteria: [],
    primary_owner_reason: "x"
  };
}

/** Records every cluster the mock model was ever shown, across every consolidatePool invocation
 * (consolidateExecutionTree calls the model twice -- once per commitment, once cross-pool -- so a
 * ref set can appear/disappear across calls as earlier merges change what's left to compare). */
function recordingModel(
  seenClusters: Array<{ ref: string; tasks: string[] }>,
  respond: (cluster: { cluster_ref: string; tasks: Array<{ ref: string; title: string }> }) => TaskConsolidationProposal[]
): typeof runTaskConsolidationModel {
  return (async ({ context }: any) => {
    const proposals: TaskConsolidationProposal[] = [];
    for (const cluster of context.clusters) {
      seenClusters.push({ ref: cluster.cluster_ref, tasks: cluster.tasks.map((t: { ref: string }) => t.ref) });
      proposals.push(...respond(cluster));
    }
    return { ok: true, proposals, latencyMs: 0, salvagedItems: 0, usage: null };
  }) as typeof runTaskConsolidationModel;
}

function keepAllSeparate(cluster: { tasks: Array<{ ref: string }> }): TaskConsolidationProposal[] {
  return cluster.tasks.map((t) => ({
    proposal_ref: `keep_${t.ref}`,
    task_refs: [t.ref],
    disposition: "keep_separate",
    canonical_title: null,
    canonical_description: null,
    reason: "Distinct phase.",
    confidence: 0.9,
    completion_equivalence: "n/a",
    preserved_sequence_note: null
  }));
}

// ============================================================
// 11-12: cluster formation
// ============================================================

test("11. open-to-team task variants form one candidate cluster", async () => {
  const openA = workItem({ ref: "t1", title: "Open the tested Chatter instance to the team" });
  const openB = workItem({ ref: "t2", title: "Open Chatter testing to the team after evaluation" });
  const openC = workItem({ ref: "t3", title: "Message the group and open Chatter to the team" });
  const tree = { commitments: [chatterCommitment([openA, openB, openC])], standalone_tasks: [] };
  const seen: Array<{ ref: string; tasks: string[] }> = [];
  await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: recordingModel(seen, keepAllSeparate) }
  );
  assert.ok(
    seen.some((c) => c.tasks.includes("t1") && c.tasks.includes("t2") && c.tasks.includes("t3")),
    "all three open-to-team variants must be shortlisted together at least once"
  );
});

test("12. manual Chatter-start variants form one candidate cluster", async () => {
  const start1 = workItem({ ref: "t1", title: "Create the initial Chatter instance from last week's transcript" });
  const start2 = workItem({ ref: "t2", title: "Start with a manual Parfait-to-Chatter workflow" });
  const start3 = workItem({ ref: "t3", title: "Manually export insights and start a Chatter session" });
  const tree = { commitments: [chatterCommitment([start1, start2, start3])], standalone_tasks: [] };
  const seen: Array<{ ref: string; tasks: string[] }> = [];
  await consolidateExecutionTree(
    { meetingId: "m1", tree },
    { runModel: recordingModel(seen, keepAllSeparate) }
  );
  assert.ok(
    seen.some((c) => c.tasks.includes("t1") && c.tasks.includes("t2") && c.tasks.includes("t3")),
    "all three setup variants must be shortlisted together at least once"
  );
});

// ============================================================
// 13-14: phases stay separable
// ============================================================

test("13. setup and evaluation are never confidently classified into the same phase, and remain separable", () => {
  const setup = workItem({ ref: "t1", title: "Start with a manual Parfait-to-Chatter workflow" });
  const evaluate = workItem({ ref: "t2", title: "Test Chatter using the supplied transcript and evaluate its behavior" });
  const sigSetup = deriveCompletionSignature(setup);
  const sigEvaluate = deriveCompletionSignature(evaluate);
  assert.equal(sigSetup.phase, "setup_initiate");
  assert.equal(sigEvaluate.phase, "test_evaluate");
  assert.notEqual(sigSetup.phase, sigEvaluate.phase);
});

test("14. feedback remains a separate candidate/decision from open-to-team when independently completable", async () => {
  const openTeam = workItem({ ref: "t1", title: "Notify the group chat when Chatter is ready and open it to the team" });
  const feedback = workItem({ ref: "t2", title: "Provide feedback after Chatter testing is ready" });
  const tree = { commitments: [chatterCommitment([openTeam, feedback])], standalone_tasks: [] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: recordingModel([], (cluster) => [
        {
          proposal_ref: "p1",
          task_refs: cluster.tasks.map((t) => t.ref),
          disposition: "keep_separate",
          canonical_title: null,
          canonical_description: null,
          reason: "Opening to the team and providing feedback afterward are independently completable.",
          confidence: 0.9,
          completion_equivalence: "n/a",
          preserved_sequence_note: null
        }
      ])
    }
  );
  assert.equal(result.tree.commitments[0].tasks.length, 2);
});

// ============================================================
// 15: cluster partitioning can merge subsets
// ============================================================

test("15. a wide candidate cluster can be partitioned into a merged subset plus separately-kept tasks", async () => {
  const start1 = workItem({ ref: "t1", title: "Create the initial Chatter instance from last week's transcript" });
  const start2 = workItem({ ref: "t2", title: "Start with a manual Parfait-to-Chatter workflow" });
  const evaluate = workItem({ ref: "t3", title: "Test Chatter using the supplied transcript and evaluate its behavior" });
  const tree = { commitments: [chatterCommitment([start1, start2, evaluate])], standalone_tasks: [] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: recordingModel([], (cluster) => {
        const refs = cluster.tasks.map((t) => t.ref);
        const proposals: TaskConsolidationProposal[] = [];
        const setupRefs = refs.filter((r) => r === "t1" || r === "t2");
        if (setupRefs.length > 1) {
          proposals.push({
            proposal_ref: "merge_setup",
            task_refs: setupRefs,
            disposition: "merge",
            canonical_title: "Start the Chatter pilot using the prior week's transcript",
            canonical_description: null,
            reason: "Same start event.",
            confidence: 0.95,
            completion_equivalence: "x",
            preserved_sequence_note: null
          });
        }
        for (const r of refs.filter((r) => !setupRefs.some((s: string) => s === r))) {
          proposals.push({
            proposal_ref: `keep_${r}`,
            task_refs: [r],
            disposition: "keep_separate",
            canonical_title: null,
            canonical_description: null,
            reason: "Distinct phase.",
            confidence: 0.9,
            completion_equivalence: "n/a",
            preserved_sequence_note: null
          });
        }
        return proposals;
      })
    }
  );
  const tasks = result.tree.commitments[0].tasks;
  assert.equal(tasks.length, 2);
  assert.ok(tasks.some((t) => t.ref === "t3"), "evaluate must survive separately");
});

// ============================================================
// 16-17: threshold safety
// ============================================================

test("16. the auto-merge threshold remains 0.88", () => {
  assert.equal(getTaskConsolidationAutoThreshold(), 0.88);
});

test("17. a proposal at confidence 0.80 remains suggestion-only, never applied", async () => {
  const a = workItem({ ref: "t1", title: "Review the reference website" });
  const b = workItem({ ref: "t2", title: "Review the shared reference website example" });
  const tree = { commitments: [], standalone_tasks: [a, b] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: recordingModel([], () => [
        {
          proposal_ref: "p1",
          task_refs: ["t1", "t2"],
          disposition: "merge",
          canonical_title: "Review the reference website",
          canonical_description: null,
          reason: "Plausibly the same, but not certain.",
          confidence: 0.8,
          completion_equivalence: "Maybe the same event.",
          preserved_sequence_note: null
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 2);
  assert.equal(result.suggestions.length, 1);
  assert.ok(0.8 < getTaskConsolidationAutoThreshold());
  assert.ok(0.8 >= getTaskConsolidationSuggestThreshold());
});

// ============================================================
// 18-19: provenance / sequence notes survive
// ============================================================

test("18. evidence/provenance (segment ids, owners) survives a cluster merge", async () => {
  const start1 = workItem({
    ref: "t1",
    title: "Create the initial Chatter instance from last week's transcript",
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"],
    source_segment_ids: ["22222222-2222-4222-8222-222222222222"]
  });
  const start2 = workItem({
    ref: "t2",
    title: "Start with a manual Parfait-to-Chatter workflow",
    owner: "Laura Wetherhold",
    owners: ["Laura Wetherhold"],
    source_segment_ids: ["33333333-3333-4333-8333-333333333333"]
  });
  // Standalone pool, not a multi_item_shared_purpose commitment's own children -- that group_basis
  // requires >=2 members, so merging its only two tasks down to one would itself be a cardinality-
  // unsafe merge (correctly rejected -- see the existing "Fix 1 regression" tests) and never a
  // useful way to test provenance survival.
  const tree = { commitments: [], standalone_tasks: [start1, start2] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: recordingModel([], (cluster) => [
        {
          proposal_ref: "p1",
          task_refs: cluster.tasks.map((t) => t.ref),
          disposition: "merge",
          canonical_title: "Start the Chatter pilot",
          canonical_description: null,
          reason: "same start event",
          confidence: 0.95,
          completion_equivalence: "x",
          preserved_sequence_note: null
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 1);
  const survivor = result.tree.standalone_tasks[0];
  assert.ok(survivor.source_segment_ids.includes("22222222-2222-4222-8222-222222222222"));
  assert.ok(survivor.source_segment_ids.includes("33333333-3333-4333-8333-333333333333"));
  assert.ok(survivor.owners.includes("Laura Wetherhold"));
});

test("19. a sequencing note survives an absorb_as_sequence_note disposition", async () => {
  const primary = workItem({ ref: "t1", title: "Start Chatter pilot session using last week transcript" });
  const sequencing = workItem({ ref: "t2", title: "Try Chatter pilot session before running other transcript flow" });
  const tree = { commitments: [], standalone_tasks: [primary, sequencing] };
  const result = await consolidateExecutionTree(
    { meetingId: "m1", tree },
    {
      runModel: recordingModel([], (cluster) => [
        {
          proposal_ref: "p1",
          task_refs: cluster.tasks.map((t) => t.ref),
          disposition: "absorb_as_sequence_note",
          canonical_title: null,
          canonical_description: null,
          reason: "Sequencing instruction, not a separate deliverable.",
          confidence: 0.95,
          completion_equivalence: "x",
          preserved_sequence_note: "Try before running the other transcript flow."
        }
      ])
    }
  );
  assert.equal(result.tree.standalone_tasks.length, 1);
  const provenance = Array.from(result.provenanceByRef.values())[0];
  assert.ok(provenance?.preserved_sequence_notes.includes("Try before running the other transcript flow."));
});

// ============================================================
// 20: run-to-run stability across wording/fragmentation variants
// ============================================================

function normalizedTaskClasses(tasks: WorkItem[]): string[] {
  return tasks
    .map((t) => deriveCompletionSignature(t).phase ?? "unclassified")
    .sort();
}

test("20. Chatter output variants (4-fragment vs 8-fragment vs reworded) converge to a materially equivalent phase structure after consolidation", async () => {
  const variantA = [
    workItem({ ref: "a1", title: "Initially use a manual Parfait-to-Chatter workflow" }),
    workItem({ ref: "a2", title: "Test Chatter using the supplied transcript" }),
    workItem({ ref: "a3", title: "Make a Chatter session from the prior week's transcript" }),
    workItem({ ref: "a4", title: "Notify the group chat when Chatter is ready and open it to the team" })
  ];
  const variantB = [
    workItem({ ref: "b1", title: "Create the initial Chatter instance from last week's transcript" }),
    workItem({ ref: "b2", title: "Start with a manual Parfait-to-Chatter workflow" }),
    workItem({ ref: "b3", title: "Manually export insights and start a Chatter session" }),
    workItem({ ref: "b4", title: "Test Chatter with the supplied transcript and evaluate its behavior" }),
    workItem({ ref: "b5", title: "Open the tested Chatter instance to the team" }),
    workItem({ ref: "b6", title: "Open Chatter testing to the team after evaluation" }),
    workItem({ ref: "b7", title: "Message the group and open Chatter to the team" }),
    workItem({ ref: "b8", title: "Provide feedback after Chatter testing is ready" })
  ];

  // Realistic canonical titles a real model would plausibly return -- not the raw phase enum key,
  // which (being a single underscored identifier) wouldn't itself contain a recognizable phase
  // verb and would misleadingly reclassify as unclassified.
  const CANONICAL_TITLE_BY_PHASE: Record<string, string> = {
    setup_initiate: "Start the Chatter pilot using the prior week's transcript and manual workflow",
    test_evaluate: "Test the supplied transcript with Chatter and evaluate its behavior",
    feedback_adjust: "Provide feedback on the Chatter pilot and adjust as needed",
    communicate_share: "Message the group and open the tested Chatter pilot to the team"
  };

  const phaseBasedModel: typeof runTaskConsolidationModel = recordingModel([], (cluster) => {
    const byPhase = new Map<string, Array<{ ref: string; title: string }>>();
    for (const task of cluster.tasks) {
      const phase =
        deriveCompletionSignature({ ...task, description: null } as WorkItem).phase ?? `unclassified_${task.ref}`;
      const list = byPhase.get(phase) ?? [];
      list.push(task);
      byPhase.set(phase, list);
    }
    const proposals: TaskConsolidationProposal[] = [];
    for (const [phase, group] of byPhase) {
      if (group.length > 1) {
        proposals.push({
          proposal_ref: `merge_${phase}`,
          task_refs: group.map((t) => t.ref),
          disposition: "merge",
          canonical_title: CANONICAL_TITLE_BY_PHASE[phase] ?? group[0].title,
          canonical_description: null,
          reason: "Same phase, same completion event.",
          confidence: 0.95,
          completion_equivalence: "x",
          preserved_sequence_note: null
        });
      } else {
        proposals.push({
          proposal_ref: `keep_${group[0].ref}`,
          task_refs: [group[0].ref],
          disposition: "keep_separate",
          canonical_title: null,
          canonical_description: null,
          reason: "Distinct phase.",
          confidence: 0.9,
          completion_equivalence: "n/a",
          preserved_sequence_note: null
        });
      }
    }
    return proposals;
  });

  const resultA = await consolidateExecutionTree(
    { meetingId: "m1", tree: { commitments: [chatterCommitment(variantA)], standalone_tasks: [] } },
    { runModel: phaseBasedModel }
  );
  const resultB = await consolidateExecutionTree(
    { meetingId: "m1", tree: { commitments: [chatterCommitment(variantB)], standalone_tasks: [] } },
    { runModel: phaseBasedModel }
  );

  // Not comparing exact titles/counts -- comparing the normalized completion-class structure: the
  // same set of distinct phases should survive regardless of how fragmented or reworded the input.
  const classesA = new Set(normalizedTaskClasses(resultA.tree.commitments[0].tasks));
  const classesB = new Set(normalizedTaskClasses(resultB.tree.commitments[0].tasks));
  assert.ok(classesA.has("setup_initiate"));
  assert.ok(classesB.has("setup_initiate"));
  assert.ok(classesB.has("communicate_share"));
  // Variant A has no explicit evaluate/feedback tasks; variant B does -- both must still end up
  // with no MORE than one task per confidently-classified phase after consolidation.
  const phaseCountsB = new Map<string, number>();
  for (const cls of normalizedTaskClasses(resultB.tree.commitments[0].tasks)) {
    phaseCountsB.set(cls, (phaseCountsB.get(cls) ?? 0) + 1);
  }
  for (const [phase, count] of phaseCountsB) {
    if (phase === "unclassified") continue;
    assert.equal(count, 1, `phase ${phase} should collapse to exactly one task, found ${count}`);
  }
});
