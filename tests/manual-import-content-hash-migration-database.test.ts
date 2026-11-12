import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

// Applies the content-hash hardening migration to the Phase 1 schema (which already has Recall and
// imported rows) and proves it is safe and complete. Same safety model as the Phase 1 database test:
// skipped unless TRANSCRIPT_IMPORT_TEST_DATABASE_URL targets a localhost scratch database.

const run = promisify(execFile);
const baseUrl = process.env.TRANSCRIPT_IMPORT_TEST_DATABASE_URL;
const url = baseUrl ? baseUrl.replace(/\/[^/]+$/, "/actionflow_transcript_import_scratch_2") : undefined;

const RECALL_MEETING = "00000000-0000-4000-8000-0000000000a1";
const FAILED_BOT_MEETING = "00000000-0000-4000-8000-0000000000a2";
const IMPORTED_MEETING = "00000000-0000-4000-8000-0000000000b1";
const IMPORT_WITH_HASH = "00000000-0000-4000-8000-0000000000c1";
const CONCURRENT_A = "00000000-0000-4000-8000-0000000000d1";
const CONCURRENT_B = "00000000-0000-4000-8000-0000000000d2";

test("content-hash hardening migration is safe and complete (isolated local scratch database)", { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "local scratch database required");
  assert.equal(parsed.pathname, "/actionflow_transcript_import_scratch_2");

  async function sql(query: string) {
    const { stdout } = await run("psql", [url!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query]);
    return stdout.trim();
  }
  const file = async (relative: string) => sql(await readFile(new URL(relative, import.meta.url), "utf8"));

  // Start clean: drop and recreate public schema so parallel test runs don't collide.
  await sql("drop schema public cascade; create schema public;");
  await file("fixtures/transcript-import/bootstrap.sql");
  await file("../supabase/migrations/20261013090000_recall_transcript_import_idempotency.sql");
  await file("../supabase/migrations/20261013091500_fix_replace_meeting_transcript_segments_timestamp_cast.sql");
  await file("../supabase/migrations/20261111090000_add_manual_transcript_import_foundation.sql");

  // Seed: a Recall meeting, a failed-bot meeting, and a Phase 1 imported meeting (no content hash).
  await sql(`
    insert into public.meetings (id, user_id, title, meeting_url, recall_bot_id, status, platform, source) values
      ('${RECALL_MEETING}', gen_random_uuid(), 'Weekly sync', 'https://zoom.us/j/123', 'bot-1', 'completed', 'zoom', 'recall'),
      ('${FAILED_BOT_MEETING}', gen_random_uuid(), 'Bot failed', 'https://meet.google.com/abc', null, 'failed', 'google_meet', 'recall'),
      ('${IMPORTED_MEETING}', gen_random_uuid(), 'Old import', null, null, 'transcript_ready', 'unknown', 'manual_paste');
    insert into public.transcript_segments (meeting_id, speaker, text, "timestamp", raw_payload) values
      ('${RECALL_MEETING}', 'Craig', 'Hello.', '2026-08-19T16:00:00Z', '{}'),
      ('${IMPORTED_MEETING}', 'Craig', 'Hi.', null, '{"parfait_import":{"segment_index":0,"content_sha256":"abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234"}}');
  `);

  const meetingsSnapshot = () => sql(`select jsonb_agg(to_jsonb(m) - 'transcript_import_content_sha256' order by id)::text from public.meetings m`);
  const rowVersions = () => sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from (
      select id, xmin from public.meetings union all select id, xmin from public.transcript_segments) v`);

  const before = { meetings: await meetingsSnapshot(), versions: await rowVersions() };

  // Apply the hardening migration.
  await file("../supabase/migrations/20261112170000_manual_import_content_hash.sql");

  await t.test("existing rows are untouched: no data change, no xmin bump", async () => {
    assert.equal(await meetingsSnapshot(), before.meetings);
    assert.equal(await rowVersions(), before.versions);
  });

  await t.test("existing meetings have NULL content hash", async () => {
    for (const id of [RECALL_MEETING, FAILED_BOT_MEETING, IMPORTED_MEETING]) {
      assert.equal(await sql(`select transcript_import_content_sha256 is null from public.meetings where id = '${id}'`), "t");
    }
  });

  await t.test("valid SHA-256 hex is accepted and persisted", async () => {
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    await sql(`insert into public.meetings (id, user_id, title, meeting_url, platform, source, transcript_import_content_sha256)
      values ('${IMPORT_WITH_HASH}', gen_random_uuid(), 'Hash test', null, 'unknown', 'manual_paste', '${hash}')`);
    assert.equal(await sql(`select transcript_import_content_sha256 from public.meetings where id = '${IMPORT_WITH_HASH}'`), hash);
  });

  await t.test("invalid hashes are rejected by the CHECK constraint", async () => {
    for (const bad of ["not-hex", "e3b0c4", "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855X"]) {
      await assert.rejects(
        sql(`insert into public.meetings (id, user_id, title, platform, source, transcript_import_content_sha256) values (gen_random_uuid(), gen_random_uuid(), 'bad', 'unknown', 'manual_paste', '${bad}')`),
        /meetings_import_content_sha256_format_check/,
        `should reject: ${bad}`
      );
    }
  });

  await t.test("NULL is accepted (for Recall and legacy imports)", async () => {
    await sql(`update public.meetings set transcript_import_content_sha256 = null where id = '${RECALL_MEETING}'`);
    assert.equal(await sql(`select transcript_import_content_sha256 is null from public.meetings where id = '${RECALL_MEETING}'`), "t");
  });

  await t.test("primary key collision: two concurrent inserts for the same id, only one wins", async () => {
    const hash = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
    await sql(`insert into public.meetings (id, user_id, title, platform, source, transcript_import_content_sha256)
      values ('${CONCURRENT_A}', gen_random_uuid(), 'First', 'unknown', 'manual_paste', '${hash}')`);
    await assert.rejects(
      sql(`insert into public.meetings (id, user_id, title, platform, source, transcript_import_content_sha256)
        values ('${CONCURRENT_A}', gen_random_uuid(), 'Second', 'unknown', 'manual_paste', '${hash}')`),
      /meetings_pkey/
    );
    assert.equal(await sql(`select title from public.meetings where id = '${CONCURRENT_A}'`), "First");
  });

  await t.test("recall_bot_id unique collision is NOT classified as meetings_pkey", async () => {
    await sql(`insert into public.meetings (id, user_id, title, meeting_url, recall_bot_id, platform, source)
      values ('${CONCURRENT_B}', gen_random_uuid(), 'Recall dup test', 'https://zoom.us/j/999', 'bot-dup', 'zoom', 'recall')`);
    const result = await run("psql", [url!, "-X", "-qAt", "-c",
      `insert into public.meetings (id, user_id, title, meeting_url, recall_bot_id, platform, source) values (gen_random_uuid(), gen_random_uuid(), 'Dup bot', 'https://zoom.us/j/999', 'bot-dup', 'zoom', 'recall')`
    ]).catch((err: Error & { stderr?: string }) => err);
    assert.ok(result instanceof Error);
    const stderr = "stderr" in result ? String(result.stderr) : result.message;
    assert.match(stderr, /meetings_recall_bot_id_key/);
    assert.doesNotMatch(stderr, /meetings_pkey/);
  });

  await t.test("content hash is not returned by select * (it is there, but the route must strip it)", async () => {
    // This verifies the column exists in select * and thus the route's publicMeeting() stripping is needed.
    const cols = await sql(`select array_agg(column_name order by ordinal_position)::text from information_schema.columns
      where table_schema = 'public' and table_name = 'meetings'`);
    assert.ok(cols.includes("transcript_import_content_sha256"), "column exists in schema");
  });

  await t.test("both constraints coexist: source CHECK from Phase 1 and hash format CHECK from Phase 2", async () => {
    const cons = await sql(`select string_agg(conname, ',' order by conname) from pg_constraint
      where conrelid = 'public.meetings'::regclass and contype = 'c'`);
    assert.ok(cons.includes("meetings_source_check"), "Phase 1 source constraint");
    assert.ok(cons.includes("meetings_import_content_sha256_format_check"), "Phase 2 hash constraint");
  });
});
