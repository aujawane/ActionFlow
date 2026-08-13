import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDependencyInferenceContext,
  DEPENDENCY_CONFIDENCE_THRESHOLD,
  dependencyInferenceResultSchema,
  validateDependencyCandidates,
  wouldCreateCycle,
  type DependencyCandidate
} from "../lib/task-dependency-inference";
import type { MeetingCommitment, MeetingTask } from "../lib/types";

let counter = 0;
function task(overrides: Partial<MeetingTask> = {}): MeetingTask {
  counter += 1;
  return {
    id: `task-${counter}`,
    meeting_id: "meeting-1",
    project_id: null,
    topic_id: null,
    commitment_id: "commitment-1",
    task: `Task ${counter}`,
    owner: null,
    owners: [],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    due_date: null,
    inferred: false,
    extraction_metadata: null,
    manual_override_fields: [],
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function commitment(overrides: Partial<MeetingCommitment> = {}): MeetingCommitment {
  return {
    id: "commitment-1",
    meeting_id: "meeting-1",
    project_id: null,
    topic_id: null,
    title: "Build the Shopify website",
    description: "Launch an informational Shopify site for the product.",
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: null,
    source_segment_ids: [],
    type: "assignment",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    manual_override_fields: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function candidate(overrides: Partial<DependencyCandidate>): DependencyCandidate {
  return {
    task_id: "task-1",
    depends_on_task_id: "task-2",
    relationship: "hard_dependency",
    confidence: 0.95,
    reason: "B requires A to exist first.",
    evidence: "",
    ...overrides
  };
}

// ============================================================
// 1. Structured output parsing (mock/model-output layer, tested separately from validation,
// as required -- no live OpenAI call is made or mocked here; this is the same zod schema
// inferTaskDependenciesWithOpenAI parses the model's response through).
// ============================================================

test("dependencyInferenceResultSchema: parses a well-formed structured response", () => {
  const parsed = dependencyInferenceResultSchema.safeParse({
    dependencies: [
      {
        task_id: "task-1",
        depends_on_task_id: "task-2",
        relationship: "hard_dependency",
        confidence: 0.94,
        reason: "Website implementation requires the Shopify account to exist.",
        evidence: "Once the account exists, building can begin."
      }
    ]
  });
  assert.equal(parsed.success, true);
});

test("dependencyInferenceResultSchema: rejects an unknown relationship value", () => {
  const parsed = dependencyInferenceResultSchema.safeParse({
    dependencies: [
      {
        task_id: "task-1",
        depends_on_task_id: "task-2",
        relationship: "strongly_related",
        confidence: 0.94,
        reason: "x",
        evidence: ""
      }
    ]
  });
  assert.equal(parsed.success, false);
});

test("dependencyInferenceResultSchema: rejects extra/unexpected fields (strict schema)", () => {
  const parsed = dependencyInferenceResultSchema.safeParse({
    dependencies: [],
    notes: "the model added something extra"
  });
  assert.equal(parsed.success, false);
});

test("dependencyInferenceResultSchema: an empty dependencies array is valid (no dependencies is a normal result)", () => {
  const parsed = dependencyInferenceResultSchema.safeParse({ dependencies: [] });
  assert.equal(parsed.success, true);
});

// ============================================================
// 2. Cycle detection (deterministic, mirrors the DB trigger)
// ============================================================

test("wouldCreateCycle: a fresh edge with no existing edges never cycles", () => {
  assert.equal(wouldCreateCycle([], { task_id: "A", depends_on_task_id: "B" }), false);
});

test("wouldCreateCycle: two-node cycle is rejected (A->B exists, proposing B->A)", () => {
  const existing = [{ task_id: "A", depends_on_task_id: "B" }];
  assert.equal(wouldCreateCycle(existing, { task_id: "B", depends_on_task_id: "A" }), true);
});

test("wouldCreateCycle: multi-node cycle is rejected (A->B, B->C exist, proposing C->A)", () => {
  const existing = [
    { task_id: "A", depends_on_task_id: "B" },
    { task_id: "B", depends_on_task_id: "C" }
  ];
  assert.equal(wouldCreateCycle(existing, { task_id: "C", depends_on_task_id: "A" }), true);
});

test("wouldCreateCycle: self dependency is always a cycle", () => {
  assert.equal(wouldCreateCycle([], { task_id: "A", depends_on_task_id: "A" }), true);
});

test("wouldCreateCycle: a chain that does not loop back is not a cycle", () => {
  const existing = [{ task_id: "B", depends_on_task_id: "C" }];
  assert.equal(wouldCreateCycle(existing, { task_id: "A", depends_on_task_id: "B" }), false);
});

// ============================================================
// 3. validateDependencyCandidates -- the full non-LLM server-side validation layer
// ============================================================

test("validateDependencyCandidates: a valid A depends on B relationship is accepted", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: a.id, depends_on_task_id: b.id, confidence: 0.9 })],
    tasks: [a, b]
  });
  assert.deepEqual(result.accepted, [
    { task_id: a.id, depends_on_task_id: b.id, confidence: 0.9, reason: "B requires A to exist first." }
  ]);
  assert.deepEqual(result.rejected, []);
});

test("validateDependencyCandidates: self dependency is rejected", () => {
  const a = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: a.id, depends_on_task_id: a.id })],
    tasks: [a]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "self_dependency");
});

test("validateDependencyCandidates: an id outside the candidate task pool is rejected as unknown", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: a.id, depends_on_task_id: "task-does-not-exist" })],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "unknown_task_id");
});

test("validateDependencyCandidates: a stale-generation task is rejected, even though it was in the candidate pool", () => {
  const a = task({ extraction_metadata: { analysis_generation: 1 } });
  const b = task({ extraction_metadata: { analysis_generation: 2 } });
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: a.id, depends_on_task_id: b.id })],
    tasks: [a, b],
    currentGeneration: 2
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "stale_generation");
});

test("validateDependencyCandidates: reanalysis never retains a stale task id -- an older-generation task cannot become part of the current dependency graph", () => {
  const stale = task({ extraction_metadata: { analysis_generation: 1 } });
  const current = task({ extraction_metadata: { analysis_generation: 3 } });
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: current.id, depends_on_task_id: stale.id, confidence: 0.99 })
    ],
    tasks: [stale, current],
    currentGeneration: 3
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "stale_generation");
});

test("validateDependencyCandidates: a duplicate (task_id, depends_on_task_id) pair in the same response is rejected on the second occurrence", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: a.id, depends_on_task_id: b.id }),
      candidate({ task_id: a.id, depends_on_task_id: b.id })
    ],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(
    result.rejected.some((item) => item.reason === "duplicate_candidate"),
    true
  );
});

test("validateDependencyCandidates: a two-node cycle proposed in one response is rejected (only the first, higher-confidence direction is kept)", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: a.id, depends_on_task_id: b.id, confidence: 0.95 }),
      candidate({ task_id: b.id, depends_on_task_id: a.id, confidence: 0.9 })
    ],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.task_id, a.id);
  assert.equal(
    result.rejected.some((item) => item.reason === "would_create_cycle"),
    true
  );
});

test("validateDependencyCandidates: a multi-node cycle across several accepted-this-pass edges is rejected (A->B, B->C, then C->A)", () => {
  const a = task();
  const b = task();
  const c = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: a.id, depends_on_task_id: b.id, confidence: 0.95 }),
      candidate({ task_id: b.id, depends_on_task_id: c.id, confidence: 0.93 }),
      candidate({ task_id: c.id, depends_on_task_id: a.id, confidence: 0.91 })
    ],
    tasks: [a, b, c]
  });
  assert.equal(result.accepted.length, 2);
  assert.deepEqual(
    result.accepted.map((edge) => `${edge.task_id}->${edge.depends_on_task_id}`).sort(),
    [`${a.id}->${b.id}`, `${b.id}->${c.id}`].sort()
  );
  assert.equal(
    result.rejected.some((item) => item.reason === "would_create_cycle"),
    true
  );
});

test("validateDependencyCandidates: a new edge that would cycle through an already-existing (pre-existing) edge is rejected", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: b.id, depends_on_task_id: a.id, confidence: 0.95 })],
    tasks: [a, b],
    existingEdges: [{ task_id: a.id, depends_on_task_id: b.id }]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "would_create_cycle");
});

test("validateDependencyCandidates: relationship types other than hard_dependency never create a blocker -- independent/ordering_preference pairs stay independent", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: a.id, depends_on_task_id: b.id, relationship: "ordering_preference" }),
      candidate({ task_id: a.id, depends_on_task_id: b.id, relationship: "independent" })
    ],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 0);
  assert.ok(result.rejected.every((item) => item.reason === "not_hard_dependency"));
});

test("validateDependencyCandidates: a below-threshold confidence never applies a dependency (conservative confidence policy)", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({
        task_id: a.id,
        depends_on_task_id: b.id,
        confidence: DEPENDENCY_CONFIDENCE_THRESHOLD - 0.01
      })
    ],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "below_confidence_threshold");
});

test("validateDependencyCandidates: exactly-at-threshold confidence is accepted", () => {
  const a = task();
  const b = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({
        task_id: a.id,
        depends_on_task_id: b.id,
        confidence: DEPENDENCY_CONFIDENCE_THRESHOLD
      })
    ],
    tasks: [a, b]
  });
  assert.equal(result.accepted.length, 1);
});

test("validateDependencyCandidates: a Future Scope (non-committed) task can never become a dependency blocker, as either side of the edge", () => {
  const futureScopeTask = task({ execution_classification: "future_consideration" });
  const activeTask = task();
  const activeDependsOnFuture = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: activeTask.id, depends_on_task_id: futureScopeTask.id })
    ],
    tasks: [activeTask, futureScopeTask]
  });
  assert.equal(activeDependsOnFuture.accepted.length, 0);
  assert.equal(activeDependsOnFuture.rejected[0]?.reason, "not_eligible_status");

  const futureDependsOnActive = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: futureScopeTask.id, depends_on_task_id: activeTask.id })
    ],
    tasks: [activeTask, futureScopeTask]
  });
  assert.equal(futureDependsOnActive.accepted.length, 0);
  assert.equal(futureDependsOnActive.rejected[0]?.reason, "not_eligible_status");
});

test("validateDependencyCandidates: a dismissed task can never become a dependency blocker", () => {
  const dismissed = task({ status: "dismissed" });
  const active = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: active.id, depends_on_task_id: dismissed.id })],
    tasks: [active, dismissed]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "not_eligible_status");
});

test("validateDependencyCandidates: a completed task remains a valid dependency target (completing a prerequisite is expected to unblock its dependent, not remove the relationship)", () => {
  const completedPrerequisite = task({ status: "completed" });
  const dependent = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: dependent.id, depends_on_task_id: completedPrerequisite.id })
    ],
    tasks: [dependent, completedPrerequisite]
  });
  assert.equal(result.accepted.length, 1);
});

test("validateDependencyCandidates: a task whose dependencies a human already manually set is never overwritten by AI (manual override wins)", () => {
  const locked = task();
  const other = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: locked.id, depends_on_task_id: other.id, confidence: 0.99 })],
    tasks: [locked, other],
    lockedTaskIds: new Set([locked.id])
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "locked_task");
});

test("validateDependencyCandidates: a locked task remains a valid target for OTHER tasks' dependencies -- locking only protects its own outgoing edge", () => {
  const locked = task();
  const dependent = task();
  const result = validateDependencyCandidates({
    candidates: [candidate({ task_id: dependent.id, depends_on_task_id: locked.id })],
    tasks: [locked, dependent],
    lockedTaskIds: new Set([locked.id])
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.depends_on_task_id, locked.id);
});

test("validateDependencyCandidates: at most one AI dependency per task -- the higher-confidence candidate wins when the model proposes two prerequisites for the same task", () => {
  const dependent = task();
  const prereqA = task();
  const prereqB = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: dependent.id, depends_on_task_id: prereqA.id, confidence: 0.86 }),
      candidate({ task_id: dependent.id, depends_on_task_id: prereqB.id, confidence: 0.97 })
    ],
    tasks: [dependent, prereqA, prereqB]
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.depends_on_task_id, prereqB.id);
});

test("validateDependencyCandidates: an empty candidate list always yields an empty accepted list, regardless of task owner/due-date data -- nothing is ever synthesized from owner or due-date alone", () => {
  const sameOwnerEarlier = task({ owner: "Aditya", due_date: "2026-01-01" });
  const sameOwnerLater = task({ owner: "Aditya", due_date: "2026-03-01" });
  const differentOwner = task({ owner: "Craig", due_date: "2025-12-01" });
  const result = validateDependencyCandidates({
    candidates: [],
    tasks: [sameOwnerEarlier, sameOwnerLater, differentOwner]
  });
  assert.deepEqual(result, { accepted: [], rejected: [] });
});

test("validateDependencyCandidates: owner match/mismatch does not change acceptance -- the same otherwise-valid candidate is accepted whether tasks share an owner or not", () => {
  const sameOwnerA = task({ owner: "Aditya" });
  const sameOwnerB = task({ owner: "Aditya" });
  const sharedOwnerResult = validateDependencyCandidates({
    candidates: [candidate({ task_id: sameOwnerA.id, depends_on_task_id: sameOwnerB.id })],
    tasks: [sameOwnerA, sameOwnerB]
  });
  assert.equal(sharedOwnerResult.accepted.length, 1);

  const differentOwnerA = task({ owner: "Aditya" });
  const differentOwnerB = task({ owner: "Craig" });
  const differentOwnerResult = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: differentOwnerA.id, depends_on_task_id: differentOwnerB.id })
    ],
    tasks: [differentOwnerA, differentOwnerB]
  });
  assert.equal(differentOwnerResult.accepted.length, 1);
});

test("validateDependencyCandidates: due-date ordering does not change acceptance -- an otherwise-identical candidate is accepted the same way whether the dependent's due date is earlier or later than the prerequisite's", () => {
  const earlierDueDependent = task({ due_date: "2026-01-01" });
  const laterDuePrerequisite = task({ due_date: "2026-06-01" });
  const inverted = validateDependencyCandidates({
    candidates: [
      candidate({
        task_id: earlierDueDependent.id,
        depends_on_task_id: laterDuePrerequisite.id
      })
    ],
    tasks: [earlierDueDependent, laterDuePrerequisite]
  });
  assert.equal(inverted.accepted.length, 1);
});

// ============================================================
// 4. Context building (targeted, not full-transcript)
// ============================================================

test("buildDependencyInferenceContext: includes commitment, task fields, and only the relevant deduplicated topic excerpts", () => {
  const shopify = commitment();
  const accountTask = task({
    task: "Create the account needed for the Shopify website",
    topic_id: "topic-a",
    source_quote: "Once J operates the account, Aditya can start building the website."
  });
  const buildTask = task({
    task: "Begin building the Shopify website after the plan is selected",
    topic_id: "topic-a"
  });
  const context = buildDependencyInferenceContext({
    commitment: shopify,
    tasks: [accountTask, buildTask],
    meetingContextByTopicId: new Map([
      ["topic-a", "J: Once I set up the account, Aditya can start building the site."],
      ["topic-unrelated", "This should never appear -- no task here belongs to this topic."]
    ])
  });
  assert.equal(context.commitment.title, "Build the Shopify website");
  assert.equal(context.tasks.length, 2);
  assert.equal(context.tasks[0].id, accountTask.id);
  assert.equal(context.tasks[0].source_quote, accountTask.source_quote);
  // Both tasks share topic-a -- its excerpt appears exactly once, not duplicated per task.
  assert.deepEqual(context.meeting_context, [
    "J: Once I set up the account, Aditya can start building the site."
  ]);
});

// ============================================================
// 5. Shopify fixture (section 26) -- exercises context building + validation together against
// the exact scenario from the brief. The live OpenAI call is not exercised here (no network in
// tests, consistent with every other OpenAI-calling function in this repo); this simulates a
// plausible, correctly-conservative model response and proves the deterministic layers handle
// it as intended: one real blocker applied, no dependencies invented among the content tasks.
// ============================================================

test("Shopify fixture: 'Begin building the website' depends on 'Create the account', with no dependency forced among the content tasks", () => {
  const shopify = commitment({ title: "Build the Shopify website" });
  const researchPlan = task({ task: "Research Shopify plans and recommend an affordable suitable plan" });
  const createAccount = task({
    task: "Create the account needed for the Shopify website",
    source_quote: "Once the account is set up, we can start building the site."
  });
  const beginBuilding = task({ task: "Begin building the Shopify website after the plan is selected" });
  const useFaq = task({ task: "Use an FAQ section instead of the chatbot" });
  const testimonial = task({ task: "Provide Aditya's testimonial and picture for the website" });
  const proteinOrigin = task({ task: "Add the protein-origin and production-story page" });
  const allTasks = [researchPlan, createAccount, beginBuilding, useFaq, testimonial, proteinOrigin];

  const context = buildDependencyInferenceContext({
    commitment: shopify,
    tasks: allTasks,
    meetingContextByTopicId: new Map()
  });
  assert.equal(context.tasks.length, 6);

  // A plausible, conservative model response: the one genuine blocker at high confidence, and
  // nothing else -- content tasks (FAQ, testimonial, protein-origin) are correctly omitted since
  // no supporting evidence makes them prerequisites of anything.
  const simulatedModelOutput: DependencyCandidate[] = [
    candidate({
      task_id: beginBuilding.id,
      depends_on_task_id: createAccount.id,
      confidence: 0.93,
      reason: "The website cannot be built before the Shopify account exists.",
      evidence: createAccount.source_quote ?? ""
    })
  ];

  const result = validateDependencyCandidates({
    candidates: simulatedModelOutput,
    tasks: allTasks
  });

  assert.deepEqual(result.accepted, [
    {
      task_id: beginBuilding.id,
      depends_on_task_id: createAccount.id,
      confidence: 0.93,
      reason: "The website cannot be built before the Shopify account exists."
    }
  ]);

  const dependentTaskIds = new Set(result.accepted.map((edge) => edge.task_id));
  assert.equal(dependentTaskIds.has(useFaq.id), false);
  assert.equal(dependentTaskIds.has(testimonial.id), false);
  assert.equal(dependentTaskIds.has(proteinOrigin.id), false);
  assert.equal(dependentTaskIds.has(researchPlan.id), false);
});

test("Shopify fixture: an over-eager model response linking content tasks together is rejected by the confidence floor when it isn't genuinely certain", () => {
  const useFaq = task({ task: "Use an FAQ section instead of the chatbot" });
  const testimonial = task({ task: "Provide Aditya's testimonial and picture for the website" });
  const speculative: DependencyCandidate[] = [
    candidate({
      task_id: testimonial.id,
      depends_on_task_id: useFaq.id,
      relationship: "hard_dependency",
      confidence: 0.6,
      reason: "They are both website content tasks.",
      evidence: ""
    })
  ];
  const result = validateDependencyCandidates({
    candidates: speculative,
    tasks: [useFaq, testimonial]
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "below_confidence_threshold");
});

// ============================================================
// 6. UI/route wiring regression coverage (golden-source pattern, no DOM/RTL harness in this
// repo -- see task-owner-select/task-deliverable-lifecycle tests for the same convention).
// ============================================================

test("commitment workspace: a completed prerequisite stops blocking its dependent (existing blocker semantics preserved, not replaced by a second system)", async () => {
  const source = await readFile(
    new URL("../components/commitment-workspace.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /candidate\.status !== "completed"/);
});

test("commitment workspace: the AI-inferred label only shows while the task's dependency is still AI-authored, and never relabels the existing manual picker", async () => {
  const source = await readFile(
    new URL("../components/commitment-workspace.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /function isAiInferredDependency/);
  assert.match(source, /manual_override_fields\.includes\("dependencies"\)/);
  assert.match(source, /AI inferred/);
});

test("manual dependency route: saving a dependency (including clearing it) marks the task as manually overridden so AI inference never recreates it", async () => {
  const source = await readFile(
    new URL("../app/api/tasks/[id]/dependencies/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /mergeManualOverrideFields\(\s*task\.manual_override_fields,\s*\["dependencies"\]\s*\)/);
  assert.match(source, /preserve_on_reanalysis: true/);
});

test("commitment correction menu: 'Re-evaluate dependencies' is a secondary overflow action, not a primary CTA, and reuses the shared inference core via the API route", async () => {
  const source = await readFile(
    new URL("../components/commitment-correction-menu.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /Re-evaluate dependencies/);
  assert.match(source, /\/api\/commitments\/\$\{commitment\.id\}\/dependencies\/infer/);
});

test("dependency inference route: reuses the canonical replace_task_dependencies RPC, never a second write path", async () => {
  const source = await readFile(
    new URL("../lib/task-dependency-inference.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /supabaseAdmin\.rpc\("replace_task_dependencies"/);
  assert.doesNotMatch(source, /\.from\("task_dependencies"\)\s*\n?\s*\.insert/);
});
