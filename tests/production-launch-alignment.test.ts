import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260818231713_production_launch_alignment.sql",
  import.meta.url
);

const legacyTables = [
  "extracted_insights",
  "generated_prompts",
  "meeting_artifacts",
  "meeting_speaker_aliases",
  "meeting_tasks",
  "meeting_topics",
  "meetings",
  "profiles",
  "task_artifacts",
  "task_comments",
  "transcript_segments"
];

const launchTables = [
  "account_verification_events",
  "user_integrations",
  "projects",
  "meeting_commitments",
  "meeting_analysis_jobs",
  "meeting_conversation_events",
  "task_dependencies",
  "commitment_participants",
  "commitment_comments",
  "meeting_comments",
  "project_memory",
  "project_requirements",
  "project_decisions",
  "project_constraints",
  "project_participants",
  "project_chat_threads",
  "project_chat_messages",
  "project_change_proposals",
  "project_change_events"
];

test("Production alignment creates every audited launch table and no migration bookkeeping", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const table of launchTables) {
    assert.match(sql, new RegExp(`create table public\\.${table}\\b`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.doesNotMatch(sql, /supabase_migrations/);
});

test("Production alignment rejects any mismatch from the required legacy catalog before DDL", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const precondition = sql.match(/do \$\$[\s\S]*?\$\$;/)?.[0];
  assert.ok(precondition);
  assert.ok(sql.indexOf(precondition) < sql.indexOf("alter table public.profiles"));

  for (const table of legacyTables) {
    assert.match(precondition, new RegExp(`'${table}'`));
  }
  for (const column of [
    "id", "meeting_id", "topic_id", "task", "owner", "task_type", "priority",
    "suggested_steps", "source_quote", "confidence", "status", "created_at",
    "workspace_type", "workspace_summary", "due_date", "rationale",
    "supporting_context", "categorization_metadata"
  ]) {
    assert.match(precondition, new RegExp(`'${column}'`));
  }

  assert.match(precondition, /type_row\.typname = 'meeting_status'/);
  assert.match(precondition, /enum_row\.enumlabel = 'transcript_ready'/);
  assert.match(precondition, /meeting_tasks_topic_id_fkey/);
  assert.match(precondition, /constraint_row\.confdeltype = 'c'/);
  assert.match(precondition, /meeting_tasks_status_check/);
  assert.match(precondition, /meeting_tasks_dedupe_idx/);
  assert.match(precondition, /index_row\.indisunique/);

  assert.match(sql, /alter table public\.meeting_tasks drop constraint meeting_tasks_topic_id_fkey;/);
  assert.match(sql, /alter table public\.meeting_tasks drop constraint meeting_tasks_status_check;/);
  assert.match(sql, /drop index public\.meeting_tasks_dedupe_idx;/);
  assert.doesNotMatch(sql, /drop constraint if exists meeting_tasks_(?:topic_id_fkey|status_check)/);
  assert.doesNotMatch(sql, /drop index if exists public\.meeting_tasks_dedupe_idx/);
});

test("Production alignment protects only genuine legacy task fields", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /update public\.meeting_tasks\s+set preserve_on_reanalysis = true,\s+manual_override_fields = '\["status","owner","due_date"\]'::jsonb;/
  );
  assert.doesNotMatch(
    sql,
    /manual_override_fields = '\["status","owner","owners","due_date","due_date_text"\]'::jsonb/
  );
});

test("Production alignment person correction is speaker-independent", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const personSql = sql.match(
    /-- Speaker-independent atomic project-person correction\.[\s\S]*?(?=-- Atomic dependency provenance wrapper\.)/
  )?.[0];
  assert.ok(personSql);
  assert.doesNotMatch(personSql, /speaker_alias|meeting_speaker_aliases/);
  assert.match(
    personSql,
    /'task', 'commitment', 'project_participant', 'commitment_participant'/
  );
  assert.doesNotMatch(personSql, /update public\.transcript_segments/);
});

test("Production alignment establishes explicit table and function ACL boundaries", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const tableAclSql = sql.match(
    /-- Remove all automatic\/default table privileges first[\s\S]*?(?=-- Trigger-only functions)/
  )?.[0];
  assert.ok(tableAclSql);
  const revokeIndex = tableAclSql.indexOf("revoke all on table");
  const grantIndex = tableAclSql.indexOf("grant select, insert, update, delete on table");
  assert.ok(revokeIndex >= 0 && revokeIndex < grantIndex);
  assert.match(
    tableAclSql,
    /revoke all on table[\s\S]*from public, anon, authenticated, service_role;/
  );
  assert.match(
    tableAclSql,
    /grant select, insert, update, delete on table[\s\S]*to anon, authenticated, service_role;/
  );
  assert.doesNotMatch(tableAclSql, /grant all/);
  for (const table of launchTables) {
    const occurrenceCount: number = (
      tableAclSql.match(new RegExp(`public\\.${table}\\b`, "g")) ?? []
    ).length;
    assert.equal(occurrenceCount, 2, `${table} must appear in both REVOKE and GRANT lists`);
  }
  assert.match(
    sql,
    /revoke all on function public\.handle_new_auth_user\(\) from public, anon, authenticated, service_role;/
  );
  assert.match(
    sql,
    /grant execute on function public\.can_access_project\(uuid\) to authenticated, service_role;/
  );
  assert.match(
    sql,
    /grant execute on function public\.apply_project_person_correction\(uuid, uuid, jsonb\) to service_role;/
  );
});
