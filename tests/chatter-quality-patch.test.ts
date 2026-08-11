import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleExecutionTree
} from "../lib/execution-intelligence/execution-tree";
import { consolidateExecutionTree } from "../lib/execution-intelligence/task-consolidation";
import { TASK_CONSOLIDATION_PROMPT } from "../lib/execution-intelligence/work-item-prompts";
import type {
  GroupProposal,
  RawWorkItem,
  TaskConsolidationProposal,
  VerifiedGroup,
  WorkItem
} from "../lib/execution-intelligence/work-item-schemas";
import type { runTaskConsolidationModel } from "../lib/execution-intelligence/work-item-model";

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

function mockConsolidationModel(
  handler: (context: any) => TaskConsolidationProposal[]
): typeof runTaskConsolidationModel {
  return (async ({ context }: any) => ({
    ok: true,
    proposals: handler(context),
    latencyMs: 0,
    salvagedItems: 0,
    usage: null
  })) as typeof runTaskConsolidationModel;
}

/**
 * consolidateExecutionTree calls the model in two phases -- once per commitment's own children,
 * then again over the (already-consolidated) cross-commitment pool -- so a mock keyed to a fixed
 * task_refs list breaks on the second call once refs have changed. This mock instead makes a
 * title-pattern-based completion-equivalence judgment fresh against whatever tasks each individual
 * invocation actually contains, capturing every cluster it was ever shown (across every call) so
 * tests can assert on the union of what got shortlisted, not just one specific call's shape.
 */
function realisticChatterModel(input: {
  mergeGroups: Array<{ pattern: RegExp; canonicalTitle: string }>;
  seenClusters: Array<{ ref: string; tasks: string[] }>;
}): typeof runTaskConsolidationModel {
  return (async ({ context }: any) => {
    const proposals: TaskConsolidationProposal[] = [];
    for (const cluster of context.clusters as Array<{ cluster_ref: string; tasks: Array<{ ref: string; title: string }> }>) {
      input.seenClusters.push({ ref: cluster.cluster_ref, tasks: cluster.tasks.map((t) => t.ref) });
      const remaining = new Set(cluster.tasks.map((t) => t.ref));
      for (const group of input.mergeGroups) {
        const matches = cluster.tasks.filter((t) => remaining.has(t.ref) && group.pattern.test(t.title));
        if (matches.length > 1) {
          for (const m of matches) remaining.delete(m.ref);
          proposals.push({
            proposal_ref: `${cluster.cluster_ref}_merge_${proposals.length}`,
            task_refs: matches.map((m) => m.ref),
            disposition: "merge",
            canonical_title: group.canonicalTitle,
            canonical_description: null,
            reason: "Same completion event.",
            confidence: 0.95,
            completion_equivalence: "Finishing either finishes the other.",
            preserved_sequence_note: null
          });
        }
      }
      for (const ref of remaining) {
        proposals.push({
          proposal_ref: `${cluster.cluster_ref}_keep_${ref}`,
          task_refs: [ref],
          disposition: "keep_separate",
          canonical_title: null,
          canonical_description: null,
          reason: "Distinct, independently completable phase.",
          confidence: 0.9,
          completion_equivalence: "n/a",
          preserved_sequence_note: null
        });
      }
    }
    return { ok: true, proposals, latencyMs: 0, salvagedItems: 0, usage: null };
  }) as typeof runTaskConsolidationModel;
}

// ============================================================
// ISSUE 1 -- explicit single-task deliverables (items 1-4)
// ============================================================

test("1. Chatter Vercel explicit deliverable becomes a commitment with one member", () => {
  const deploy = workItem({
    ref: "wi_10",
    title: "Deploy a Parfait version to Vercel",
    owner: "Aditya Ujawane",
    due_date: "2026-08-11",
    due_date_text: "before next Tuesday",
    classification: "promise",
    status: "in_progress",
    source_quote:
      "i think we should have a version before next tuesday ... i'll deploy one because the extraction layer is still working"
  });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Deploy a usable Parfait version on Vercel before next Tuesday",
      description: "Provide Craig and Laura with an accessible Parfait deployment before the next Tuesday.",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      due_date: "2026-08-11",
      due_date_text: "before next Tuesday",
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      explicit_outcome_evidence: {
        source_quote:
          "i think we should have a version before next tuesday ... i'll deploy one because the extraction layer is still working",
        source_segment_ids: [segment]
      }
    })
  ];
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].tasks.length, 1);
  assert.equal(result.tree.commitments[0].owner, "Aditya Ujawane");
  assert.equal(result.tree.commitments[0].group_basis, "explicit_deliverable");
});

test("2. the same Vercel work item does not also remain standalone", () => {
  const deploy = workItem({ ref: "wi_10", title: "Deploy a Parfait version to Vercel", owner: "Aditya Ujawane" });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Deploy a usable Parfait version on Vercel",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      explicit_outcome_evidence: { source_quote: deploy.source_quote, source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.standalone_tasks.length, 0);
  const decision = result.workItemDecisions.find((d) => d.work_item_ref === "wi_10");
  assert.equal(decision?.disposition, "child");
});

test("3. a one-member explicit deliverable survives assembly even when the group's own explicit_outcome_evidence fails to validate, falling back to the member's own evidence", () => {
  const deploy = workItem({ ref: "wi_10", title: "Deploy a Parfait version to Vercel", owner: "Aditya Ujawane" });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Deploy a usable Parfait version on Vercel before next Tuesday",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      // The model failed to copy its own evidence -- null, exactly the previously-fatal case.
      explicit_outcome_evidence: null
    })
  ];
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.equal(result.tree.commitments[0].tasks[0].ref, "wi_10");
});

test("3b. a one-member explicit deliverable is removed when NEITHER the group's own evidence NOR the member's evidence validates against the transcript", () => {
  const deploy = workItem({
    ref: "wi_10",
    title: "Deploy a Parfait version to Vercel",
    owner: "Aditya Ujawane",
    source_segment_ids: ["99999999-9999-4999-8999-999999999999"] // not in the transcript's valid segment set
  });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Deploy a usable Parfait version on Vercel",
      owner: "Aditya Ujawane",
      owners: ["Aditya Ujawane"],
      group_basis: "explicit_deliverable",
      member_refs: ["wi_10"],
      explicit_outcome_evidence: null
    })
  ];
  const result = assemble({ workItems: [deploy], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 1);
});

test("4. an ordinary atomic task (no explicit_deliverable group proposed) does not become a commitment", () => {
  const contactSales = workItem({ ref: "wi_20", title: "Contact sales", owner: "Aditya Ujawane" });
  const result = assemble({ workItems: [contactSales], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "wi_20");
});

test("4b. cardinality safeguards are untouched: two ordinary tasks with no verified group at all stay standalone, never promoted", () => {
  const a = workItem({ ref: "wi_1", title: "Deploy the app" });
  const b = workItem({ ref: "wi_2", title: "Write the release notes" });
  const result = assemble({ workItems: [a, b], verifiedGroups: [] });
  assert.equal(result.tree.commitments.length, 0);
  assert.equal(result.tree.standalone_tasks.length, 2);
});

test("4c. existing multi-member reclassification behavior is untouched: a >1-member explicit_deliverable is reclassified to multi_item_shared_purpose, not rejected -- this fix only changes the single-member evidence gate", () => {
  const a = workItem({ ref: "wi_1", title: "Deploy the app" });
  const b = workItem({ ref: "wi_2", title: "Write the release notes" });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Ship the release",
      group_basis: "explicit_deliverable",
      member_refs: ["wi_1", "wi_2"],
      explicit_outcome_evidence: { source_quote: "we'll ship it", source_segment_ids: [segment] }
    })
  ];
  const result = assemble({ workItems: [a, b], verifiedGroups: verified });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.commitments[0].group_basis, "multi_item_shared_purpose");
});

// ============================================================
// ISSUE 2 -- Chatter task over-fragmentation (items 5-8)
// ============================================================

function chatterTasks() {
  return {
    setup1: workItem({
      ref: "wi_6",
      title: "Initially use a manual Parfait-to-Chatter workflow",
      owner: "Laura Wetherhold",
      description:
        "The initial process is to export meeting insights or transcript-derived information manually and have Laura start a Chatter session; automated integration is deferred."
    }),
    setup2: workItem({
      ref: "wi_16",
      title: "Make a Chatter session from the prior week's transcript",
      owner: "Laura Wetherhold",
      description:
        "Laura accepted responsibility for starting with the transcript Aditya sent from the prior week and creating a Chatter session to evaluate the result."
    }),
    test: workItem({
      ref: "wi_9",
      title: "Test Chatter using the supplied transcript",
      owner: "Laura Wetherhold",
      description:
        "Laura accepted responsibility for pasting a transcript into Chatter and observing whether it schedules jobs, asks questions, and participates as a team member rather than only summarizing."
    }),
    openTeam1: workItem({
      ref: "wi_18",
      title: "Notify the group chat when Chatter is ready and open it to the team",
      owner: "Laura Wetherhold",
      description:
        "Laura accepted responsibility for messaging the group when Chatter is ready, testing it with the transcript, and then opening it up to the other participants."
    }),
    openTeam2: workItem({
      ref: "wi_19",
      title: "Message the group and open Chatter to the team",
      owner: "Laura Wetherhold",
      description: "Send a message to the group chat and open the tested Chatter pilot for everyone to use."
    }),
    feedback: workItem({
      ref: "wi_20",
      title: "Provide feedback after Chatter testing is ready",
      owner: "Laura Wetherhold",
      description: "Once the pilot has been tried, give feedback on what worked and what should change."
    })
  };
}

test("5. Chatter setup/manual-flow duplicates merge into one canonical start task", async () => {
  const { setup1, setup2, test: testTask, openTeam1 } = chatterTasks();
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Pilot Chatter with a real meeting transcript and open it to the team",
        description: null,
        owner: "Laura Wetherhold",
        owners: ["Laura Wetherhold"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [setup1.ref, setup2.ref, testTask.ref, openTeam1.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [setup1, setup2, testTask, openTeam1],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };

  const seenClusters: Array<{ ref: string; tasks: string[] }> = [];
  const model = realisticChatterModel({
    seenClusters,
    mergeGroups: [
      {
        pattern: /manual.*workflow|make a chatter session/i,
        canonicalTitle: "Start the initial Chatter pilot using the supplied meeting transcript and manual workflow"
      }
    ]
  });

  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: model });

  // The point of this test: wi_6 and wi_16 must actually reach the model TOGETHER at least once --
  // previously (title-only threshold) they would never have been shortlisted into the same cluster
  // at all, so the model never got a chance to judge them.
  assert.ok(
    seenClusters.some((c) => c.tasks.includes("wi_6") && c.tasks.includes("wi_16")),
    "wi_6 and wi_16 must be shortlisted together at least once"
  );

  const chatter = result.tree.commitments[0];
  assert.equal(chatter.tasks.length, 3);
  // Ranking (rankCanonicalCandidates) picks the survivor's ref by evidence/description/confidence
  // tiebreakers, not by which one this test happened to list first -- assert on the pair
  // collapsing to one task with the canonical title, not on which specific ref string survives.
  const setupSurvivors = chatter.tasks.filter((t) => t.ref === "wi_6" || t.ref === "wi_16");
  assert.equal(setupSurvivors.length, 1, "wi_6 and wi_16 must collapse into exactly one surviving task");
  assert.equal(
    setupSurvivors[0].title,
    "Start the initial Chatter pilot using the supplied meeting transcript and manual workflow"
  );
});

test("6. Chatter open-to-team duplicates merge into one canonical communicate task", async () => {
  const { setup1, test: testTask, openTeam1, openTeam2 } = chatterTasks();
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Pilot Chatter with a real meeting transcript and open it to the team",
        description: null,
        owner: "Laura Wetherhold",
        owners: ["Laura Wetherhold"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [setup1.ref, testTask.ref, openTeam1.ref, openTeam2.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [setup1, testTask, openTeam1, openTeam2],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };

  const seenClusters: Array<{ ref: string; tasks: string[] }> = [];
  const model = realisticChatterModel({
    seenClusters,
    mergeGroups: [
      {
        pattern: /notify the group|message the group/i,
        canonicalTitle: "Message the group and open the tested Chatter pilot to the team"
      }
    ]
  });

  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: model });
  assert.ok(
    seenClusters.some((c) => c.tasks.includes("wi_18") && c.tasks.includes("wi_19")),
    "wi_18 and wi_19 must be shortlisted together at least once"
  );

  const chatter = result.tree.commitments[0];
  assert.equal(chatter.tasks.length, 3);
  assert.ok(!chatter.tasks.some((t) => t.ref === "wi_19"));
});

test("7. the test/evaluate task remains distinct from the setup task even though both are now shortlisted together", async () => {
  const { setup1, setup2, test: testTask } = chatterTasks();
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Pilot Chatter with a real meeting transcript",
        description: null,
        owner: "Laura Wetherhold",
        owners: ["Laura Wetherhold"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [setup1.ref, setup2.ref, testTask.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [setup1, setup2, testTask],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };
  const seenClusters: Array<{ ref: string; tasks: string[] }> = [];
  const model = realisticChatterModel({
    seenClusters,
    mergeGroups: [
      { pattern: /manual.*workflow|make a chatter session/i, canonicalTitle: "Start the Chatter pilot" }
    ]
  });
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: model });
  // The whole point of this test: the deterministic shortlist now bundles test+setup together
  // (previously wi_9 might never have been compared against wi_6/wi_16 at all) -- it is the
  // model's completion-equivalence judgment, not the shortlist, that keeps them apart.
  assert.ok(seenClusters.some((c) => c.tasks.includes("wi_9") && c.tasks.includes("wi_6")));
  const chatter = result.tree.commitments[0];
  assert.equal(chatter.tasks.length, 2);
  assert.ok(chatter.tasks.some((t) => t.ref === "wi_9"), "test task must survive as its own task");
});

test("8. feedback remains distinct from open-to-team when it is an independently completable event", async () => {
  const { openTeam1, feedback } = chatterTasks();
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Pilot Chatter with a real meeting transcript",
        description: null,
        owner: "Laura Wetherhold",
        owners: ["Laura Wetherhold"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [openTeam1.ref, feedback.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [openTeam1, feedback],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: []
  };
  const keepFeedbackSeparate: typeof runTaskConsolidationModel = mockConsolidationModel(() => [
    {
      proposal_ref: "p1",
      task_refs: ["wi_18", "wi_20"],
      disposition: "keep_separate",
      canonical_title: null,
      canonical_description: null,
      reason: "Opening to the team and providing feedback afterward are independently completable events.",
      confidence: 0.9,
      completion_equivalence: "n/a",
      preserved_sequence_note: null
    }
  ]);
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: keepFeedbackSeparate });
  const chatter = result.tree.commitments[0];
  assert.equal(chatter.tasks.length, 2);
});

// ============================================================
// STANDALONE / ENTERPRISE (items 9-10)
// ============================================================

test("9. the Launch Made transcript test remains standalone and is not absorbed into Chatter without direct evidence", async () => {
  const { test: chatterTest } = chatterTasks();
  const launchMade = workItem({
    ref: "wi_30",
    title: "Test the Launch Made flow using the transcript",
    owner: "Laura Wetherhold",
    description: "Laura will try the Launch Made flow with the meeting transcript after trying Chatter first."
  });
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Pilot Chatter with a real meeting transcript",
        description: null,
        owner: "Laura Wetherhold",
        owners: ["Laura Wetherhold"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [chatterTest.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [chatterTest],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [launchMade]
  };
  const keepSeparateProducts: typeof runTaskConsolidationModel = mockConsolidationModel(() => [
    {
      proposal_ref: "p1",
      task_refs: ["wi_9", "wi_30"],
      disposition: "keep_separate",
      canonical_title: null,
      canonical_description: null,
      reason: "Chatter and Launch Made are different products; testing one does not complete testing the other.",
      confidence: 0.9,
      completion_equivalence: "n/a",
      preserved_sequence_note: null
    }
  ]);
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: keepSeparateProducts });
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "wi_30");
});

test("10. the enterprise-login task may be absorbed as a child of the enterprise-access commitment via the standalone-comparison pool, without a new commitment", async () => {
  const investigate = workItem({
    ref: "wi_40",
    title: "Investigate enterprise Codex account options",
    owner: "Aditya Ujawane"
  });
  const contactSales = workItem({
    ref: "wi_41",
    title: "Contact OpenAI sales about enterprise pricing",
    owner: "Aditya Ujawane"
  });
  const login = workItem({
    ref: "wi_42",
    title: "Provide Craig with the OpenAI business account login",
    owner: "Aditya Ujawane",
    description: "Once the enterprise account is set up, share the login with Craig so he has access."
  });
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Clarify enterprise Codex access and account options",
        description: null,
        owner: "Aditya Ujawane",
        owners: ["Aditya Ujawane"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [investigate.ref, contactSales.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [investigate, contactSales],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [login]
  };
  const absorbLogin: typeof runTaskConsolidationModel = mockConsolidationModel(() => [
    {
      proposal_ref: "p1",
      task_refs: ["wi_41", "wi_42"],
      disposition: "merge",
      canonical_title: "Contact OpenAI sales and provide Craig the business account login",
      canonical_description: "Set up the enterprise account and share access with Craig.",
      reason: "Providing the login is the completion of the same enterprise-access outcome as contacting sales.",
      confidence: 0.93,
      completion_equivalence: "Once the account/login is provided, the enterprise-access work for Craig is done.",
      preserved_sequence_note: null
    },
    {
      proposal_ref: "p2",
      task_refs: ["wi_40"],
      disposition: "keep_separate",
      canonical_title: null,
      canonical_description: null,
      reason: "Investigating options is a distinct earlier phase.",
      confidence: 0.9,
      completion_equivalence: "n/a",
      preserved_sequence_note: null
    }
  ]);
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: absorbLogin });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.standalone_tasks.length, 0);
  assert.ok(result.tree.commitments[0].tasks.some((t) => t.ref === "wi_41"));
});

test("10b. the enterprise-login task is left standalone when nothing supports absorbing it (no new commitment created either way)", async () => {
  const investigate = workItem({ ref: "wi_40", title: "Investigate enterprise Codex account options" });
  const login = workItem({ ref: "wi_42", title: "Provide Craig with the OpenAI business account login" });
  const tree = {
    commitments: [
      {
        ref: "c1",
        title: "Clarify enterprise Codex access and account options",
        description: null,
        owner: "Aditya Ujawane",
        owners: ["Aditya Ujawane"],
        due_date: null,
        due_date_text: null,
        group_basis: "multi_item_shared_purpose" as const,
        member_refs: [investigate.ref],
        acceptance_criteria_refs: [],
        purpose_reason: "x",
        explicit_outcome_evidence: null,
        tasks: [investigate],
        acceptance_criteria: [],
        primary_owner_reason: "x"
      }
    ],
    standalone_tasks: [login]
  };
  const keepSeparate: typeof runTaskConsolidationModel = mockConsolidationModel(() => [
    {
      proposal_ref: "p1",
      task_refs: ["wi_40", "wi_42"],
      disposition: "keep_separate",
      canonical_title: null,
      canonical_description: null,
      reason: "Not clearly the same completion event.",
      confidence: 0.9,
      completion_equivalence: "n/a",
      preserved_sequence_note: null
    }
  ]);
  const result = await consolidateExecutionTree({ meetingId: "m1", tree }, { runModel: keepSeparate });
  assert.equal(result.tree.commitments.length, 1);
  assert.equal(result.tree.standalone_tasks.length, 1);
  assert.equal(result.tree.standalone_tasks[0].ref, "wi_42");
});

// ============================================================
// ACCEPTANCE CRITERIA (item 11)
// ============================================================

test("11. TASK_CONSOLIDATION_PROMPT is unaffected; verification prompt now instructs excluding a different-system's own prerequisite from this deliverable's acceptance criteria", async () => {
  const { GROUPING_VERIFICATION_PROMPT } = await import("../lib/execution-intelligence/work-item-prompts");
  assert.match(
    GROUPING_VERIFICATION_PROMPT,
    /prerequisite|belongs to a DIFFERENT system/i
  );
});

test("11b. when verification correctly excludes a different-system prerequisite, assembly represents Chatter's acceptance criteria without it", () => {
  const chatterBehavior = workItem({
    ref: "ac1",
    title: "Chatter asks follow-up questions and participates like a teammate",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: []
  });
  // "Distinguish speakers and task committers" is Parfait's own behavior (a prerequisite Chatter
  // consumes), not something Chatter itself must satisfy -- verification should never attach it to
  // the Chatter group's acceptance_criteria_refs in the first place.
  const parfaitPrerequisite = workItem({
    ref: "ac2",
    title: "Distinguish speakers and task committers in Parfait",
    work_item_role: "acceptance_criterion",
    owner: null,
    owners: []
  });
  const chatterAction = workItem({ ref: "wi_1", title: "Pilot Chatter with the transcript" });
  const verified = [
    verifiedGroup({
      ref: null,
      title: "Pilot Chatter with a real meeting transcript",
      group_basis: "explicit_deliverable",
      member_refs: ["wi_1"],
      // Only the genuinely Chatter-owned criterion is attached; the Parfait prerequisite is
      // deliberately omitted, simulating a verification pass that follows the updated prompt.
      acceptance_criteria_refs: ["ac1"],
      explicit_outcome_evidence: { source_quote: chatterAction.source_quote, source_segment_ids: [segment] }
    })
  ];
  const result = assemble({
    workItems: [chatterAction, chatterBehavior, parfaitPrerequisite],
    verifiedGroups: verified
  });
  const chatter = result.tree.commitments[0];
  assert.equal(chatter.acceptance_criteria.length, 1);
  assert.equal(chatter.acceptance_criteria[0].ref, "ac1");
  assert.ok(!chatter.acceptance_criteria.some((c) => c.ref === "ac2"));
});

// ============================================================
// Consolidation widening: sanity on the prompt's new multi-proposal contract
// ============================================================

test("consolidation prompt now explicitly allows partitioning one cluster into multiple proposals", () => {
  assert.match(TASK_CONSOLIDATION_PROMPT, /more than one genuine completion event/i);
  assert.match(TASK_CONSOLIDATION_PROMPT, /Partition it/i);
});
