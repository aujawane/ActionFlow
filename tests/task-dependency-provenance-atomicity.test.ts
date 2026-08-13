import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateDependencyCandidates,
  type DependencyCandidate
} from "../lib/task-dependency-inference";
import type { MeetingTask } from "../lib/types";

/** Transactional-integrity follow-up: Project Brain's add_dependency/remove_dependency approval
 * and the resulting manual-provenance marking must succeed or fail together. Real atomicity
 * (rollback-on-failure) is verified against local Postgres separately -- see the final report --
 * since that property genuinely cannot be proven by unit/golden-source tests alone. What's
 * covered here: the migration's exact shape, the API route's single-call wiring, and the
 * downstream inference behavior once provenance is marked. */

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

// ============================================================
// 1 & 2. The migration: one atomic wrapper, calling the untouched existing function, covering
// both add_dependency and remove_dependency.
// ============================================================

test("migration: adds a single atomic wrapper RPC that calls the existing, untouched apply_project_change_proposal", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260816090000_apply_project_change_proposal_dependency_provenance.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    migration,
    /create or replace function public\.apply_project_change_proposal_with_dependency_provenance/
  );
  assert.match(migration, /result := public\.apply_project_change_proposal\(/);
  // Service-role-only, matching every other write RPC in this codebase.
  assert.match(
    migration,
    /revoke all on function public\.apply_project_change_proposal_with_dependency_provenance\(uuid, uuid, jsonb\) from public/
  );
  assert.match(
    migration,
    /revoke all on function public\.apply_project_change_proposal_with_dependency_provenance\(uuid, uuid, jsonb\) from authenticated/
  );
  assert.match(
    migration,
    /grant execute on function public\.apply_project_change_proposal_with_dependency_provenance\(uuid, uuid, jsonb\) to service_role/
  );
});

test("migration: does NOT redefine or duplicate the ~800-line apply_project_change_proposal body", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260816090000_apply_project_change_proposal_dependency_provenance.sql",
      import.meta.url
    ),
    "utf8"
  );
  // The original function's own operation-type branches (e.g. update_project, create_milestone)
  // must not appear here -- this migration only calls the existing function, never reimplements
  // any part of it.
  assert.doesNotMatch(migration, /elsif operation_type = 'update_project'/);
  assert.doesNotMatch(migration, /elsif operation_type = 'create_milestone'/);
  const lineCount = migration.split("\n").length;
  assert.ok(lineCount < 100, `expected a small wrapper migration, got ${lineCount} lines`);
});

test("migration: both add_dependency and remove_dependency are treated as equally meaningful human decisions", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260816090000_apply_project_change_proposal_dependency_provenance.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(migration, /'add_dependency', 'remove_dependency'/);
  // A single shared update statement handles both -- not one branch per operation type.
  const updateOccurrences = migration.match(/update public\.meeting_tasks/g) ?? [];
  assert.equal(updateOccurrences.length, 1);
});

test("migration: only marks operations that were actually applied -- short-circuits on the stale/version-conflict result before touching any task", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260816090000_apply_project_change_proposal_dependency_provenance.sql",
      import.meta.url
    ),
    "utf8"
  );
  const staleCheckIndex = migration.indexOf("coalesce((result->>'stale')::boolean, false)");
  const returnStaleIndex = migration.indexOf("return result;", staleCheckIndex);
  const updateIndex = migration.indexOf("update public.meeting_tasks");
  assert.ok(staleCheckIndex > -1, "expected a stale-result check");
  assert.ok(
    staleCheckIndex < updateIndex,
    "the stale check must happen before any provenance update"
  );
  assert.ok(
    returnStaleIndex > staleCheckIndex && returnStaleIndex < updateIndex,
    "a stale result must return before reaching the provenance update"
  );
});

test("migration: idempotent -- only appends \"dependencies\" when not already present, and preserves existing unrelated override entries", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260816090000_apply_project_change_proposal_dependency_provenance.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    migration,
    /when coalesce\(manual_override_fields, '\[\]'::jsonb\) @> '\["dependencies"\]'::jsonb\s*\n\s*then coalesce\(manual_override_fields, '\[\]'::jsonb\)/
  );
  assert.match(migration, /else coalesce\(manual_override_fields, '\[\]'::jsonb\) \|\| '\["dependencies"\]'::jsonb/);
});

// ============================================================
// 3. API route: one authoritative call, old two-step application-layer logic removed.
// ============================================================

test("apply route: calls the atomic wrapper RPC exactly once, with no separate post-RPC provenance update", async () => {
  const route = await readFile(
    new URL(
      "../app/api/projects/[id]/brain/proposals/[proposalId]/apply/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(route, /apply_project_change_proposal_with_dependency_provenance/);
  // The old two-call pattern (a second .from("meeting_tasks").update(...) after the RPC) and its
  // import are both gone -- there is exactly one authoritative path now.
  assert.doesNotMatch(route, /mergeManualOverrideFields/);
  assert.doesNotMatch(route, /dependencyOperationTaskIds/);
  // The RPC name used must not be the bare, non-atomic function anymore for the normal apply path.
  assert.doesNotMatch(route, /rpc\("apply_project_change_proposal",/);
});

// ============================================================
// 4. Selected-operations-only -- unselected/rejected dependency operations, and non-dependency
// operations, must never mark provenance. (The wrapper only iterates p_operations, which the
// route already builds from exactly the operations the user selected/approved -- this documents
// that contract at the call site.)
// ============================================================

test("apply route: only the operations actually sent to the RPC (operationsForApply, built from the user's selection) can ever be marked -- unselected operations never reach the wrapper at all", async () => {
  const route = await readFile(
    new URL(
      "../app/api/projects/[id]/brain/proposals/[proposalId]/apply/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(route, /p_operations: operationsForApply/);
});

// ============================================================
// 5 & 9. Downstream: once provenance is marked (add, remove, or via Project Brain), AI
// dependency inference must skip that task -- same lockedTaskIds mechanism as the manual
// picker, proven here explicitly for the Project-Brain-originated case.
// ============================================================

test("AI inference skips a task whose dependency was set through Project Brain's add_dependency approval", () => {
  const brainLockedTask = task({ manual_override_fields: ["dependencies"] });
  const other = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: brainLockedTask.id, depends_on_task_id: other.id, confidence: 0.99 })
    ],
    tasks: [brainLockedTask, other],
    lockedTaskIds: new Set([brainLockedTask.id])
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "locked_task");
});

test("AI inference skips a task whose dependency was explicitly cleared through Project Brain's remove_dependency approval (zero edges, still locked)", () => {
  // After a Project Brain-approved removal, task_dependencies has no row for this task, but
  // manual_override_fields is the durable record that this is a deliberate decision, not an
  // unconsidered task.
  const clearedViaBrain = task({ manual_override_fields: ["dependencies"] });
  const other = task();
  const result = validateDependencyCandidates({
    candidates: [
      candidate({ task_id: clearedViaBrain.id, depends_on_task_id: other.id, confidence: 0.99 })
    ],
    tasks: [clearedViaBrain, other],
    lockedTaskIds: new Set([clearedViaBrain.id])
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "locked_task");
});
