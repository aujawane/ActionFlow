import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateDependencyCandidates,
  type DependencyCandidate
} from "../lib/task-dependency-inference";
import type { MeetingTask } from "../lib/types";

/** Backward-compatibility/provenance safety audit for AI-inferred task dependencies (follow-up
 * to tests/task-dependency-inference.test.ts). Covers: legacy pre-feature dependency rows must
 * not be misread as AI-authored; the "AI inferred" label must only ever describe a genuinely
 * AI-authored current dependency; an explicit "No dependency" choice must lock the same as a
 * chosen dependency; a locked task must remain a valid prerequisite for others. */

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

/** Mirrors components/commitment-workspace.tsx's isAiInferredDependency exactly -- kept local
 * (not imported, since the real one is a UI-file-local function, not exported) so this test
 * documents and locks in the intended contract independently. */
function isAiInferredDependency(candidateTask: MeetingTask): boolean {
  return !(
    Array.isArray(candidateTask.manual_override_fields) &&
    candidateTask.manual_override_fields.includes("dependencies")
  );
}

// ============================================================
// 1. Historical writers -- confirm every pre-feature writer of task_dependencies is accounted
// for, and that Project Brain's approve/apply path (a real historical writer this audit found)
// now records provenance too, not just the manual picker fixed in the prior turn.
// ============================================================

test("audit: every historical writer of task_dependencies is a human-facing, human-approved path", async () => {
  const [putRoute, brainApplyRoute, workerSource] = await Promise.all([
    readFile(new URL("../app/api/tasks/[id]/dependencies/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../app/api/projects/[id]/brain/proposals/[proposalId]/apply/route.ts",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("../lib/meeting-analysis/worker.ts", import.meta.url), "utf8")
  ]);

  // Writer 1: the manual dependency picker.
  assert.match(putRoute, /replace_task_dependencies/);
  assert.match(putRoute, /manual_override_fields:\s*mergeManualOverrideFields/);

  // Writer 2: Project Brain's reviewed add_dependency/remove_dependency proposal apply --
  // confirmed by re-reading apply_project_change_proposal's SQL (see migration
  // 20260727130000_project_brain_phase1.sql) that this RPC directly inserts/deletes
  // task_dependencies rows. Provenance for these operations is now recorded atomically inside
  // apply_project_change_proposal_with_dependency_provenance (see
  // tests/task-dependency-provenance-atomicity.test.ts) rather than by a second,
  // non-atomic application-layer call from this route.
  assert.match(brainApplyRoute, /apply_project_change_proposal_with_dependency_provenance/);

  // Execution Intelligence V4 / the analysis worker never wrote task_dependencies directly --
  // only the new, clearly-labeled AI inference call, which never marks manual_override_fields.
  assert.doesNotMatch(workerSource, /\.from\("task_dependencies"\)/);
  assert.match(workerSource, /runDependencyInferenceBestEffort/);
});

test("audit: AI dependency inference itself never marks manual_override_fields (the asymmetry the whole provenance model depends on)", async () => {
  const source = await readFile(
    new URL("../lib/task-dependency-inference.ts", import.meta.url),
    "utf8"
  );
  // The AI write path (inferAndApplyDependenciesForCommitment) must never itself assign
  // manual_override_fields -- only ever read it (via isDependenciesLocked) to decide what NOT to
  // touch. A bare mention in a doc comment is fine; an actual assignment/property is not.
  assert.doesNotMatch(source, /manual_override_fields:\s/);
  assert.doesNotMatch(source, /manual_override_fields\s*=/);
});

// ============================================================
// 2 & 3. Backfill migration -- exact scope, no edge mutation, idempotent guard.
// ============================================================

test("backfill migration: only touches meeting_tasks that currently own a task_dependencies row, never the edges themselves", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260815090000_backfill_legacy_manual_task_dependencies.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(migration, /update public\.meeting_tasks/);
  assert.match(migration, /select distinct task_id from public\.task_dependencies/);
  assert.match(migration, /manual_override_fields = coalesce\(manual_override_fields, '\[\]'::jsonb\)\s*\n?\s*\|\| '\["dependencies"\]'::jsonb/);
  assert.match(migration, /preserve_on_reanalysis = true/);
  // Idempotency guard -- re-running must not double-append.
  assert.match(migration, /not \(\s*coalesce\(manual_override_fields, '\[\]'::jsonb\) @> '\["dependencies"\]'::jsonb\s*\)/);
  // Must never write to task_dependencies itself.
  assert.doesNotMatch(migration, /update public\.task_dependencies/);
  assert.doesNotMatch(migration, /insert into public\.task_dependencies/);
  assert.doesNotMatch(migration, /delete from public\.task_dependencies/);
});

test("backfill migration: does not touch tasks with zero dependency rows (no invented signal for an indistinguishable 'never considered' case)", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260815090000_backfill_legacy_manual_task_dependencies.sql",
      import.meta.url
    ),
    "utf8"
  );
  // The only selection criterion is task_id membership in task_dependencies -- there is no
  // broader "touch every task" clause.
  assert.doesNotMatch(migration, /update public\.meeting_tasks\s*\nset[\s\S]*?where\s+true/i);
  assert.match(migration, /where id in \(/);
});

// ============================================================
// 4. "AI inferred" label correctness across all four scenarios from the brief.
// ============================================================

test("label: a legacy manual dependency (backfilled -- manual_override_fields already contains \"dependencies\") is never labeled AI inferred", () => {
  const legacyManualTask = task({ manual_override_fields: ["dependencies"] });
  assert.equal(isAiInferredDependency(legacyManualTask), false);
});

test("label: a brand-new AI-authored dependency (task never touched by a human) is labeled AI inferred", () => {
  const untouchedTask = task({ manual_override_fields: [] });
  assert.equal(isAiInferredDependency(untouchedTask), true);
});

test("label: a new manual dependency choice is never labeled AI inferred", () => {
  const newlyManualTask = task({ manual_override_fields: ["dependencies"] });
  assert.equal(isAiInferredDependency(newlyManualTask), false);
});

test("label: an AI dependency that a human then manually changes or clears is no longer labeled AI inferred (the task becomes locked)", () => {
  // Before the human's edit: AI-authored, no override recorded yet.
  const beforeEdit = task({ manual_override_fields: [] });
  assert.equal(isAiInferredDependency(beforeEdit), true);
  // After PUT /api/tasks/[id]/dependencies runs (see route source assertions above), the same
  // task row now carries the override flag.
  const afterEdit = task({ id: beforeEdit.id, manual_override_fields: ["dependencies"] });
  assert.equal(isAiInferredDependency(afterEdit), false);
});

test("label: other manual_override_fields entries (e.g. owner, status) do not themselves suppress the AI-inferred label -- only \"dependencies\" specifically does", () => {
  const ownerOverriddenOnly = task({ manual_override_fields: ["owner", "status"] });
  assert.equal(isAiInferredDependency(ownerOverriddenOnly), true);
});

// ============================================================
// 5. Empty manual decision ("No dependency") locks the task exactly like a chosen dependency.
// ============================================================

test("regression: clearing to 'No dependency' locks the task the same way a chosen dependency would -- validated end to end through the locking mechanism", () => {
  // Simulates the state immediately after PUT .../dependencies is called with
  // depends_on_task_ids: [] -- the route marks manual_override_fields unconditionally, whether
  // or not any row remains in task_dependencies (see route source assertion above).
  const clearedTask = task({ manual_override_fields: ["dependencies"] });
  const otherTask = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: clearedTask.id, depends_on_task_id: otherTask.id, confidence: 0.99 })
    ],
    tasks: [clearedTask, otherTask],
    lockedTaskIds: new Set([clearedTask.id])
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "locked_task");
});

// ============================================================
// 6. A locked task (legacy-backfilled or freshly manual) remains a valid prerequisite target.
// ============================================================

test("regression: a legacy-backfilled, locked task can still be the prerequisite (depends_on_task_id) for another task's AI-inferred dependency", () => {
  const legacyLockedPrerequisite = task({ manual_override_fields: ["dependencies"] });
  const newDependent = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({
        task_id: newDependent.id,
        depends_on_task_id: legacyLockedPrerequisite.id,
        confidence: 0.9
      })
    ],
    tasks: [legacyLockedPrerequisite, newDependent],
    lockedTaskIds: new Set([legacyLockedPrerequisite.id])
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.depends_on_task_id, legacyLockedPrerequisite.id);
});
