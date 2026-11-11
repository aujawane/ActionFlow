import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Static checks on the Phase 1 migration text. Always run (no database). The behavioural check
// against real PostgreSQL lives in manual-transcript-import-migration-database.test.ts.

const MIGRATION = "supabase/migrations/20261111090000_add_manual_transcript_import_foundation.sql";

async function sqlStatements() {
  const raw = await readFile(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
  const sql = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return sql
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

test("the migration is exactly the four approved changes plus column comments", async () => {
  const statements = await sqlStatements();
  assert.deepEqual(statements, [
    "alter table public.meetings alter column meeting_url drop not null",
    'alter table public.transcript_segments alter column "timestamp" drop not null',
    "alter table public.meetings add column source text not null default 'recall'",
    "alter table public.meetings add constraint meetings_source_check check (source in ('recall', 'manual_upload', 'manual_paste'))",
    "alter table public.meetings add column meeting_date date",
    "comment on column public.meetings.source is 'transcript ingestion source: recall (bot), manual_upload or manual_paste. existing rows are recall.'",
    "comment on column public.meetings.meeting_date is 'calendar date the meeting occurred, when known and different from created_at (historical imports). null means use created_at.'"
  ]);
});

test("nothing outside the approved design: no data rewrite, no enum, no new tables, no extra columns", async () => {
  const sql = (await sqlStatements()).join(";\n");
  assert.doesNotMatch(sql, /\b(update|delete|insert|truncate)\b\s/);
  assert.doesNotMatch(sql, /create (type|table|index|function|or replace)/);
  assert.doesNotMatch(sql, /\bdrop (column|table|constraint|function|type)\b/);
  assert.doesNotMatch(sql, /source_metadata|segment_index|sequence|enum/);
  assert.doesNotMatch(sql, /set not null|set default|alter column \S+ type/);
  // meeting_date is nullable with no default: existing rows read null.
  assert.match(sql, /add column meeting_date date;$/m);
});
