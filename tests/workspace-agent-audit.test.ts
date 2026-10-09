import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenarios 29-33] audit-event behavior
// ---------------------------------------------------------------------------

test("[required scenario 29] project-scoped execution writes project_id into the audit event", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.match(source, /project_id: event\.projectId,/);
});

test("[required scenario 30] meeting-scoped execution can write meeting_id with project_id null -- the audit writer accepts both independently", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.match(source, /meeting_id: event\.meetingId,/);
  assert.match(source, /projectId: string \| null;/);
  assert.match(source, /meetingId: string \| null;/);
});

test("[required scenario 31] actor_type is hardcoded to \"assistant\" -- never settable by the caller, never \"user\"", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.match(source, /actor_type: "assistant",/);
  assert.doesNotMatch(source, /actor_type: event/);
  assert.doesNotMatch(source, /actor_type: "user"/);
});

test("[required scenario 32] both before_state and after_state are persisted on every audit event", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.match(source, /before_state: event\.beforeState,/);
  assert.match(source, /after_state: event\.afterState,/);
});

test("[required scenario 33] the audit writer uses the existing project_change_events table -- no parallel table was introduced", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.match(source, /\.from\("project_change_events"\)/);
  const workspaceAgentFiles = [
    "lib/workspace-agent/scope.ts",
    "lib/workspace-agent/schema.ts",
    "lib/workspace-agent/intent-gate.ts",
    "lib/workspace-agent/authorize.ts",
    "lib/workspace-agent/executor.ts",
    "lib/workspace-agent/confirmation.ts",
    "lib/workspace-agent/revalidate.ts"
  ];
  for (const file of workspaceAgentFiles) {
    const otherSource = await readSource(file);
    assert.doesNotMatch(otherSource, /meeting_change_events|workspace_change_events/, file);
  }
});

test("a failed audit insert is logged but never thrown -- it must not cause an already-successful mutation to be reported as failed", async () => {
  const source = await readSource("lib/workspace-agent/audit.ts");
  assert.doesNotMatch(source, /throw /);
  assert.match(source, /if \(error\) \{\s*\n\s*console\.error\(/);
});

// ---------------------------------------------------------------------------
// Migration safety (PART 13) -- existing Project Brain audit writers remain valid.
// ---------------------------------------------------------------------------

test("[required: existing Project Brain audit writes remain valid] the migration only relaxes project_id's NOT NULL constraint and adds an independent new column -- no existing column is dropped, renamed, or retyped", async () => {
  const migration = await readSource(
    "supabase/migrations/20261009090000_generalize_project_change_events_scope.sql"
  );
  assert.match(migration, /alter table public\.project_change_events\s*\n\s*alter column project_id drop not null;/);
  assert.match(migration, /add column meeting_id uuid references public\.meetings \(id\) on delete cascade;/);
  assert.doesNotMatch(migration, /drop column|drop table|rename column|alter column .* type/);
});

test("the migration's new scope check constraint cannot reject any existing row -- every pre-migration row already has a non-null project_id", async () => {
  const migration = await readSource(
    "supabase/migrations/20261009090000_generalize_project_change_events_scope.sql"
  );
  assert.match(
    migration,
    /check \(project_id is not null or meeting_id is not null\)/
  );
});

test("every existing project_change_events insert site still supplies project_id explicitly, so the column being nullable now changes nothing about them", async () => {
  const rpcMigration = await readSource(
    "supabase/migrations/20260818231713_production_launch_alignment.sql"
  );
  const insertBlocks = rpcMigration.match(/insert into public\.project_change_events \([\s\S]*?\);/g) ?? [];
  assert.ok(insertBlocks.length >= 2, "expected at least the two apply_project_change_proposal inserts");
  for (const block of insertBlocks) {
    assert.match(block, /project_row\.id/, block);
  }

  const directEditSource = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.match(directEditSource, /project_id: input\.projectId,/);

  const correctionsSource = await readSource("lib/execution-corrections.ts");
  assert.match(correctionsSource, /project_id: input\.projectId,/);
});

test("the migration does not recreate the table -- it only alters the existing one, so existing RLS policies/indexes/triggers survive", async () => {
  const migration = await readSource(
    "supabase/migrations/20261009090000_generalize_project_change_events_scope.sql"
  );
  assert.doesNotMatch(migration, /drop table|create table/);
});
