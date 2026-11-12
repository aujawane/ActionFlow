import assert from "node:assert/strict";
import test from "node:test";

import { ImportDb, USER_A, uuid } from "./fixtures/transcript-import/import-db";
import { handleTranscriptImport, handleTranscriptPreview } from "../lib/transcript-import/http";
import {
  buildRequest,
  classifyImportResponse,
  DRAFT_STORAGE_KEY,
  EMPTY_INPUT,
  effectiveTitle,
  ImportSession,
  meetingPath,
  validateInput,
  type ImportInput,
  type SessionDeps
} from "../lib/transcript-import/client-session";
import { MAX_TRANSCRIPT_BYTES } from "../lib/transcript-import/limits";

const TRANSCRIPT = "Alex: I'll send the requirements by Friday.\nJordan: I'll review them by Monday.\nAlex: Great.";
const IMPORT_A = "7147f170-b994-4a1a-acb0-544915825a2c";
const IMPORT_B = "8258a281-c0a5-4b2b-8655-655a26036b3d";

// ------------------------------------------------------------------ harness
type Call = { url: string; body: FormData | Record<string, unknown> };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Script = Array<Response | Error | ((call: Call) => Response | Promise<Response>)>;

function harness(script: Script, options: { ids?: string[]; storage?: ReturnType<typeof memoryStorage> | null; timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const ids = [...(options.ids ?? [IMPORT_A, IMPORT_B])];
  const clock = { now: 1_000_000 };
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const deps: SessionDeps = {
    fetch: async (input, init) => {
      const body = init?.body instanceof FormData ? init.body : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const call = { url: String(input), body };
      calls.push(call);
      const next = script.shift();
      if (next === undefined) throw new Error(`unexpected request to ${call.url}`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(call) : next;
    },
    newId: () => ids.shift() ?? uuid(999),
    storage,
    now: () => clock.now,
    timeoutMs: options.timeoutMs
  };
  const session = new ImportSession(deps);
  return { session, calls, clock, storage, deps };
}

const pasteInput = (patch: Partial<ImportInput> = {}): Partial<ImportInput> => ({
  mode: "paste",
  text: TRANSCRIPT,
  title: "Q3 sync",
  meetingDate: "2026-10-15",
  ...patch
});

const PREVIEW_OK = { preview: { source: "manual_paste", format: "speaker_labeled", container: "text", segmentCount: 3, turnCount: 3, characterCount: 80, speakers: [{ label: "Alex", segmentCount: 2 }, { label: "Jordan", segmentCount: 1 }], hasSpeakers: true, hasTimeOffsets: false, hasAbsoluteTimestamps: false, warnings: [], sampleSegments: [] } };
const CREATED = (id = IMPORT_A, analysis: Record<string, unknown> = { status: "queued", jobId: "job-1", generation: 1 }) =>
  json(201, { meeting: { id }, import: { outcome: "created", segmentCount: 3, warnings: [] }, analysis });

async function previewed(h: ReturnType<typeof harness>, patch: Partial<ImportInput> = {}) {
  h.session.setInput(pasteInput(patch));
  await h.session.preview();
  h.session.setConfirmed(true);
}

// ------------------------------------------------------------------ validation feedback
test("client validation gives clear feedback for files and text", () => {
  const file = (name: string, content = "x", type = "") => new File([content], name, { type });
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "upload" }).file ?? "", /Choose a transcript file/);
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "upload", file: file("a.pdf") }).file ?? "", /\.txt, \.md, \.vtt or \.srt/);
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "upload", file: file("a.txt", "") }).file ?? "", /empty/);
  const big = Object.defineProperty(file("big.txt"), "size", { value: MAX_TRANSCRIPT_BYTES + 1 });
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "upload", file: big }).file ?? "", /at most 1 MB/);
  assert.deepEqual(validateInput({ ...EMPTY_INPUT, mode: "upload", file: file("A.VTT") }), {});
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "paste", text: "  \n " }).text ?? "", /Paste the transcript/);
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "paste", text: "é".repeat(MAX_TRANSCRIPT_BYTES / 2 + 1) }).text ?? "", /at most 1 MB/);
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "paste", text: "hi", meetingDate: "2999-01-01" }).meetingDate ?? "", /future/);
  assert.match(validateInput({ ...EMPTY_INPUT, mode: "paste", text: "hi", title: "x".repeat(201) }).title ?? "", /200/);
});

test("the meeting date is optional and never invented", async () => {
  const h = harness([json(200, PREVIEW_OK), CREATED()]);
  await previewed(h, { meetingDate: "" });
  await h.session.submit();
  const body = h.calls[1].body as Record<string, unknown>;
  assert.equal("meetingDate" in body, false, "no date is sent, and none is made up");
  assert.equal(h.session.getState().phase, "complete");
});

test("the default title: file name for uploads, a plain label for pastes", () => {
  assert.equal(effectiveTitle({ ...EMPTY_INPUT, mode: "upload", file: new File(["x"], "Q3 planning (Aug 19).vtt") }), "Q3 planning (Aug 19)");
  assert.equal(effectiveTitle({ ...EMPTY_INPUT, mode: "paste", text: "x" }), "Imported transcript");
  assert.equal(effectiveTitle({ ...EMPTY_INPUT, mode: "paste", title: "  My title " }), "My title");
});

// ------------------------------------------------------------------ preview
test("preview uses the existing preview route, sends no identity, and creates nothing", async () => {
  const h = harness([json(200, PREVIEW_OK)]);
  h.session.setInput(pasteInput({ projectId: "ignored-by-preview" }));
  await h.session.preview();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/meetings/import/preview");
  const body = h.calls[0].body as Record<string, unknown>;
  assert.equal(body.text, TRANSCRIPT);
  assert.equal(body.meetingDate, "2026-10-15");
  assert.ok(!("importId" in body) && !("title" in body) && !("projectId" in body));
  assert.equal(h.session.getState().phase, "previewed");
  assert.equal(h.session.getState().preview?.segmentCount, 3);
  assert.equal(h.storage!.data.size, 0, "nothing is remembered before an import is attempted");
});

test("preview validation failures never reach the network", async () => {
  const h = harness([]);
  h.session.setInput({ mode: "paste", text: "   " });
  await h.session.preview();
  assert.equal(h.calls.length, 0);
  assert.match(h.session.getState().fieldErrors.text ?? "", /Paste the transcript/);
  assert.equal(h.session.getState().phase, "editing");
});

test("server refusals during preview show beside the right field and keep the form editable", async () => {
  const h = harness([json(400, { error: "This file is not a text transcript. PDFs, documents, audio and video are not supported.", code: "binary_content" })]);
  h.session.setInput({ mode: "upload", file: new File(["%PDF-1.7"], "notes.txt") });
  await h.session.preview();
  const state = h.session.getState();
  assert.equal(state.phase, "editing");
  assert.match(state.fieldErrors.file ?? "", /not a text transcript/);
  assert.equal(state.maybeCreated, false);
});

test("any change after previewing invalidates the preview and the confirmation", async () => {
  const h = harness([json(200, PREVIEW_OK)]);
  await previewed(h);
  assert.equal(h.session.getState().confirmed, true);
  h.session.setInput({ text: `${TRANSCRIPT}\nJordan: Done.` });
  const state = h.session.getState();
  assert.equal(state.preview, null);
  assert.equal(state.confirmed, false);
  assert.equal(h.session.canSubmit(), false);
});

// ------------------------------------------------------------------ confirmation and double-click
test("analysis cannot run before the preview is confirmed", async () => {
  const h = harness([json(200, PREVIEW_OK)]);
  h.session.setInput(pasteInput());
  assert.equal(h.session.canSubmit(), false);
  assert.equal(h.session.submit(), null, "nothing to confirm yet");
  await h.session.preview();
  assert.equal(h.session.canSubmit(), false, "previewed but not confirmed");
  assert.equal(h.session.submit(), null);
  assert.equal(h.calls.length, 1, "only the preview request was sent");
  h.session.setConfirmed(true);
  assert.equal(h.session.canSubmit(), true);
});

test("a double click sends exactly one import request", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => (release = resolve));
  const h = harness([json(200, PREVIEW_OK), () => pending]);
  await previewed(h);
  const first = h.session.submit();
  const second = h.session.submit();
  const third = h.session.submit();
  assert.ok(first && second === first && third === first, "the same in-flight request is shared");
  assert.equal(h.session.canSubmit(), false);
  release(CREATED());
  await first;
  assert.equal(h.calls.filter((call) => call.url === "/api/meetings/import").length, 1);
});

// ------------------------------------------------------------------ successful import
test("a successful import carries the identity and goes to the normal meeting page", async () => {
  const h = harness([json(200, PREVIEW_OK), CREATED()]);
  await previewed(h, { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  await h.session.submit();
  const call = h.calls[1];
  assert.equal(call.url, "/api/meetings/import");
  assert.deepEqual(call.body, { meetingDate: "2026-10-15", importId: IMPORT_A, title: "Q3 sync", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text: TRANSCRIPT });
  const state = h.session.getState();
  assert.equal(state.phase, "complete");
  assert.equal(state.redirectTo, meetingPath(IMPORT_A));
  assert.equal(state.redirectTo, `/meetings/${IMPORT_A}`);
  assert.equal(state.analysis, "queued");
  assert.equal(h.storage!.data.has(DRAFT_STORAGE_KEY), false, "the draft is cleared once the import finished");
});

test("an upload is sent as multipart with the very file that was previewed", async () => {
  const file = new File([TRANSCRIPT], "sync.vtt", { type: "text/vtt" });
  const parts = buildRequest("import", { ...EMPTY_INPUT, mode: "upload", file, meetingDate: "2026-10-15" }, { importId: IMPORT_A, title: "sync" });
  assert.equal(parts.url, "/api/meetings/import");
  const form = parts.init.body as FormData;
  assert.equal(form.get("importId"), IMPORT_A);
  assert.equal(form.get("title"), "sync");
  assert.equal((form.get("file") as File).name, "sync.vtt");
  assert.equal(form.has("projectId"), false);
  assert.equal((parts.init.headers as unknown), undefined, "the browser sets the multipart boundary itself");
});

// ------------------------------------------------------------------ retry identity
test("a network failure keeps the import id, freezes the inputs, and the retry sends the identical request", async () => {
  const h = harness([json(200, PREVIEW_OK), new TypeError("Failed to fetch"), CREATED()]);
  await previewed(h);
  await h.session.submit();
  let state = h.session.getState();
  assert.equal(state.phase, "retry_needed");
  assert.equal(state.error?.kind, "unknown_outcome");
  assert.match(state.error?.message ?? "", /won't create a duplicate/);
  assert.equal(state.importId, IMPORT_A);
  assert.equal(h.session.lock(), "all");
  assert.equal(h.session.setInput({ text: "something else" }), false, "inputs are locked while the outcome is unknown");
  assert.equal(h.session.setInput({ title: "Renamed" }), false);

  const stored = JSON.parse(h.storage!.data.get(DRAFT_STORAGE_KEY)!);
  assert.equal(stored.importId, IMPORT_A);
  assert.ok(!JSON.stringify(stored).includes("requirements"), "the transcript is never stored in the browser");

  assert.equal(h.session.canSubmit(), true, "retrying needs no second confirmation");
  await h.session.submit();
  const [, first, retry] = h.calls;
  assert.deepEqual(retry.body, first.body, "byte-for-byte the same request, same import id");
  assert.equal((retry.body as { importId: string }).importId, IMPORT_A);
  assert.equal(h.session.getState().phase, "complete");
  assert.equal(h.storage!.data.has(DRAFT_STORAGE_KEY), false);
});

test("a request timeout is an unknown outcome, not a failure: the retry reuses the id", async () => {
  const h = harness([], { timeoutMs: 10 });
  // A fetch that honours the abort signal, like a real one.
  h.deps.fetch = (() => {
    let n = 0;
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      if (n === 1) return json(200, PREVIEW_OK);
      if (n === 2) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return CREATED();
    };
  })();
  await previewed(h);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "retry_needed");
  assert.equal(h.session.getState().importId, IMPORT_A);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete");
});

test("an unexpected server error is treated as unknown too, without leaking internals", async () => {
  const h = harness([json(200, PREVIEW_OK), json(500, { error: "connection to postgres://svc:secret@db failed", code: "internal_error" })]);
  await previewed(h);
  await h.session.submit();
  const state = h.session.getState();
  assert.equal(state.phase, "retry_needed");
  assert.doesNotMatch(JSON.stringify(state.error), /postgres|secret|svc/);
  assert.equal(state.importId, IMPORT_A);
});

test("a refused request that created nothing keeps the same id and lets the user fix and resend", async () => {
  const h = harness([
    json(200, PREVIEW_OK),
    json(404, { error: "Project not found.", code: "project_not_found", retryable: false }),
    json(200, PREVIEW_OK),
    CREATED()
  ]);
  await previewed(h, { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  await h.session.submit();
  const state = h.session.getState();
  assert.equal(state.phase, "previewed");
  assert.equal(state.error?.kind, "project");
  assert.match(state.fieldErrors.projectId ?? "", /isn't available/);
  assert.equal(state.importId, IMPORT_A, "no new UUID just because a request failed");
  assert.equal(state.maybeCreated, false);
  assert.equal(h.storage!.data.has(DRAFT_STORAGE_KEY), false, "nothing was created, so nothing is remembered");
  assert.equal(h.session.lock(), "none");

  // The user clears the project; the corrected request goes out under the same import id.
  h.session.setInput({ projectId: "" });
  await h.session.preview();
  h.session.setConfirmed(true);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete");
  const sent = h.calls.filter((call) => call.url === "/api/meetings/import").map((call) => call.body as Record<string, unknown>);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].importId, sent[1].importId);
  assert.equal("projectId" in sent[1], false);
});

test("session expiry (401) says nothing was imported and keeps the draft usable", async () => {
  const h = harness([json(200, PREVIEW_OK), json(401, { error: "Unauthorized" }), CREATED()]);
  await previewed(h);
  await h.session.submit();
  const state = h.session.getState();
  assert.equal(state.error?.kind, "session");
  assert.match(state.error?.message ?? "", /Sign in again/);
  assert.match(state.error?.message ?? "", /Nothing was imported/);
  assert.equal(state.phase, "previewed");
  assert.equal(state.importId, IMPORT_A);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete");
  assert.equal((h.calls[1].body as { importId: string }).importId, (h.calls[2].body as { importId: string }).importId);
});

test("Start new import is the only way to a new id, and it keeps the user's inputs", async () => {
  const h = harness([json(200, PREVIEW_OK), new TypeError("offline")]);
  await previewed(h);
  await h.session.submit();
  assert.equal(h.session.getState().importId, IMPORT_A);
  h.session.startNewImport();
  const state = h.session.getState();
  assert.equal(state.importId, IMPORT_B);
  assert.equal(state.phase, "editing");
  assert.equal(state.input.text, TRANSCRIPT);
  assert.equal(h.session.lock(), "none");
  assert.equal(h.storage!.data.has(DRAFT_STORAGE_KEY), false);
  assert.equal(state.preview, null);
});

// ------------------------------------------------------------------ API outcomes
test("every documented API outcome maps to clear, safe copy", () => {
  const cases: Array<[number, unknown, string | null, string, RegExp]> = [
    [400, { error: "The transcript is not valid UTF-8 text.", code: "invalid_utf8" }, null, "input", /UTF-8/],
    [413, { error: "The request is too large. Transcripts can be at most 1 MB.", code: "request_too_large" }, null, "input", /1 MB/],
    [401, { error: "Unauthorized" }, null, "session", /Sign in again/],
    [404, { error: "Project not found.", code: "project_not_found" }, null, "project", /Choose another project/],
    [409, { code: "import_id_conflict", error: "x" }, null, "conflict", /Start a new import/],
    [409, { code: "import_failed", error: "x", meetingId: "m1" }, null, "conflict", /can't be resumed/],
    [409, { code: "import_in_progress", error: "x", meetingId: "m1" }, "15", "in_progress", /still being processed/],
    [429, { code: "rate_limited", error: "You can import up to 10 transcripts per hour. Try again later." }, "3600", "rate_limit", /10 transcripts per hour/],
    [500, { code: "import_incomplete", retryable: true, meetingId: "m1", error: "x" }, null, "incomplete", /Retry to finish/],
    [500, { code: "import_incomplete", retryable: false, meetingId: "m1", error: "x" }, null, "conflict", /Open the meeting/],
    [500, { code: "internal_error", error: "stack trace at Object.<anonymous>" }, null, "unknown_outcome", /Something went wrong on our side/],
    [502, "<html>Bad gateway</html>", null, "unknown_outcome", /couldn't confirm/]
  ];
  for (const [status, body, retryAfter, kind, message] of cases) {
    const result = classifyImportResponse(status, body, retryAfter);
    assert.equal(result.kind, "error", `${status}`);
    if (result.kind !== "error") continue;
    assert.equal(result.error.kind, kind, `${status} ${JSON.stringify(body)}`);
    assert.match(result.error.message, message);
    assert.doesNotMatch(result.error.message, /stack trace|Bad gateway|Object\.</);
  }
  assert.equal(classifyImportResponse(429, { code: "rate_limited", error: "Limit." }, "90")?.kind, "error");
});

test("rate limiting and in-progress responses respect Retry-After", async () => {
  const h = harness([
    json(200, PREVIEW_OK),
    json(429, { code: "rate_limited", error: "You can import up to 10 transcripts per hour. Try again later.", retryable: true }, { "Retry-After": "3600" }),
    CREATED()
  ]);
  await previewed(h);
  await h.session.submit();
  let state = h.session.getState();
  assert.equal(state.error?.kind, "rate_limit");
  assert.equal(state.retryAt, h.clock.now + 3_600_000);
  assert.equal(h.session.canSubmit(), false, "blocked until Retry-After has passed");
  assert.equal(h.session.submit(), null);
  h.clock.now += 3_600_001;
  assert.equal(h.session.canSubmit(), true);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete");

  const g = harness([json(200, PREVIEW_OK), json(409, { code: "import_in_progress", error: "x", meetingId: IMPORT_A, retryable: true }, { "Retry-After": "15" }), CREATED()]);
  await previewed(g);
  await g.session.submit();
  state = g.session.getState();
  assert.equal(state.phase, "retry_needed");
  assert.equal(state.error?.kind, "in_progress");
  assert.equal(g.session.canSubmit(), false);
  g.clock.now += 16_000;
  assert.equal(g.session.canSubmit(), true);
  await g.session.submit();
  assert.equal(g.session.getState().phase, "complete");
});

test("an import id conflict blocks retries and offers only a new import", async () => {
  const h = harness([json(200, PREVIEW_OK), json(409, { code: "import_id_conflict", error: "x", retryable: false })]);
  await previewed(h);
  await h.session.submit();
  const state = h.session.getState();
  assert.equal(state.phase, "blocked");
  assert.equal(h.session.canSubmit(), false);
  assert.equal(h.session.submit(), null);
  h.session.startNewImport();
  assert.equal(h.session.getState().importId, IMPORT_B);
});

test("a retryable incomplete import (meeting created, segments not saved) retries with the same id", async () => {
  const h = harness([
    json(200, PREVIEW_OK),
    json(500, { code: "import_incomplete", error: "x", retryable: true, meetingId: IMPORT_A }),
    json(200, { meeting: { id: IMPORT_A }, import: { outcome: "recovered", segmentCount: 3, warnings: [] }, analysis: { status: "queued", jobId: "j", generation: 1 } })
  ]);
  await previewed(h);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "retry_needed");
  assert.equal(h.session.getState().error?.kind, "incomplete");
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete");
  assert.equal(h.session.getState().redirectTo, meetingPath(IMPORT_A));
});

test("if analysis could not start, the saved meeting is offered instead of a second import", async () => {
  const h = harness([json(200, PREVIEW_OK), CREATED(IMPORT_A, { status: "enqueue_failed" })]);
  await previewed(h);
  await h.session.submit();
  const state = h.session.getState();
  assert.equal(state.phase, "saved_not_queued");
  assert.equal(state.analysis, "not_started");
  assert.equal(state.redirectTo, `/meetings/${IMPORT_A}`);
  assert.equal(h.session.canSubmit(), false, "no way to import again");
  assert.equal(h.calls.filter((call) => call.url === "/api/meetings/import").length, 1);
  assert.equal(h.storage!.data.has(DRAFT_STORAGE_KEY), false);
});

// ------------------------------------------------------------------ refresh and resume
test("after a page refresh the import resumes with the same id, locked details, and the content asked for again", async () => {
  const storage = memoryStorage();
  const first = harness([json(200, PREVIEW_OK), new TypeError("offline")], { storage });
  await previewed(first, { title: "Q3 sync", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  await first.session.submit();
  assert.equal(first.session.getState().phase, "retry_needed");

  // A new page load: a brand-new session on the same tab storage.
  const second = harness([json(200, PREVIEW_OK), json(200, { meeting: { id: IMPORT_A }, import: { outcome: "already_imported", segmentCount: 3, warnings: [] }, analysis: { status: "existing", jobStatus: "queued", jobId: "j" } })], { storage, ids: [IMPORT_B] });
  assert.equal(second.session.getState().importId, IMPORT_B, "a fresh session starts with a fresh id...");
  assert.equal(second.session.restore(), true);
  let state = second.session.getState();
  assert.equal(state.importId, IMPORT_A, "...until the interrupted import is restored");
  assert.equal(state.resumedFrom?.title, "Q3 sync");
  assert.equal(state.input.title, "Q3 sync");
  assert.equal(state.input.projectId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(state.input.text, "", "the transcript itself was not stored");
  assert.equal(second.session.lock(), "details");
  assert.equal(second.session.setInput({ title: "Different" }), false, "details must match the interrupted import");
  assert.equal(second.session.setInput({ projectId: "" }), false);

  // The user pastes the same transcript again; it still needs a preview and a confirmation.
  assert.equal(second.session.setInput({ mode: "paste", text: TRANSCRIPT }), false, "the source mode is locked too");
  assert.equal(second.session.setInput({ text: TRANSCRIPT }), true);
  assert.equal(second.session.canSubmit(), false);
  await second.session.preview();
  second.session.setConfirmed(true);
  assert.equal(second.session.canSubmit(), true);
  await second.session.submit();
  state = second.session.getState();
  assert.equal(state.phase, "complete");
  assert.equal(state.redirectTo, `/meetings/${IMPORT_A}`);
  const importCall = second.calls[1].body as Record<string, unknown>;
  assert.equal(importCall.importId, IMPORT_A);
  assert.equal(importCall.title, "Q3 sync");
  assert.equal(storage.data.has(DRAFT_STORAGE_KEY), false);
});

test("a resumed upload must be the same kind of file", async () => {
  const storage = memoryStorage();
  const first = harness([json(200, PREVIEW_OK), new TypeError("offline")], { storage });
  first.session.setInput({ mode: "upload", file: new File([TRANSCRIPT], "sync.vtt"), meetingDate: "2026-10-15" });
  await first.session.preview();
  first.session.setConfirmed(true);
  await first.session.submit();

  const second = harness([], { storage });
  second.session.restore();
  assert.equal(second.session.getState().resumedFrom?.fileName, "sync.vtt");
  second.session.setInput({ file: new File([TRANSCRIPT], "sync.txt") });
  await second.session.preview();
  assert.match(second.session.getState().fieldErrors.file ?? "", /started with a \.vtt file/);
  assert.equal(second.calls.length, 0);
});

test("restoring ignores corrupt, foreign and expired drafts, and never overrides work in progress", async () => {
  for (const bad of ["not json", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, importId: "nope", mode: "paste", title: "", meetingDate: "", projectId: "", startedAt: 1_000_000 }), JSON.stringify({ v: 1, importId: IMPORT_A, mode: "paste", title: "t", meetingDate: "", projectId: "", startedAt: 1_000_000 - 25 * 3600 * 1000 })]) {
    const h = harness([], { storage: memoryStorage({ [DRAFT_STORAGE_KEY]: bad }) });
    assert.equal(h.session.restore(), false);
    assert.equal(h.session.getState().importId, IMPORT_A);
    assert.equal(h.session.getState().resumedFrom, null);
  }
  const good = { v: 1, importId: IMPORT_B, mode: "paste", fileName: null, title: "t", meetingDate: "", projectId: "", startedAt: 1_000_000 };
  const h = harness([], { storage: memoryStorage({ [DRAFT_STORAGE_KEY]: JSON.stringify(good) }) });
  h.session.setInput({ mode: "paste", text: "already typing" });
  assert.equal(h.session.restore(), true, "typing alone is not a started import");
  const g = harness([json(200, PREVIEW_OK)], { storage: memoryStorage({ [DRAFT_STORAGE_KEY]: JSON.stringify(good) }) });
  g.session.setInput(pasteInput());
  await g.session.preview();
  assert.equal(g.session.restore(), false, "a previewed session is never replaced");
  const unavailable = harness([], { storage: null });
  assert.equal(unavailable.session.restore(), false);
});

// ------------------------------------------------------------------ the browser's requests against the real routes
function routeFetch(db: ImportDb, user: string | null = USER_A): SessionDeps["fetch"] {
  const auth = async () => (user ? { user: { id: user }, response: null } : { user: null, response: Response.json({ error: "Unauthorized" }, { status: 401 }) });
  return async (input, init) => {
    const request = new Request(`http://localhost${String(input)}`, { method: init?.method, headers: init?.headers, body: init?.body as BodyInit, ...(init?.body instanceof FormData ? {} : {}) });
    return String(input).endsWith("/preview")
      ? handleTranscriptPreview(request, { requireUser: auth })
      : handleTranscriptImport(request, { requireUser: auth, importDeps: db.deps() });
  };
}

test("the real routes accept what the form sends: paste, then an identical retry", async () => {
  const db = new ImportDb();
  const h = harness([]);
  h.deps.fetch = routeFetch(db);
  h.session.setInput(pasteInput({ projectId: "" }));
  await h.session.preview();
  assert.equal(h.session.getState().phase, "previewed", JSON.stringify(h.session.getState().error));
  assert.equal(h.session.getState().preview?.segmentCount, 3);
  assert.equal(db.meetings.size, 0, "preview created nothing");
  h.session.setConfirmed(true);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete", JSON.stringify(h.session.getState().error));
  assert.equal(db.meetings.size, 1);
  assert.equal(db.meetings.get(IMPORT_A)!.source, "manual_paste");
  assert.equal(db.meetings.get(IMPORT_A)!.meeting_date, "2026-10-15");
  assert.equal(db.meetings.get(IMPORT_A)!.title, "Q3 sync");
  assert.deepEqual(db.enqueueCalls, [IMPORT_A]);

  // The user comes back with the same import (a refresh mid-flight, say): same id, same content.
  const again = harness([], { storage: memoryStorage(), ids: [IMPORT_A] });
  again.deps.fetch = routeFetch(db);
  again.session.setInput(pasteInput());
  await again.session.preview();
  again.session.setConfirmed(true);
  await again.session.submit();
  assert.equal(again.session.getState().phase, "complete");
  assert.equal(db.meetings.size, 1, "an identical retry created no second meeting");
  assert.deepEqual(db.enqueueCalls, [IMPORT_A], "and queued no second analysis");
});

test("the real routes accept an upload, default the title from the file name, and report a conflict for changed content", async () => {
  const db = new ImportDb();
  const h = harness([]);
  h.deps.fetch = routeFetch(db);
  h.session.setInput({ mode: "upload", file: new File(["WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alex>I'll send it Friday.\n\n00:00:04.000 --> 00:00:06.000\n<v Jordan>I'll review it Monday.\n"], "Q3 planning.vtt", { type: "text/vtt" }), meetingDate: "2026-10-15" });
  await h.session.preview();
  assert.equal(h.session.getState().preview?.format, "webvtt");
  h.session.setConfirmed(true);
  await h.session.submit();
  assert.equal(h.session.getState().phase, "complete", JSON.stringify(h.session.getState().error));
  assert.equal(db.meetings.get(IMPORT_A)!.title, "Q3 planning");
  assert.equal(db.meetings.get(IMPORT_A)!.source, "manual_upload");

  // Same import id, different content: the server refuses and the form offers a new import.
  const clash = harness([], { storage: memoryStorage(), ids: [IMPORT_A] });
  clash.deps.fetch = routeFetch(db);
  clash.session.setInput(pasteInput());
  await clash.session.preview();
  clash.session.setConfirmed(true);
  await clash.session.submit();
  assert.equal(clash.session.getState().phase, "blocked");
  assert.equal(clash.session.getState().error?.kind, "conflict");
  assert.equal(db.meetings.size, 1);
});

test("a signed-out browser gets the session-expired message from the real routes", async () => {
  const db = new ImportDb();
  const h = harness([]);
  h.deps.fetch = routeFetch(db, null);
  h.session.setInput(pasteInput());
  await h.session.preview();
  assert.equal(h.session.getState().error?.kind, "session");
  assert.equal(db.meetings.size, 0);
});
