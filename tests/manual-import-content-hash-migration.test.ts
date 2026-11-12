import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeTranscriptText } from "@/lib/transcript-import/input";
import { prepareTranscriptImport } from "@/lib/transcript-import/prepare";

// Static checks on the content-hash hardening migration. Always run (no database): they prove the
// file's shape, its ordering, and that the CHECK constraint accepts what the application writes.
// They do not apply the migration to any database.

const FIRST = "20261111090000_add_manual_transcript_import_foundation.sql";
const SECOND = "20261112170000_manual_import_content_hash.sql";

async function read(name: string) {
  return readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
}

async function sqlStatements() {
  return (await read(SECOND))
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/) // only semicolons outside string literals
    .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

test("the hardening migration is exactly a nullable column, its format check and a comment", async () => {
  assert.deepEqual(await sqlStatements(), [
    "alter table public.meetings add column transcript_import_content_sha256 text",
    "alter table public.meetings add constraint meetings_import_content_sha256_format_check check ( transcript_import_content_sha256 is null or transcript_import_content_sha256 ~ '^[0-9a-f]{64}$' )",
    "comment on column public.meetings.transcript_import_content_sha256 is 'immutable sha-256 of the original parsed transcript import; persists before segments are saved.'"
  ]);
});

test("it is additive only: no drop, no rewrite, no default, no NOT NULL, no data change", async () => {
  const sql = (await sqlStatements()).join(" ; ");
  assert.doesNotMatch(sql, /\b(drop|truncate|delete|update|insert|rename)\b/);
  assert.doesNotMatch(sql, /not null|default/);
});

test("it sorts after the foundation migration and after the last Production migration", async () => {
  const names = (await readdir(new URL("../supabase/migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.indexOf(FIRST) !== -1 && names.indexOf(SECOND) === names.indexOf(FIRST) + 1);
  assert.equal(names[names.length - 1], SECOND, "no later migration should sort after it unnoticed");
  assert.ok(SECOND.slice(0, 14) > "20261104090000", "newer than the last recorded Production migration");
});

test("the format check accepts the hash the application writes", () => {
  const prepared = prepareTranscriptImport({
    text: normalizeTranscriptText("Craig: I will send the budget.\nAlex: Thanks."),
    source: "manual_paste",
    formatHint: null
  });
  assert.match(prepared.contentSha256, /^[0-9a-f]{64}$/);
});
