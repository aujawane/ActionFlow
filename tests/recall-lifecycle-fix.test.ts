import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Webhook route: verification gates everything, no duplicated classification logic,
// transient failures are not swallowed behind a 200.
// ---------------------------------------------------------------------------

test("the webhook route verifies the signature before parsing/acting on the payload", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  const verifyIndex = source.indexOf("verifyRecallWebhookPayload(");
  const parseIndex = source.indexOf("JSON.parse(rawBody");
  assert.ok(verifyIndex > -1 && parseIndex > -1);
  assert.ok(verifyIndex < parseIndex, "signature verification must run before JSON parsing");
  assert.match(source, /if \(!verification\.ok\) \{[\s\S]{0,300}status: 401/);
});

test("the webhook route determines verification requirement via VERCEL_ENV, not NODE_ENV alone -- Preview deployments must not bypass auth", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  assert.match(
    source,
    /import \{\s*shouldRequireRecallWebhookVerification,\s*verifyRecallWebhookPayload\s*\} from "@\/lib\/recall\/webhook-auth";/
  );
  assert.match(
    source,
    /requireVerification: shouldRequireRecallWebhookVerification\(\{\s*NODE_ENV: process\.env\.NODE_ENV,\s*VERCEL_ENV: process\.env\.VERCEL_ENV\s*\}\)/
  );
});

test("the webhook route reuses the shared bot-id extractor and effect resolver -- no local duplicate classifiers", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  assert.match(
    source,
    /import \{ extractRecallBotId, resolveRecallWebhookEffect \} from "@\/lib\/recall\/webhook-events";/
  );
  assert.doesNotMatch(source, /function isCompletionEvent/);
  assert.doesNotMatch(source, /function isFailureEvent/);
  assert.doesNotMatch(source, /function isRecordingEvent/);
  assert.doesNotMatch(source, /function isJoiningEvent/);
});

test("a processing failure returns a non-2xx status so Recall retries, instead of swallowing it behind ok:true", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  const catchBlock = source.match(/\} catch \(error\) \{[\s\S]*?\n  \}\n\}/);
  assert.ok(catchBlock, "expected a catch block in the POST handler");
  assert.match(catchBlock![0], /status: 502/);
  assert.doesNotMatch(catchBlock![0], /ok: true/);
});

test("permanently non-actionable deliveries (bad JSON, no bot id, no matching meeting) are acknowledged with 200, not retried forever", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  assert.match(source, /catch \{[\s\S]{0,400}NextResponse\.json\(\{ ok: true \}\)/);
  assert.match(source, /if \(!recallBotId\) \{[\s\S]{0,400}NextResponse\.json\(\{ ok: true \}\)/);
  assert.match(source, /if \(meetingError \|\| !meeting\) \{[\s\S]{0,400}NextResponse\.json\(\{ ok: true \}\)/);
});

test("the webhook route never awaits the heavy transcript fetch/download/import inline -- it dispatches the durable workflow instead", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  // processCompletedRecallMeeting (which calls Recall's API) must not be imported/called directly
  // by the route anymore -- only the fast, queue-only dispatch helper is. (It may still be
  // *mentioned in a comment* explaining why the dispatched job is safe to duplicate.)
  assert.doesNotMatch(source, /import \{[^}]*processCompletedRecallMeeting/);
  assert.doesNotMatch(source, /[^/]\bprocessCompletedRecallMeeting\(/);
  assert.doesNotMatch(source, /fetchRecallTranscript/);
  assert.match(
    source,
    /import \{ enqueueRecallTranscriptImport \} from "@\/lib\/recall\/enqueue-transcript-import";/
  );
  assert.match(source, /await enqueueRecallTranscriptImport\(\{/);
});

test("import_transcript still persists minimal lifecycle state (processing) inline before dispatching the durable job", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  const dispatchIndex = source.indexOf("await enqueueRecallTranscriptImport(");
  const guardedStatusIndex = source.lastIndexOf(
    'applyGuardedMeetingStatus(meeting.id, "processing")',
    dispatchIndex
  );
  assert.ok(dispatchIndex > -1 && guardedStatusIndex > -1);
  assert.ok(
    guardedStatusIndex < dispatchIndex,
    "the guarded status write must happen before the durable dispatch"
  );
});

test("the webhook route responds promptly (2xx) once the import is queued, not once it's complete", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  const dispatchIndex = source.indexOf("await enqueueRecallTranscriptImport(");
  const responseIndex = source.indexOf('NextResponse.json({ ok: true, status: "processing", queued: true })');
  assert.ok(dispatchIndex > -1 && responseIndex > -1);
  assert.ok(dispatchIndex < responseIndex);
});

test("the durable workflow reuses processCompletedRecallMeeting -- the exact same logic sync-status calls synchronously", async () => {
  const stepSource = await readSource("lib/recall/transcript-import-step.ts");
  assert.match(
    stepSource,
    /import \{ processCompletedRecallMeeting \} from "@\/lib\/recall\/processing";/
  );
  assert.match(stepSource, /"use step";/);
  assert.match(stepSource, /await processCompletedRecallMeeting\(input\)/);
});

test("the transcript-import workflow is a durable Workflow SDK workflow, matching the existing meeting-analysis pattern", async () => {
  const workflowSource = await readSource("lib/recall/transcript-import-workflow.ts");
  assert.match(workflowSource, /"use workflow";/);
  assert.match(workflowSource, /import \{ importRecallTranscriptStep \} from "@\/lib\/recall\/transcript-import-step";/);
});

test("dispatching the transcript-import workflow is awaited directly, NOT deferred via after() -- unlike enqueueMeetingAnalysis, this dispatch must be able to fail the HTTP response", async () => {
  const source = await readSource("lib/recall/enqueue-transcript-import.ts");
  assert.match(source, /import \{ start \} from "workflow\/api";/);
  assert.match(source, /start\(recallTranscriptImportWorkflow, \[input\]\)/);
  // `after()` is discussed in comments explaining why it's deliberately NOT used here -- check
  // for the actual import/call, not the word "after(" anywhere (which the prose itself contains).
  assert.doesNotMatch(source, /import \{ after \} from "next\/server";/);
  assert.doesNotMatch(source, /after\(\(\)/);
});

test("a dispatch failure is allowed to throw/reject -- see tests/recall-enqueue-transcript-import.test.ts for the direct functional proof", async () => {
  const source = await readSource("lib/recall/enqueue-transcript-import.ts");
  assert.match(source, /export async function enqueueRecallTranscriptImport\(/);
  const fnMatch = source.match(/export async function enqueueRecallTranscriptImport\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  // No try/catch around the dispatch: a startWorkflow() rejection must propagate to the caller.
  assert.doesNotMatch(fnMatch![0], /catch/);
});

test("the webhook route awaits enqueueRecallTranscriptImport inside the try block that returns 502 on failure -- a dispatch failure becomes a non-2xx response, not a swallowed 200", async () => {
  const source = await readSource("app/api/recall/webhook/route.ts");
  const tryStart = source.indexOf("  try {");
  const dispatchIndex = source.indexOf("await enqueueRecallTranscriptImport(");
  const catchStart = source.indexOf("} catch (error) {");
  assert.ok(tryStart > -1 && dispatchIndex > -1 && catchStart > -1);
  assert.ok(
    tryStart < dispatchIndex && dispatchIndex < catchStart,
    "enqueueRecallTranscriptImport must be awaited between the try and its catch"
  );
  assert.match(source.slice(catchStart), /status: 502/);
});

test("[idempotency] duplicate webhook deliveries dispatching the workflow twice are safe: the underlying step is the same short-circuiting processCompletedRecallMeeting", async () => {
  const { shouldSkipDuplicateCompletion } = await import("../lib/recall/webhook-events");
  // A second dispatch for a meeting already at transcript_ready/completed is a no-op once the
  // step runs -- this is the same guard proven directly against processCompletedRecallMeeting
  // below; asserting it here documents why re-dispatching a duplicate event is safe.
  assert.equal(shouldSkipDuplicateCompletion("transcript_ready"), true);
  assert.equal(shouldSkipDuplicateCompletion("completed"), true);
});

// ---------------------------------------------------------------------------
// Transcript processing: idempotent short-circuit + forward-only status writes.
// ---------------------------------------------------------------------------

test("processCompletedRecallMeeting skips re-import and re-enqueue for a meeting that already has its transcript", async () => {
  const source = await readSource("lib/recall/processing.ts");
  const start = source.indexOf("export async function processCompletedRecallMeeting");
  assert.ok(start > -1, "expected processCompletedRecallMeeting");
  const fn = source.slice(start); // last export in the file -- safe to run to EOF
  const guardIndex = fn.indexOf("shouldSkipDuplicateCompletion");
  const enqueueIndex = fn.indexOf("enqueueMeetingAnalysis(");
  assert.ok(guardIndex > -1 && enqueueIndex > -1);
  assert.ok(guardIndex < enqueueIndex, "the duplicate-completion guard must run before enqueueing analysis");
  assert.match(fn, /status: "already_processed"/);
});

test("a call that has ended but has no downloadable transcript yet stays in processing, never reverts to recording", async () => {
  const source = await readSource("lib/recall/processing.ts");
  const start = source.indexOf("export async function processCompletedRecallMeeting");
  const fn = source.slice(start);
  assert.match(fn, /if \(!transcriptResult\.ready\) \{[\s\S]{0,300}applyGuardedMeetingStatus\(meetingId, "processing"\)/);
  assert.doesNotMatch(fn, /status: "recording"/);
});

test("every automatic status write in processCompletedRecallMeeting goes through the forward-only guard, not a raw update", async () => {
  const source = await readSource("lib/recall/processing.ts");
  const start = source.indexOf("export async function processCompletedRecallMeeting");
  const fn = source.slice(start);
  assert.doesNotMatch(fn, /\.update\(\{ status:/);
  assert.match(fn, /applyGuardedMeetingStatus\(meetingId, "processing"\)/);
  assert.match(fn, /applyGuardedMeetingStatus\(meetingId, "transcript_ready"\)/);
});

test("applyGuardedMeetingStatus writes are scoped with .in(\"status\", priorStatuses) -- atomic, no read-then-write race on the guard itself", async () => {
  const source = await readSource("lib/recall/processing.ts");
  const start = source.indexOf("export async function applyGuardedMeetingStatus");
  const end = source.indexOf("export async function replaceMeetingTranscriptFromRecall");
  assert.ok(start > -1 && end > start);
  const fn = source.slice(start, end);
  assert.match(fn, /\.in\("status", priorStatuses\)/);
});

test("transcript re-import stays duplicate-safe: existing segments are deleted before the new set is inserted", async () => {
  const source = await readSource("lib/recall/processing.ts");
  const deleteIndex = source.indexOf('.from("transcript_segments")\n    .delete()');
  const insertIndex = source.indexOf('.from("transcript_segments")\n    .insert(');
  assert.ok(deleteIndex > -1 && insertIndex > -1);
  assert.ok(deleteIndex < insertIndex, "delete must precede insert so a duplicate import can't create duplicate rows");
});

// ---------------------------------------------------------------------------
// Meeting creation: bot creation alone is not proof of recording.
// ---------------------------------------------------------------------------

test("successful bot creation sets status to joining, not recording", async () => {
  const source = await readSource("app/api/meetings/route.ts");
  const updateBlock = source.match(/\.update\(\{[\s\S]*?recall_bot_id: bot\.id,[\s\S]*?\}\)/);
  assert.ok(updateBlock, "expected the post-bot-creation update call");
  assert.match(updateBlock![0], /status: "joining"/);
  assert.doesNotMatch(updateBlock![0], /status: "recording"/);
});

// ---------------------------------------------------------------------------
// sync-status: manual recovery only, reuses the shared lifecycle mapping (no duplicated heuristics).
// ---------------------------------------------------------------------------

test("sync-status reuses the shared bot-status-code mapping instead of its own substring heuristics", async () => {
  const source = await readSource("app/api/meetings/[id]/sync-status/route.ts");
  assert.match(
    source,
    /import \{ mapBotLifecycleCodeToMeetingStatus \} from "@\/lib\/recall\/webhook-events";/
  );
  assert.doesNotMatch(source, /function isRecallActive/);
  assert.doesNotMatch(source, /function isRecallDone/);
});

test("sync-status checks for the renamed \"processing\" result, not the old \"recording\" variant", async () => {
  const source = await readSource("app/api/meetings/[id]/sync-status/route.ts");
  assert.match(source, /result\.status === "processing"/);
});

// ---------------------------------------------------------------------------
// Manual Analyze: distinguishes processing / failed / genuinely-no-transcript without fetching itself.
// ---------------------------------------------------------------------------

test("Analyze still only reads persisted transcript_segments -- it never fetches from Recall itself", async () => {
  const source = await readSource("app/api/meetings/[id]/analyze/route.ts");
  assert.doesNotMatch(source, /fetchRecallTranscript/);
  assert.doesNotMatch(source, /processCompletedRecallMeeting/);
});

test("Analyze distinguishes a still-processing meeting, a failed meeting, and genuinely no transcript", async () => {
  const source = await readSource("app/api/meetings/[id]/analyze/route.ts");
  assert.match(source, /error: "Meeting processing failed"/);
  assert.match(source, /error: "Transcript is still processing"/);
  assert.match(source, /error: "No transcript available yet"/);
});

// ---------------------------------------------------------------------------
// UI: Sync Status is a normal user-facing recovery action; Reimport Transcript stays dev-only.
// ---------------------------------------------------------------------------

test("Sync Status is gated by meeting status via isSyncStatusRecoverable, never by showDevReimport/NODE_ENV; Reimport Transcript stays dev-only", async () => {
  const source = await readSource("components/meeting-actions.tsx");
  assert.match(
    source,
    /import \{ isSyncStatusRecoverable, type MeetingStatus \} from "@\/lib\/recall\/webhook-events";/
  );
  const syncGateIndex = source.indexOf("isSyncStatusRecoverable(meetingStatus) ? (");
  const syncButtonIndex = source.indexOf('{busy === "sync" ? "Syncing..." : "Sync Status"}');
  const showDevReimportGateIndex = source.indexOf("showDevReimport ? (");
  const reimportButtonIndex = source.indexOf('{busy === "reimport" ? "Reimporting..." : "Reimport Transcript"}');
  assert.ok(
    syncGateIndex > -1 && syncButtonIndex > -1 && showDevReimportGateIndex > -1 && reimportButtonIndex > -1
  );
  assert.ok(
    syncGateIndex < syncButtonIndex && syncButtonIndex < showDevReimportGateIndex,
    "Sync Status must be gated by isSyncStatusRecoverable, and rendered outside the showDevReimport-gated block"
  );
  assert.ok(
    showDevReimportGateIndex < reimportButtonIndex,
    "Reimport Transcript must remain inside the showDevReimport-gated block"
  );
  // Never conditioned on NODE_ENV/showDevReimport for the sync button specifically.
  const syncBlock = source.slice(syncGateIndex, source.indexOf(") : null}", syncGateIndex));
  assert.doesNotMatch(syncBlock, /NODE_ENV/);
  assert.doesNotMatch(syncBlock, /showDevReimport/);
});

test("the meeting detail page passes the real meeting status into MeetingActions", async () => {
  const source = await readSource("app/meetings/[id]/page.tsx");
  const componentBlock = source.match(/<MeetingActions[\s\S]*?\/>/);
  assert.ok(componentBlock, "expected a <MeetingActions ... /> element");
  assert.match(componentBlock![0], /meetingStatus=\{meeting\.status\}/);
});

test("[required] isSyncStatusRecoverable is true for joining, recording, and processing", async () => {
  const { isSyncStatusRecoverable } = await import("../lib/recall/webhook-events");
  assert.equal(isSyncStatusRecoverable("joining"), true);
  assert.equal(isSyncStatusRecoverable("recording"), true);
  assert.equal(isSyncStatusRecoverable("processing"), true);
});

test("[required] isSyncStatusRecoverable is false for pending, transcript_ready, completed, and failed", async () => {
  const { isSyncStatusRecoverable } = await import("../lib/recall/webhook-events");
  for (const status of ["pending", "transcript_ready", "completed", "failed"] as const) {
    assert.equal(isSyncStatusRecoverable(status), false, status);
  }
});

test("[required] a meeting stuck at status=recording with zero transcript segments WILL render Sync Status in production", async () => {
  const { isSyncStatusRecoverable } = await import("../lib/recall/webhook-events");
  // The button's visibility depends only on meeting status (isSyncStatusRecoverable), never on
  // transcript_segments count or NODE_ENV -- so this exact production incident (status=recording,
  // 0 segments) renders it regardless of environment.
  assert.equal(isSyncStatusRecoverable("recording"), true);
});

test("[required] Sync Status click behavior: calls the existing sync-status route, disables while syncing, refreshes on success", async () => {
  const source = await readSource("components/meeting-actions.tsx");
  const fnMatch = source.match(/async function syncStatus\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(fnMatch, "expected a syncStatus function");
  const fn = fnMatch![0];
  assert.match(fn, /setBusy\("sync"\);/);
  assert.match(fn, /fetch\(`\/api\/meetings\/\$\{meetingId\}\/sync-status`, \{\s*method: "POST"/);
  assert.match(fn, /router\.refresh\(\);/);
  assert.match(fn, /setMessage\(/);
  // No second/duplicate endpoint or reimplemented Recall reconciliation logic.
  assert.doesNotMatch(source, /\/api\/meetings\/\$\{meetingId\}\/(?!sync-status|analyze)/);
});

test("[required] the disabled={busy !== null} guard applies to the Sync Status button, preventing duplicate clicks while syncing", async () => {
  const source = await readSource("components/meeting-actions.tsx");
  const syncGateIndex = source.indexOf("isSyncStatusRecoverable(meetingStatus) ? (");
  const syncBlockEnd = source.indexOf(") : null}", syncGateIndex);
  const syncBlock = source.slice(syncGateIndex, syncBlockEnd);
  assert.match(syncBlock, /disabled=\{busy !== null\}/);
});

// ---------------------------------------------------------------------------
// No production polling was introduced.
// ---------------------------------------------------------------------------

test("no polling loop (setInterval/cron) was introduced anywhere in the Recall integration", async () => {
  const files = [
    "app/api/recall/webhook/route.ts",
    "app/api/meetings/[id]/sync-status/route.ts",
    "lib/recall/processing.ts",
    "lib/recall/webhook-events.ts",
    "lib/recall/webhook-auth.ts",
    "lib/recall/enqueue-transcript-import.ts",
    "lib/recall/transcript-import-workflow.ts",
    "lib/recall/transcript-import-step.ts",
    "components/meeting-actions.tsx"
  ];
  for (const file of files) {
    const source = await readSource(file);
    assert.doesNotMatch(source, /setInterval/, file);
    assert.doesNotMatch(source, /node-cron|vercel\.json.*cron/i, file);
  }
});
