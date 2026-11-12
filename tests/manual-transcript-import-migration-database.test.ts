import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

// Applies the Phase 1 manual-transcript-import migration to an ISOLATED LOCAL scratch database
// shaped like the verified live schema, with pre-existing Recall rows, and proves it is safe for
// them. Skipped unless TRANSCRIPT_IMPORT_TEST_DATABASE_URL points at localhost database
// actionflow_transcript_import_scratch -- it can never target staging or Production.

const run = promisify(execFile);
const url = process.env.TRANSCRIPT_IMPORT_TEST_DATABASE_URL;

const RECALL_MEETING = "00000000-0000-4000-8000-0000000000a1";
const FAILED_BOT_MEETING = "00000000-0000-4000-8000-0000000000a2";
const IMPORTED_MEETING = "00000000-0000-4000-8000-0000000000b1";

test("manual transcript import migration is safe for existing data (isolated local scratch database)", { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "local scratch database required");
  assert.equal(parsed.pathname, "/actionflow_transcript_import_scratch");

  async function sql(query: string) {
    const { stdout } = await run("psql", [url!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query]);
    return stdout.trim();
  }
  const file = async (relative: string) => sql(await readFile(new URL(relative, import.meta.url), "utf8"));

  await sql("drop schema public cascade; create schema public;");
  await file("fixtures/transcript-import/bootstrap.sql");
  await file("../supabase/migrations/20261013090000_recall_transcript_import_idempotency.sql");
  await file("../supabase/migrations/20261013091500_fix_replace_meeting_transcript_segments_timestamp_cast.sql");

  // Pre-existing Recall data, including a Recall meeting whose bot creation failed (null bot id).
  await sql(`
    insert into public.meetings (id, user_id, title, meeting_url, recall_bot_id, status, platform, created_at) values
      ('${RECALL_MEETING}', gen_random_uuid(), 'Weekly sync', 'https://zoom.us/j/123', 'bot-1', 'completed', 'zoom', '2026-08-19T16:00:00Z'),
      ('${FAILED_BOT_MEETING}', gen_random_uuid(), 'Bot failed', 'https://meet.google.com/abc-defg-hij', null, 'failed', 'google_meet', '2026-09-01T10:00:00Z');
    insert into public.transcript_segments (meeting_id, speaker, participant_name, text, "timestamp", raw_payload) values
      ('${RECALL_MEETING}', 'Craig', 'Craig', 'I''ll finish it by Friday.', '2026-08-19T16:02:13.25Z', '{"words":[{"start_timestamp":{"relative":1.5}}]}'),
      ('${RECALL_MEETING}', 'Aditya', 'Aditya', 'Sounds good.', '2026-08-19T16:02:18Z', '{"words":[{"start_timestamp":{"relative":6.2}}]}');
  `);

  const meetingsSnapshot = () => sql(`select jsonb_agg(to_jsonb(m) - 'source' - 'meeting_date' order by id)::text from public.meetings m`);
  const segmentsSnapshot = () => sql(`select jsonb_agg(to_jsonb(s) order by id)::text from public.transcript_segments s`);
  const rowVersions = () => sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from (
      select id, xmin from public.meetings union all select id, xmin from public.transcript_segments) v`);
  const columns = () => sql(`select jsonb_agg(jsonb_build_array(table_name, column_name, data_type, is_nullable, column_default)
      order by table_name, column_name)::text from information_schema.columns
      where table_schema = 'public' and table_name in ('meetings', 'transcript_segments')`);
  const constraints = () => sql(`select string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' order by conname)
      from pg_constraint where conrelid in ('public.meetings'::regclass, 'public.transcript_segments'::regclass)`);

  const before = {
    meetings: await meetingsSnapshot(),
    segments: await segmentsSnapshot(),
    versions: await rowVersions(),
    columns: JSON.parse(await columns()) as string[][],
    constraints: await constraints()
  };

  await file("../supabase/migrations/20261111090000_add_manual_transcript_import_foundation.sql");

  await t.test("every existing meeting reads source = 'recall' and meeting_date = null, including a null-bot Recall meeting", async () => {
    assert.equal(
      await sql(`select string_agg(id::text || ':' || source || ':' || coalesce(meeting_date::text, 'null'), ',' order by id) from public.meetings`),
      `${RECALL_MEETING}:recall:null,${FAILED_BOT_MEETING}:recall:null`
    );
  });

  await t.test("existing meeting URLs, timestamps and every other value are untouched, and no row was rewritten", async () => {
    assert.equal(await meetingsSnapshot(), before.meetings);
    assert.equal(await segmentsSnapshot(), before.segments);
    assert.equal(await rowVersions(), before.versions, "xmin unchanged: the migration rewrote no existing row");
  });

  await t.test("catalog: only the two NOT NULLs are relaxed, plus the two new columns", async () => {
    const after = JSON.parse(await columns()) as string[][];
    const key = (row: string[]) => `${row[0]}.${row[1]}`;
    const beforeByKey = new Map(before.columns.map((row) => [key(row), row]));
    const changed = after.filter((row) => JSON.stringify(beforeByKey.get(key(row))) !== JSON.stringify(row));
    assert.deepEqual(changed, [
      ["meetings", "meeting_date", "date", "YES", null],
      ["meetings", "meeting_url", "text", "YES", null],
      ["meetings", "source", "text", "NO", "'recall'::text"],
      ["transcript_segments", "timestamp", "timestamp with time zone", "YES", null]
    ]);
    assert.equal(after.length, before.columns.length + 2, "no column removed");
    const afterConstraints = await constraints();
    assert.equal(
      afterConstraints,
      [before.constraints.split(" | "), "meetings_source_check=CHECK ((source = ANY (ARRAY['recall'::text, 'manual_upload'::text, 'manual_paste'::text])))"]
        .flat()
        .sort()
        .join(" | ")
    );
  });

  await t.test("source accepts exactly recall / manual_upload / manual_paste", async () => {
    await assert.rejects(sql(`update public.meetings set source = 'zoom' where id = '${RECALL_MEETING}'`), /meetings_source_check/);
    await assert.rejects(sql(`update public.meetings set source = null where id = '${RECALL_MEETING}'`), /not-null|null value/);
    for (const value of ["manual_upload", "manual_paste", "recall"]) {
      await sql(`update public.meetings set source = '${value}' where id = '${FAILED_BOT_MEETING}'`);
    }
  });

  await t.test("an imported meeting can now exist: no URL, no bot, platform unknown, a historical date", async () => {
    await sql(`insert into public.meetings (id, user_id, title, meeting_url, recall_bot_id, platform, source, meeting_date)
      values ('${IMPORTED_MEETING}', gen_random_uuid(), 'Imported', null, null, 'unknown', 'manual_paste', '2026-08-19')`);
    assert.equal(
      await sql(`select coalesce(meeting_url, 'NULL') || '|' || coalesce(recall_bot_id, 'NULL') || '|' || platform || '|' || source || '|' || meeting_date from public.meetings where id = '${IMPORTED_MEETING}'`),
      "NULL|NULL|unknown|manual_paste|2026-08-19"
    );
  });

  await t.test("the existing transactional replace RPC stores null timestamps as NULL and still stores real ones", async () => {
    const imported = [
      { speaker: "Craig", participant_name: null, text: "I'll finish it by Friday.", timestamp: null, raw_payload: { parfait_import: { segment_index: 0 } } },
      { speaker: null, participant_name: null, text: "Sounds good.", timestamp: null, raw_payload: { parfait_import: { segment_index: 1 } } }
    ];
    await sql(`select count(*) from public.replace_meeting_transcript_segments('${IMPORTED_MEETING}', $j$${JSON.stringify(imported)}$j$::jsonb)`);
    assert.equal(
      await sql(`select string_agg(coalesce("timestamp"::text, 'NULL') || ':' || (raw_payload #>> '{parfait_import,segment_index}'), ',' order by raw_payload #>> '{parfait_import,segment_index}') from public.transcript_segments where meeting_id = '${IMPORTED_MEETING}'`),
      "NULL:0,NULL:1"
    );

    const recall = [{ speaker: "Craig", participant_name: "Craig", text: "Again.", timestamp: "2026-08-19T16:05:00.000Z", raw_payload: {} }];
    await sql(`select count(*) from public.replace_meeting_transcript_segments('${FAILED_BOT_MEETING}', $j$${JSON.stringify(recall)}$j$::jsonb)`);
    assert.equal(
      await sql(`select "timestamp" at time zone 'UTC' from public.transcript_segments where meeting_id = '${FAILED_BOT_MEETING}'`),
      "2026-08-19 16:05:00"
    );
  });
});
