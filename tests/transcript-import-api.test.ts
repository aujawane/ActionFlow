import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FakeDb, installFakeSupabase } from "./fixtures/analysis-v2/fake-supabase";
import { ImportDb, PROJECT_A, PROJECT_B, USER_A, USER_B, uuid } from "./fixtures/transcript-import/import-db";
import { buildCleanTranscript } from "../lib/analysis";
import { loadMeetingAnalysisInput } from "../lib/meeting-analysis/topics";
import { allowedPriorStatuses } from "../lib/recall/webhook-events";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import {
  commitTranscriptAndEnqueueAnalysis,
  type CommittableTranscriptSegment
} from "../lib/transcript-commit";
import { handleTranscriptImport, handleTranscriptPreview } from "../lib/transcript-import/http";
import { normalizeTranscriptText } from "../lib/transcript-import/input";
import { IMPORT_CLAIM_STALE_AFTER_MS, IMPORTS_PER_HOUR, MAX_IMPORT_REQUEST_BYTES } from "../lib/transcript-import/limits";
import { prepareTranscriptImport } from "../lib/transcript-import/prepare";
import type { ImportMeetingRow, NewImportMeetingRow, TranscriptImportDeps } from "../lib/transcript-import/service";
import { canonicalTranscriptOrder } from "../lib/transcript-order";
import type { Meeting } from "../lib/types";

// Clients are lazy and read these on first use; nothing here reaches a network.
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_ENV: "staging",
  NEXT_PUBLIC_STAGING_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY: "anon",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  OPENAI_API_KEY: "test",
  RECALL_API_KEY: "test",
  RECALL_WEBHOOK_SECRET: "test"
});

// Any accidental database access through the real admin client lands here and is visible.
const guardDb = new FakeDb({});
installFakeSupabase(getSupabaseAdmin(), () => guardDb);

const userFor = (request: Request) => request.headers.get("x-test-user");
function authFrom(request: Request) {
  return async () => {
    const id = userFor(request);
    return id
      ? { user: { id }, response: null }
      : { user: null, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  };
}

const TRANSCRIPT = "Craig: I'll finish the prototype Friday.\nAditya: I'll send the requirements tomorrow.\nCraig: Let's review Monday.";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Craig>I'll finish the prototype Friday.\n\n00:00:04.000 --> 00:00:06.000\n<v Aditya>I'll send the requirements tomorrow.\n";

function jsonRequest(body: Record<string, unknown>, user: string | null = USER_A, path = "import") {
  return new Request(`http://localhost/api/meetings/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify(body)
  });
}
function uploadRequest(fields: Record<string, string>, file: { name: string; content: string | Uint8Array<ArrayBuffer>; type?: string }, user: string | null = USER_A, path = "import") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
  form.set("file", new File([bytes], file.name, { type: file.type ?? "" }));
  return new Request(`http://localhost/api/meetings/${path}`, {
    method: "POST",
    headers: user ? { "x-test-user": user } : {},
    body: form
  });
}

async function importWith(db: ImportDb, request: Request) {
  const response = await handleTranscriptImport(request, { requireUser: authFrom(request), importDeps: db.deps() });
  return { status: response.status, body: (await response.json()) as Record<string, any>, headers: response.headers };
}
async function preview(request: Request) {
  const response = await handleTranscriptPreview(request, { requireUser: authFrom(request) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function assertNoAdminDbAccess() {
  assert.equal(guardDb.selectRequests.length, 0, "no reads through the real admin client");
  assert.equal(guardDb.writes.length, 0, "no writes through the real admin client");
}

// ------------------------------------------------------------------ authentication
test("unauthenticated import and preview requests are rejected before anything is read", async () => {
  const db = new ImportDb();
  const imported = await importWith(db, jsonRequest({ importId: uuid(1), text: TRANSCRIPT }, null));
  assert.equal(imported.status, 401);
  const previewed = await preview(jsonRequest({ text: TRANSCRIPT }, null, "import/preview"));
  assert.equal(previewed.status, 401);
  assert.equal(db.meetings.size, 0);
  assert.equal(db.enqueueCalls.length, 0);
});

// ------------------------------------------------------------------ preview
test("preview returns accurate diagnostics and creates nothing, queues nothing, touches no database", async () => {
  const before = { selects: guardDb.selectRequests.length, writes: guardDb.writes.length };
  const result = await preview(uploadRequest({}, { name: "sync.vtt", content: VTT, type: "text/vtt" }, USER_A, "import/preview"));
  assert.equal(result.status, 200);
  const p = result.body.preview;
  assert.equal(p.format, "webvtt");
  assert.equal(p.source, "manual_upload");
  assert.equal(p.segmentCount, 2);
  assert.deepEqual(p.speakers.map((s: { label: string }) => s.label), ["Craig", "Aditya"]);
  assert.equal(p.hasTimeOffsets, true);
  assert.equal(p.hasAbsoluteTimestamps, false);
  assert.ok(p.warnings.some((w: { code: string }) => w.code === "meeting_date_missing"));
  assert.equal(p.sampleSegments.length, 2);
  assert.deepEqual({ selects: guardDb.selectRequests.length, writes: guardDb.writes.length }, before);
  assertNoAdminDbAccess();
});

test("preview needs no import id, and the preview handler has no data-access dependencies at all", async () => {
  const result = await preview(jsonRequest({ text: TRANSCRIPT, meetingDate: "2026-08-19" }, USER_A, "import/preview"));
  assert.equal(result.status, 200);
  assert.ok(!result.body.preview.warnings.some((w: { code: string }) => w.code === "meeting_date_missing"));
  const http = await readFile(new URL("../lib/transcript-import/http.ts", import.meta.url), "utf8");
  const previewSource = http.slice(http.indexOf("export async function handleTranscriptPreview"), http.indexOf("export async function handleTranscriptImport"));
  assert.doesNotMatch(previewSource, /importTranscript|importDeps|supabase|enqueue|openai/i);
  const route = await readFile(new URL("../app/api/meetings/import/preview/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /supabase|enqueue|openai|transcript-commit/i);
});

test("preview and import interpret the same input identically", async () => {
  const db = new ImportDb();
  const previewed = await preview(jsonRequest({ text: TRANSCRIPT }, USER_A, "import/preview"));
  const imported = await importWith(db, jsonRequest({ importId: uuid(77), text: TRANSCRIPT }));
  assert.equal(imported.body.import.segmentCount, previewed.body.preview.segmentCount);
  assert.equal(imported.body.import.format, previewed.body.preview.format);
  const stored = db.segments.get(uuid(77))!;
  assert.deepEqual(
    stored.map((row) => row.speaker ?? "Unknown Speaker"),
    previewed.body.preview.sampleSegments.map((s: { speaker: string }) => s.speaker)
  );
});

// ------------------------------------------------------------------ validation
test("invalid inputs are rejected with machine-readable codes and nothing is created", async () => {
  const db = new ImportDb();
  const cases: Array<[Request, number, string]> = [
    [jsonRequest({ text: TRANSCRIPT }), 400, "invalid_request"], // missing import id
    [jsonRequest({ importId: "not-a-uuid", text: TRANSCRIPT }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, meetingDate: "2026-02-30" }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, meetingDate: "2999-01-01" }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, meetingDate: "19/08/2026" }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, projectId: "x" }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, title: "x".repeat(201) }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: TRANSCRIPT, format: "pdf" }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2) }), 400, "empty_input"],
    [jsonRequest({ importId: uuid(2), text: "   \n  " }), 400, "empty_input"],
    [jsonRequest({ importId: uuid(2), text: 42 }), 400, "invalid_request"],
    [jsonRequest({ importId: uuid(2), text: "a\u0000b" }), 400, "nul_byte"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.pdf", content: "%PDF-1.7" }), 400, "unsupported_format"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.txt", content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) }), 400, "binary_content"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.txt", content: "Craig: hi", type: "application/pdf" }), 400, "binary_content"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.txt", content: new Uint8Array([0x48, 0xc3, 0x28]) }), 400, "invalid_utf8"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.vtt", content: "Craig: hi" }), 400, "content_format_mismatch"],
    [uploadRequest({ importId: uuid(2) }, { name: "meeting.srt", content: "1\n00:00:01,000 --> nope\nx" }), 400, "malformed_cue"],
    [uploadRequest({ importId: uuid(2), format: "vtt" }, { name: "meeting.txt", content: "Craig: hi" }), 400, "invalid_request"],
    [new Request("http://localhost/api/meetings/import", { method: "POST", headers: { "content-type": "text/plain", "x-test-user": USER_A }, body: TRANSCRIPT }), 415, "invalid_request"],
    [new Request("http://localhost/api/meetings/import", { method: "POST", headers: { "content-type": "application/json", "x-test-user": USER_A }, body: "{not json" }), 400, "invalid_request"]
  ];
  for (const [request, status, code] of cases) {
    const result = await importWith(db, request);
    assert.equal(result.status, status, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code);
  }
  const both = new FormData();
  both.set("importId", uuid(3));
  both.set("text", TRANSCRIPT);
  both.set("file", new File([TRANSCRIPT], "a.txt"));
  const bothResult = await importWith(db, new Request("http://localhost/api/meetings/import", { method: "POST", headers: { "x-test-user": USER_A }, body: both }));
  assert.equal(bothResult.body.code, "invalid_request");
  assert.equal(db.meetings.size, 0);
  assert.equal(db.enqueueCalls.length, 0);
});

test("oversized requests are rejected with 413, by header and while streaming", async () => {
  const db = new ImportDb();
  const huge = "a".repeat(MAX_IMPORT_REQUEST_BYTES + 10);
  const declared = await importWith(db, jsonRequest({ importId: uuid(4), text: huge }));
  assert.equal(declared.status, 413);
  assert.equal(declared.body.code, "request_too_large");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(100_000).fill(0x61));
      controller.close();
    }
  });
  const streamed = await importWith(db, new Request("http://localhost/api/meetings/import", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: stream,
    duplex: "half"
  } as RequestInit));
  assert.equal(streamed.status, 413);

  const tooMuchText = await importWith(db, jsonRequest({ importId: uuid(4), text: "é".repeat(600_000) }));
  assert.ok([413].includes(tooMuchText.status));
  assert.equal(db.meetings.size, 0);
});

// ------------------------------------------------------------------ successful imports
test("a valid paste creates an owned manual_paste meeting, stores canonical segments, and queues analysis once", async () => {
  const db = new ImportDb();
  const result = await importWith(db, jsonRequest({ importId: uuid(10), text: TRANSCRIPT, title: "Q3 sync", meetingDate: "2026-08-19" }));
  assert.equal(result.status, 201);
  assert.equal(result.body.import.outcome, "created");
  assert.equal(result.body.import.segmentCount, 3);
  assert.deepEqual(result.body.analysis, { status: "queued", jobId: "job-1", generation: 1 });
  assert.ok(!result.body.import.warnings.some((w: { code: string }) => w.code === "meeting_date_missing"));

  const meeting = db.meetings.get(uuid(10))!;
  assert.equal(meeting.user_id, USER_A);
  assert.equal(meeting.source, "manual_paste");
  assert.equal(meeting.meeting_url, null);
  assert.equal(meeting.recall_bot_id, null);
  assert.equal(meeting.platform, "unknown");
  assert.equal(meeting.meeting_date, "2026-08-19");
  assert.equal(meeting.title, "Q3 sync");
  assert.equal(meeting.status, "transcript_ready");
  assert.equal(result.body.meeting.status, "transcript_ready");

  const stored = db.segments.get(uuid(10))!;
  assert.deepEqual(stored.map((row) => [row.speaker, row.text, row.timestamp]), [
    ["Craig", "I'll finish the prototype Friday.", null],
    ["Aditya", "I'll send the requirements tomorrow.", null],
    ["Craig", "Let's review Monday.", null]
  ]);
  assert.deepEqual(stored.map((row) => (row.raw_payload as { parfait_import: { segment_index: number } }).parfait_import.segment_index), [0, 1, 2]);
  assert.deepEqual(db.enqueueCalls, [uuid(10)]);
  assertNoAdminDbAccess();
});

test("the user id comes only from the session; a body user id is ignored", async () => {
  const db = new ImportDb();
  await importWith(db, jsonRequest({ importId: uuid(11), text: TRANSCRIPT, user_id: USER_B, userId: USER_B }));
  assert.equal(db.meetings.get(uuid(11))!.user_id, USER_A);
});

test("a valid upload creates a manual_upload meeting titled from the file name", async () => {
  const db = new ImportDb();
  const result = await importWith(db, uploadRequest({ importId: uuid(12) }, { name: "Q3 planning (Aug 19).vtt", content: VTT, type: "application/octet-stream" }));
  assert.equal(result.status, 201);
  const meeting = db.meetings.get(uuid(12))!;
  assert.equal(meeting.source, "manual_upload");
  assert.equal(meeting.title, "Q3 planning (Aug 19)");
  assert.equal(meeting.meeting_date, null);
  assert.ok(result.body.import.warnings.some((w: { code: string }) => w.code === "meeting_date_missing"), "date-less import warns");
  const stored = db.segments.get(uuid(12))!;
  assert.deepEqual(stored.map((row) => (row.raw_payload as { parfait_import: { start_offset_ms: number } }).parfait_import.start_offset_ms), [1000, 4000]);
  assert.ok(stored.every((row) => row.timestamp === null));
});

test("an owned project is assigned in the creating INSERT, before any transcript or analysis", async () => {
  const db = new ImportDb();
  const deps = db.deps();
  const order: string[] = [];
  const traced: TranscriptImportDeps = {
    ...deps,
    insertMeeting: async (row) => {
      order.push(`insert project=${row.project_id}`);
      return deps.insertMeeting(row);
    },
    commitTranscript: async (input) => {
      order.push(`commit project=${db.meetings.get(input.meetingId)!.project_id}`);
      return deps.commitTranscript(input);
    }
  };
  const request = jsonRequest({ importId: uuid(13), text: TRANSCRIPT, projectId: PROJECT_A });
  const response = await handleTranscriptImport(request, { requireUser: authFrom(request), importDeps: traced });
  assert.equal(response.status, 201);
  assert.deepEqual(order, [`insert project=${PROJECT_A}`, `commit project=${PROJECT_A}`]);
});

test("another user's project is rejected with no meeting created and no analysis", async () => {
  const db = new ImportDb();
  const result = await importWith(db, jsonRequest({ importId: uuid(14), text: TRANSCRIPT, projectId: PROJECT_B }));
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "project_not_found");
  assert.equal(db.meetings.size, 0);
  assert.equal(db.enqueueCalls.length, 0);
});

// ------------------------------------------------------------------ idempotency
test("retrying the same import returns the same meeting and never queues analysis again", async () => {
  const db = new ImportDb();
  const body = { importId: uuid(20), text: TRANSCRIPT, meetingDate: "2026-08-19" };
  const first = await importWith(db, jsonRequest(body));
  const second = await importWith(db, jsonRequest(body));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.import.outcome, "already_imported");
  assert.equal(second.body.meeting.id, uuid(20));
  assert.deepEqual(second.body.analysis, { status: "existing", jobStatus: "queued", jobId: "job-1" });
  assert.equal(db.meetings.size, 1);
  assert.deepEqual(db.enqueueCalls, [uuid(20)]);
});

test("a completed import stays idempotent after the user renames it or moves it to a project", async () => {
  const db = new ImportDb();
  await importWith(db, jsonRequest({ importId: uuid(21), text: TRANSCRIPT }));
  db.meetings.get(uuid(21))!.title = "Renamed";
  db.meetings.get(uuid(21))!.project_id = PROJECT_A;
  const retry = await importWith(db, jsonRequest({ importId: uuid(21), text: TRANSCRIPT }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.import.outcome, "already_imported");
  assert.equal(db.enqueueCalls.length, 1);
});

test("concurrent identical submissions create one meeting and queue analysis exactly once", async () => {
  const db = new ImportDb();
  const body = { importId: uuid(22), text: TRANSCRIPT };
  const results = await Promise.all(Array.from({ length: 6 }, () => importWith(db, jsonRequest(body))));
  assert.equal(db.meetings.size, 1);
  assert.deepEqual(db.enqueueCalls, [uuid(22)]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  for (const r of results.filter((r) => r.status !== 201)) {
    assert.ok(
      (r.status === 409 && r.body.code === "import_in_progress" && r.headers.get("retry-after")) ||
        (r.status === 200 && r.body.import.outcome === "already_imported"),
      JSON.stringify(r.body)
    );
  }
});

test("the same import id with different content or details is a conflict and returns no data", async () => {
  const db = new ImportDb();
  await importWith(db, jsonRequest({ importId: uuid(23), text: TRANSCRIPT }));
  const different = await importWith(db, jsonRequest({ importId: uuid(23), text: `${TRANSCRIPT}\nCraig: one more thing.` }));
  assert.equal(different.status, 409);
  assert.equal(different.body.code, "import_id_conflict");
  assert.equal(different.body.meeting, undefined);
  assert.equal(different.body.meetingId, undefined);

  const asUpload = await importWith(db, uploadRequest({ importId: uuid(23) }, { name: "t.txt", content: TRANSCRIPT }));
  assert.equal(asUpload.body.code, "import_id_conflict");
  assert.equal(db.enqueueCalls.length, 1);
});

test("another user's import id is indistinguishable from any other conflict", async () => {
  const db = new ImportDb();
  await importWith(db, jsonRequest({ importId: uuid(24), text: TRANSCRIPT, title: "Secret board meeting" }));
  const otherUser = await importWith(db, jsonRequest({ importId: uuid(24), text: TRANSCRIPT }, USER_B));
  const mismatch = await importWith(db, jsonRequest({ importId: uuid(24), text: "Craig: other" }));
  assert.equal(otherUser.status, 409);
  assert.deepEqual(otherUser.body, mismatch.body);
  assert.doesNotMatch(JSON.stringify(otherUser.body), /Secret board meeting|transcript_ready|Craig/);
  assert.equal(db.meetings.get(uuid(24))!.user_id, USER_A);
  assert.equal(db.enqueueCalls.length, 1);
});

test("an import id that matches a Recall meeting or a deleted import is a conflict", async () => {
  const db = new ImportDb();
  db.meetings.set(uuid(25), {
    id: uuid(25), user_id: USER_A, title: null, meeting_url: null, recall_bot_id: null, platform: "unknown",
    status: "pending", source: "recall" as never, meeting_date: null, project_id: null,
    transcript_import_claimed_at: null as never, created_at: "2026-11-01T00:00:00.000Z", deleted_at: null
  });
  assert.equal((await importWith(db, jsonRequest({ importId: uuid(25), text: TRANSCRIPT }))).body.code, "import_id_conflict");

  await importWith(db, jsonRequest({ importId: uuid(26), text: TRANSCRIPT }));
  db.meetings.get(uuid(26))!.deleted_at = "2026-11-11T12:30:00.000Z";
  assert.equal((await importWith(db, jsonRequest({ importId: uuid(26), text: TRANSCRIPT }))).body.code, "import_id_conflict");
  assert.equal(db.enqueueCalls.length, 1);
});

// ------------------------------------------------------------------ partial failure
test("a failed segment save never queues analysis; the meeting stays pending and the same import id finishes it", async () => {
  const db = new ImportDb();
  db.failReplace = 1;
  const body = { importId: uuid(30), text: TRANSCRIPT, projectId: PROJECT_A, meetingDate: "2026-08-19" };
  const failed = await importWith(db, jsonRequest(body));
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "import_incomplete");
  assert.equal(failed.body.retryable, true);
  assert.equal(failed.body.meetingId, uuid(30));
  assert.doesNotMatch(JSON.stringify(failed.body), /statement timeout|replace_meeting/);
  const meeting = db.meetings.get(uuid(30))!;
  assert.equal(meeting.status, "pending");
  assert.equal(meeting.transcript_import_claimed_at, null, "claim released for an immediate retry");
  assert.equal(db.segments.get(uuid(30)), undefined);
  assert.equal(db.enqueueCalls.length, 0);

  const retried = await importWith(db, jsonRequest(body));
  assert.equal(retried.status, 200);
  assert.equal(retried.body.import.outcome, "recovered");
  assert.equal(db.meetings.get(uuid(30))!.status, "transcript_ready");
  assert.equal(db.segments.get(uuid(30))!.length, 3);
  assert.deepEqual(db.enqueueCalls, [uuid(30)]);
});

test("a crash right after the meeting insert: retries wait while the claim is live, then recover", async () => {
  const db = new ImportDb();
  db.crashAfterInsert = true;
  const body = { importId: uuid(31), text: TRANSCRIPT };
  const crashed = await importWith(db, jsonRequest(body));
  assert.equal(crashed.status, 500);
  assert.equal(crashed.body.code, "internal_error");
  assert.equal(db.meetings.get(uuid(31))!.status, "pending");

  const tooSoon = await importWith(db, jsonRequest(body));
  assert.equal(tooSoon.status, 409);
  assert.equal(tooSoon.body.code, "import_in_progress");
  assert.equal(db.enqueueCalls.length, 0);

  db.clock += IMPORT_CLAIM_STALE_AFTER_MS + 1000;
  const recovered = await importWith(db, jsonRequest(body));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.import.outcome, "recovered");
  assert.deepEqual(db.enqueueCalls, [uuid(31)]);
});

test("recovering a pending import requires the same details it was created with", async () => {
  const db = new ImportDb();
  db.failReplace = 1;
  await importWith(db, jsonRequest({ importId: uuid(32), text: TRANSCRIPT, title: "A" }));
  const changedTitle = await importWith(db, jsonRequest({ importId: uuid(32), text: TRANSCRIPT, title: "B" }));
  assert.equal(changedTitle.body.code, "import_id_conflict");
  const changedProject = await importWith(db, jsonRequest({ importId: uuid(32), text: TRANSCRIPT, title: "A", projectId: PROJECT_A }));
  assert.equal(changedProject.body.code, "import_id_conflict");
  assert.equal(db.enqueueCalls.length, 0);
  assert.equal(db.meetings.get(uuid(32))!.status, "pending");
});

test("segments saved but the process died before the status change: recovery re-saves the same content and queues once", async () => {
  const db = new ImportDb();
  const body = { importId: uuid(33), text: TRANSCRIPT };
  const prepared = prepareTranscriptImport({ text: normalizeTranscriptText(TRANSCRIPT), source: "manual_paste", formatHint: null });
  db.meetings.set(uuid(33), {
    id: uuid(33), user_id: USER_A, title: null, meeting_url: null, recall_bot_id: null, platform: "unknown",
    status: "pending", source: "manual_paste", meeting_date: null, project_id: null,
    transcript_import_claimed_at: new Date(db.clock - IMPORT_CLAIM_STALE_AFTER_MS - 1).toISOString(),
    created_at: new Date(db.clock).toISOString(), deleted_at: null
  });
  db.segments.set(uuid(33), prepared.segments.map((row, i) => ({ ...row, id: uuid(900 + i), meeting_id: uuid(33) })));
  const recovered = await importWith(db, jsonRequest(body));
  assert.equal(recovered.body.import.outcome, "recovered");
  assert.equal(db.segments.get(uuid(33))!.length, 3);
  assert.deepEqual(db.enqueueCalls, [uuid(33)]);

  // Different content stored for a pending import id is a conflict, not an overwrite.
  db.meetings.set(uuid(34), { ...db.meetings.get(uuid(33))!, id: uuid(34), status: "pending", transcript_import_claimed_at: null as never });
  db.segments.set(uuid(34), db.segments.get(uuid(33))!.map((row) => ({ ...row, meeting_id: uuid(34) })));
  const other = await importWith(db, jsonRequest({ importId: uuid(34), text: "Craig: something else entirely" }));
  assert.equal(other.body.code, "import_id_conflict");
  assert.equal(db.meetings.get(uuid(34))!.transcript_import_claimed_at, null, "claim released on conflict");
});

test("if starting analysis fails, the transcript is kept, the meeting is ready, and retries do not re-queue", async () => {
  const db = new ImportDb();
  db.failEnqueue = 1;
  const body = { importId: uuid(35), text: TRANSCRIPT };
  const result = await importWith(db, jsonRequest(body));
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.analysis, { status: "enqueue_failed" });
  assert.equal(db.meetings.get(uuid(35))!.status, "transcript_ready");
  const retry = await importWith(db, jsonRequest(body));
  assert.equal(retry.body.import.outcome, "already_imported");
  assert.deepEqual(retry.body.analysis, { status: "existing", jobStatus: null, jobId: null });
  assert.equal(db.enqueueCalls.length, 1);
});

test("unexpected errors return a generic message without internals", async () => {
  const db = new ImportDb();
  db.failInsertWith = new Error("connection to postgres://service_role:supersecret@db.internal failed");
  const result = await importWith(db, jsonRequest({ importId: uuid(36), text: TRANSCRIPT }));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "The transcript could not be processed. Try again.", code: "internal_error" });
  assert.doesNotMatch(JSON.stringify(result.body), /supersecret|postgres|service_role/);
});

// ------------------------------------------------------------------ rate limits
test("per-user hourly limit applies to new imports only; retries and other users are unaffected", async () => {
  const db = new ImportDb();
  for (let i = 0; i < IMPORTS_PER_HOUR; i += 1) {
    assert.equal((await importWith(db, jsonRequest({ importId: uuid(100 + i), text: `${TRANSCRIPT} ${i}` }))).status, 201);
  }
  const limited = await importWith(db, jsonRequest({ importId: uuid(200), text: TRANSCRIPT }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "3600");
  assert.equal(db.meetings.has(uuid(200)), false);

  const retry = await importWith(db, jsonRequest({ importId: uuid(100), text: `${TRANSCRIPT} 0` }));
  assert.equal(retry.status, 200);
  assert.equal((await importWith(db, jsonRequest({ importId: uuid(201), text: TRANSCRIPT }, USER_B))).status, 201);

  db.clock += 61 * 60 * 1000;
  assert.equal((await importWith(db, jsonRequest({ importId: uuid(202), text: TRANSCRIPT }))).status, 201);
});

// ------------------------------------------------------------------ downstream: v1 analysis input
test("an imported transcript reaches v1 analysis input in source order, without time tokens", async () => {
  const prepared = prepareTranscriptImport({ text: normalizeTranscriptText(VTT), source: "manual_upload", formatHint: "vtt" });
  const rows = prepared.segments.map((row, i) => ({ ...row, id: uuid(5000 - i), meeting_id: "imported-1", normalized_text: null }));
  const db = new FakeDb({
    meetings: [{ id: "imported-1", user_id: USER_A, project_id: null, created_at: "2026-11-11T12:00:00.000Z", meeting_date: "2026-08-19", source: "manual_upload", deleted_at: null }],
    transcript_segments: rows
  });
  db.maxRows = 1000;
  installFakeSupabase(getSupabaseAdmin(), () => db);
  try {
    const input = await loadMeetingAnalysisInput("imported-1");
    assert.equal(input.transcript, "Craig: I'll finish the prototype Friday.\nAditya: I'll send the requirements tomorrow.");
    assert.equal(input.sourceBase.meetingDate, "2026-08-19", "relative dates resolve against the historical date");
    assert.equal(input.transcript, buildCleanTranscript(canonicalTranscriptOrder(rows)));
  } finally {
    installFakeSupabase(getSupabaseAdmin(), () => guardDb);
  }
});

test("a long imported transcript (over 1,000 segments) is analysed in full", async () => {
  const text = Array.from({ length: 1500 }, (_, i) => `${i % 2 ? "Craig" : "Aditya"}: line ${i}${i === 1499 ? " FINAL" : ""}`).join("\n");
  const prepared = prepareTranscriptImport({ text: normalizeTranscriptText(text), source: "manual_paste", formatHint: null });
  const rows = prepared.segments.map((row, i) => ({ ...row, id: uuid((i * 7919) % 1500), meeting_id: "imported-2", normalized_text: null }));
  const db = new FakeDb({
    meetings: [{ id: "imported-2", user_id: USER_A, project_id: null, created_at: "2026-11-11T12:00:00.000Z", meeting_date: null, source: "manual_paste", deleted_at: null }],
    transcript_segments: rows
  });
  db.maxRows = 1000;
  installFakeSupabase(getSupabaseAdmin(), () => db);
  try {
    const input = await loadMeetingAnalysisInput("imported-2");
    assert.equal(input.safeSegments.length, 1500);
    assert.ok(input.transcript.endsWith("Aditya: line 1499 FINAL") || input.transcript.endsWith("Craig: line 1499 FINAL"));
    assert.equal(input.sourceBase.meetingDate, "2026-11-11T12:00:00.000Z", "no meeting date: falls back to created_at");
  } finally {
    installFakeSupabase(getSupabaseAdmin(), () => guardDb);
  }
});

// ------------------------------------------------------------------ source pins
test("imports reach analysis only through the shared commit helper and the normal queue", async () => {
  const deps = await readFile(new URL("../lib/transcript-import/supabase-deps.ts", import.meta.url), "utf8");
  assert.match(deps, /commitTranscriptAndEnqueueAnalysis/);
  const all = [
    deps,
    await readFile(new URL("../lib/transcript-import/service.ts", import.meta.url), "utf8"),
    await readFile(new URL("../lib/transcript-import/http.ts", import.meta.url), "utf8"),
    await readFile(new URL("../app/api/meetings/import/route.ts", import.meta.url), "utf8")
  ].join("\n");
  assert.doesNotMatch(all, /analyze-v2|enqueueMeetingAnalysisV2|getOpenAIClient|openai/i);
  assert.doesNotMatch(all, /\.from\("transcript_segments"\)\s*\.(insert|delete|update)/, "segments are written only by the transactional RPC");
  assert.doesNotMatch(all, /\.delete\(/, "nothing is deleted as cleanup");
});
