import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getEffectiveMeetingDate } from "../lib/meeting-date";
import { MEETING_SOURCES, getMeetingSource, isMeetingSource, isRecallMeeting } from "../lib/meeting-source";

const readSource = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("effective meeting date: meeting_date when set, otherwise created_at (Recall meetings unchanged)", () => {
  const created = "2026-11-11T09:30:00.000Z";
  assert.equal(getEffectiveMeetingDate({ created_at: created }), created, "column not selected / pre-migration");
  assert.equal(getEffectiveMeetingDate({ meeting_date: null, created_at: created }), created);
  assert.equal(getEffectiveMeetingDate({ meeting_date: "2026-08-19", created_at: created }), "2026-08-19");
});

test("meeting source: missing means recall; never inferred from recall_bot_id", () => {
  assert.equal(getMeetingSource({}), "recall");
  assert.equal(getMeetingSource({ source: null }), "recall");
  assert.equal(getMeetingSource({ source: "manual_upload" }), "manual_upload");
  assert.equal(getMeetingSource({ source: "manual_paste" }), "manual_paste");
  // A Recall meeting whose bot creation failed has no bot id and is still a Recall meeting.
  assert.equal(isRecallMeeting({ source: "recall", recall_bot_id: null } as { source: string }), true);
  // An imported meeting is not a Recall meeting even if some other field looks Recall-ish.
  assert.equal(isRecallMeeting({ source: "manual_paste", recall_bot_id: "bot" } as { source: string }), false);
  assert.equal(isMeetingSource("zoom"), false);
});

test("the TypeScript source list matches the migration's CHECK constraint exactly", async () => {
  const migration = await readSource("supabase/migrations/20261111090000_add_manual_transcript_import_foundation.sql");
  const check = migration.match(/check \(source in \(([^)]*)\)\)/);
  assert.ok(check, "expected the source CHECK constraint");
  const values = check![1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(values, [...MEETING_SOURCES]);
  const helperSource = await readSource("lib/meeting-source.ts");
  assert.doesNotMatch(helperSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /recall_bot_id/);
});

test("every place that means 'when the meeting happened' uses the effective meeting date", async () => {
  const expectations: Array<[string, RegExp]> = [
    ["lib/meeting-analysis/topics.ts", /getEffectiveMeetingDate\(meeting\)/],
    ["lib/meeting-analysis/normalization.ts", /meetingDate: getEffectiveMeetingDate\(meeting\)/],
    ["lib/meeting-follow-up-email-service.ts", /getEffectiveMeetingDate\(contextResult\.meeting\)/],
    ["lib/meeting-assistant/context.ts", /date: getEffectiveMeetingDate\(input\.meeting\)/],
    ["lib/project-brain/context.ts", /date: getEffectiveMeetingDate\(meeting\)/],
    ["app/meetings/[id]/page.tsx", /formatReadableDate\(getEffectiveMeetingDate\(meeting\)\)/],
    ["app/projects/page.tsx", /formatReadableDate\(getEffectiveMeetingDate\(item\.meeting\)\)/]
  ];
  for (const [path, pattern] of expectations) {
    assert.match(await readSource(path), pattern, path);
  }
  // The meetings reads feeding analysis/brain select "*" so they work before and after the migration.
  assert.doesNotMatch(await readSource("lib/meeting-analysis/normalization.ts"), /\.select\("id, project_id, created_at"\)/);
  assert.doesNotMatch(await readSource("lib/project-brain/context.ts"), /\.select\("id,title,created_at,status/);
});

test("the meeting library intentionally keeps record-creation time for 'Created' labels, sorting and month grouping", async () => {
  const library = await readSource("components/meeting-library.tsx");
  assert.match(library, /return new Date\(meeting\.created_at\);/);
  assert.match(library, /Created \{formatReadableDate\(meeting\.created_at\)\}/);
});
