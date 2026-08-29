import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveCompletedAtPatch,
  TASK_STATUS_LABELS,
  TASK_WORKSPACE_STATUS_OPTIONS,
  updateTaskSchema
} from "../lib/task-status";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenario 2] Dropdown contains exactly the 5 legitimate states
// ---------------------------------------------------------------------------

test("TASK_WORKSPACE_STATUS_OPTIONS contains exactly pending, in_progress, completed, blocked, dismissed", () => {
  assert.deepEqual(TASK_WORKSPACE_STATUS_OPTIONS, [
    "pending",
    "in_progress",
    "completed",
    "blocked",
    "dismissed"
  ]);
});

test("every status has a user-friendly label, and Completed is visually marked positive", () => {
  assert.deepEqual(TASK_STATUS_LABELS, {
    pending: "Pending",
    in_progress: "In Progress",
    completed: "✓ Completed",
    blocked: "Blocked",
    dismissed: "Dismissed"
  });
});

// ---------------------------------------------------------------------------
// [required scenarios 3-8] Specific transitions persist via the same schema/route
// ---------------------------------------------------------------------------

test("[scenario 3] pending -> in_progress is a valid status update", () => {
  const result = updateTaskSchema.safeParse({ status: "in_progress" });
  assert.equal(result.success, true);
});

test("[scenario 4] in_progress -> completed is a valid status update", () => {
  const result = updateTaskSchema.safeParse({ status: "completed" });
  assert.equal(result.success, true);
});

test("[scenario 5] pending -> blocked is a valid status update", () => {
  const result = updateTaskSchema.safeParse({ status: "blocked" });
  assert.equal(result.success, true);
});

test("[scenario 6] pending -> dismissed is a valid status update (dismissal is a normal lifecycle choice here)", () => {
  const result = updateTaskSchema.safeParse({ status: "dismissed" });
  assert.equal(result.success, true);
});

test("[scenario 7] completed -> in_progress (reopening) is a valid status update", () => {
  const result = updateTaskSchema.safeParse({ status: "in_progress" });
  assert.equal(result.success, true);
  // Reopening clears completed_at exactly like any other non-completed transition.
  assert.deepEqual(deriveCompletedAtPatch("in_progress"), { completed_at: null });
});

test("[scenario 8] dismissed -> pending (reopening) is a valid status update", () => {
  const result = updateTaskSchema.safeParse({ status: "pending" });
  assert.equal(result.success, true);
  assert.deepEqual(deriveCompletedAtPatch("pending"), { completed_at: null });
});

// ---------------------------------------------------------------------------
// [required scenario 9] invalid status values are rejected
// ---------------------------------------------------------------------------

test("[scenario 9] an invalid status value is rejected by the schema", () => {
  const result = updateTaskSchema.safeParse({ status: "archived" });
  assert.equal(result.success, false);
});

test("[scenario 9] the schema is a strict allowlist -- an unrelated/arbitrary field is rejected outright", () => {
  const result = updateTaskSchema.safeParse({ status: "completed", is_deleted: true });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// [required scenario 11] completed_at set/cleared
// ---------------------------------------------------------------------------

test("[scenario 11] completed_at is set to now() when status becomes completed", () => {
  const patch = deriveCompletedAtPatch("completed", () => "2026-08-29T12:00:00.000Z");
  assert.deepEqual(patch, { completed_at: "2026-08-29T12:00:00.000Z" });
});

test("[scenario 11] completed_at is cleared for every non-completed status", () => {
  for (const status of ["pending", "in_progress", "blocked", "dismissed"] as const) {
    assert.deepEqual(deriveCompletedAtPatch(status), { completed_at: null }, status);
  }
});

test("[scenario 11] completed_at is left untouched when a patch doesn't change status at all", () => {
  assert.deepEqual(deriveCompletedAtPatch(undefined), {});
});

// ---------------------------------------------------------------------------
// API route: reused mutation path, ownership, manual-override/reanalysis safety
// ---------------------------------------------------------------------------

test("the task update route reuses the single existing PATCH /api/tasks/[id] path -- no second mutation route was introduced", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  assert.match(source, /export async function PATCH\(/);
  assert.doesNotMatch(source, /export async function (POST|PUT|DELETE)\(/);
  assert.match(source, /import \{ deriveCompletedAtPatch, updateTaskSchema \} from "@\/lib\/task-status";/);
});

test("[required scenario 12] the route enforces ownership via the existing getOwnedTask authorization check before any mutation", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  assert.match(source, /const auth = await requireApiUser\(\);/);
  assert.match(source, /const task = await getOwnedTask\(id, auth\.user\.id\);/);
  assert.match(source, /if \(!task\) \{\s*return NextResponse\.json\(\{ error: "Task not found\." \}, \{ status: 404 \}\);/);
});

test("[required scenario 10] a status update is persisted through the existing manual_override_fields / preserve_on_reanalysis mechanism, not a new one", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  assert.match(source, /import \{ mergeManualOverrideFields \} from "@\/lib\/manual-overrides";/);
  assert.match(source, /preserve_on_reanalysis: true/);
  assert.match(
    source,
    /manual_override_fields: mergeManualOverrideFields\(\s*task\.manual_override_fields,\s*Object\.keys\(parsed\.data\)\s*\)/
  );
  assert.match(source, /\.\.\.deriveCompletedAtPatch\(parsed\.data\.status\)/);
});

test("[required scenario 14/15] the update route touches only meeting_tasks -- no cascading writes to commitments or other tasks", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  const tableRefs = [...source.matchAll(/supabaseAdmin\s*\n?\s*\.from\("(\w+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(tableRefs), new Set(["meeting_tasks"]));
});

test("dismissing a task never deletes it or clears its meeting/commitment relationship -- the update payload is a plain field patch, not a delete", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  assert.doesNotMatch(source, /\.delete\(\)/);
  assert.doesNotMatch(source, /commitment_id:\s*null/);
  assert.doesNotMatch(source, /meeting_id:/);
});

// ---------------------------------------------------------------------------
// Component: single dropdown is the whole lifecycle control (no separate button)
// ---------------------------------------------------------------------------

test("[required scenario 1] the Task Workspace header binds the status dropdown's value to the persisted task status", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.match(source, /aria-label="Task status"/);
  assert.match(source, /value=\{task\.status\}/);
});

test("there is no separate 'Mark as completed' button -- the dropdown is the sole lifecycle control", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.doesNotMatch(source, /Mark as completed/);
  assert.doesNotMatch(source, /premium-button/);
});

test("the status dropdown offers exactly the 5 workspace statuses with friendly labels, visually distinguished per status", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.match(source, /import \{ TASK_STATUS_LABELS, TASK_WORKSPACE_STATUS_OPTIONS \} from "@\/lib\/task-status";/);
  assert.match(source, /TASK_WORKSPACE_STATUS_OPTIONS\.map\(\(status\) => \(/);
  assert.match(source, /\{TASK_STATUS_LABELS\[status\]\}/);
  // Reuses the existing status-color system (pending/in_progress/blocked/completed/dismissed all
  // map to distinct, already-established colors) rather than inventing new visual language.
  assert.match(source, /statusBadgeClassName\(task\.status\)/);
});

test("[required scenario 13] a failed status update rolls back to the previous task and surfaces an error instead of leaving a false status", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  const fnMatch = source.match(/async function saveStatus\([\s\S]*?\n  \}\n/);
  assert.ok(fnMatch, "expected a saveStatus function");
  const fn = fnMatch![0];
  assert.match(fn, /const previousTask = task;/);
  assert.match(fn, /if \(!response\.ok \|\| !result\.task\) \{\s*setTask\(previousTask\);\s*setStatusError\(/);
  assert.match(fn, /\} catch \{\s*setTask\(previousTask\);\s*setStatusError\(/);
});

test("the dropdown disables itself while a change is in flight, preventing a second overlapping request", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.match(source, /disabled=\{savingStatus\}/);
});

test("selecting the already-current status is a no-op and never fires a request", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.match(source, /if \(nextStatus === task\.status\) return;/);
});

test("router.refresh() runs after a successful status change, matching the app's existing mutation pattern", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  const fnMatch = source.match(/async function saveStatus\([\s\S]*?\n  \}\n/);
  assert.match(fnMatch![0], /router\.refresh\(\);/);
});

test("completed_at is set optimistically and cleared on reopen in the same client-side transition", async () => {
  const source = await readSource("components/task-workspace-task-state.tsx");
  assert.match(
    source,
    /completed_at: nextStatus === "completed" \? new Date\(\)\.toISOString\(\) : null/
  );
});

// ---------------------------------------------------------------------------
// [required scenario 16] downstream consumers stay compatible
// ---------------------------------------------------------------------------

test("[required scenario 16] MeetingTask carries completed_at so every existing consumer reading task rows sees it without new sync logic", async () => {
  const typesSource = await readSource("lib/types.ts");
  const taskInterface = typesSource.match(/export interface MeetingTask \{[\s\S]*?\n\}/);
  assert.ok(taskInterface);
  assert.match(taskInterface![0], /completed_at\?: string \| null;/);
});

test("[required scenario 16] Project Brain's structured task context already selects status, so it naturally reflects a completed/dismissed/blocked task with no new Brain logic", async () => {
  const source = await readSource("lib/project-brain/context.ts");
  assert.match(
    source,
    /"id,commitment_id,task,workspace_summary,owner,owners,due_date,priority,status,position,inferred,manual_override_fields,preserve_on_reanalysis,meeting_id,extraction_metadata,created_at"/
  );
});

test("the completed_at migration only adds a nullable column -- no backfill, no unrelated schema change", async () => {
  const migration = await readSource(
    "supabase/migrations/20260829150000_add_task_completed_at.sql"
  );
  assert.match(
    migration,
    /alter table public\.meeting_tasks\s*\nadd column if not exists completed_at timestamptz;/
  );
  assert.doesNotMatch(migration, /^update /im);
  assert.doesNotMatch(migration, /^insert /im);
});
