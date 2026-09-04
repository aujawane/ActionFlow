import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedPriorStatuses,
  extractRecallBotId,
  mapBotLifecycleCodeToMeetingStatus,
  resolveRecallWebhookEffect,
  shouldSkipDuplicateCompletion
} from "../lib/recall/webhook-events";

/** Recall's current documented bot lifecycle payload shape: the top-level `event` field IS the
 * specific transition (e.g. "bot.call_ended"), and diagnostic detail lives at the DOUBLY-nested
 * `data.data.*` -- the outer `data` is the webhook envelope, the inner `data` is the
 * status-change record itself. Bot id lives at `data.bot.id`. */
function botLifecyclePayload(
  code: string,
  extra: Record<string, unknown> = {},
  botId = "bot-123"
) {
  return {
    data: {
      data: { code, sub_code: null, updated_at: "2026-09-04T12:00:00.000Z", ...extra },
      bot: { id: botId }
    }
  };
}

// ---------------------------------------------------------------------------
// Payload resolution
// ---------------------------------------------------------------------------

test("bot id resolves from data.bot.id for the current documented bot lifecycle/artifact shape", () => {
  const payload = { event: "bot.call_ended", ...botLifecyclePayload("call_ended", {}, "bot-xyz") };
  assert.equal(extractRecallBotId(payload), "bot-xyz");
});

test("bot id resolves from data.bot.id for artifact events too", () => {
  const payload = { event: "transcript.done", data: { bot: { id: "bot-abc" } } };
  assert.equal(extractRecallBotId(payload), "bot-abc");
});

test("bot id extraction falls back to legacy/back-compat shapes and numeric ids", () => {
  assert.equal(extractRecallBotId({ data: { bot_id: "bot-legacy" } }), "bot-legacy");
  assert.equal(extractRecallBotId({ bot: { id: 456 } }), "456");
  assert.equal(extractRecallBotId({ bot_id: "bot-top-level" }), "bot-top-level");
  assert.equal(extractRecallBotId({}), null);
});

test("data.data.sub_code diagnostics are read from the documented doubly-nested shape", () => {
  const payload = { event: "bot.fatal", ...botLifecyclePayload("fatal", { sub_code: "meeting_not_started" }) };
  const { diagnostics } = resolveRecallWebhookEffect(payload, "bot.fatal");
  assert.equal(diagnostics.subCode, "meeting_not_started");
  assert.equal(diagnostics.statusCode, "fatal");
  assert.equal(diagnostics.updatedAt, "2026-09-04T12:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Canonical bot.* lifecycle events (current Recall dashboard schema)
// ---------------------------------------------------------------------------

test("bot.joining_call maps to joining", () => {
  const payload = { event: "bot.joining_call", ...botLifecyclePayload("joining_call") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.joining_call");
  assert.deepEqual(effect, { action: "set_status", status: "joining" });
});

test("bot.in_waiting_room maps to joining", () => {
  const payload = { event: "bot.in_waiting_room", ...botLifecyclePayload("in_waiting_room") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.in_waiting_room");
  assert.deepEqual(effect, { action: "set_status", status: "joining" });
});

test("bot.in_call_not_recording maps to joining", () => {
  const payload = { event: "bot.in_call_not_recording", ...botLifecyclePayload("in_call_not_recording") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.in_call_not_recording");
  assert.deepEqual(effect, { action: "set_status", status: "joining" });
});

test("bot.in_call_recording maps to recording", () => {
  const payload = { event: "bot.in_call_recording", ...botLifecyclePayload("in_call_recording") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.in_call_recording");
  assert.deepEqual(effect, { action: "set_status", status: "recording" });
});

test("[regression] bot.call_ended maps to processing and is NOT an unhandled/ignored event", () => {
  const payload = { event: "bot.call_ended", ...botLifecyclePayload("call_ended") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.call_ended");
  assert.deepEqual(effect, { action: "set_status", status: "processing" });
  assert.notEqual(effect.action, "ignore");
});

test("bot.call_ended never itself imports a transcript -- it only advances lifecycle status", () => {
  const payload = { event: "bot.call_ended", ...botLifecyclePayload("call_ended") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.call_ended");
  assert.notEqual(effect.action, "import_transcript");
});

test("bot.done maps to processing (idempotent safety net alongside bot.call_ended)", () => {
  const payload = { event: "bot.done", ...botLifecyclePayload("done") };
  const { effect } = resolveRecallWebhookEffect(payload, "bot.done");
  assert.deepEqual(effect, { action: "set_status", status: "processing" });
});

test("bot.fatal is handled as a failure, preserving sub_code from data.data.sub_code", () => {
  const payload = { event: "bot.fatal", ...botLifecyclePayload("fatal", { sub_code: "meeting_not_started" }) };
  const { effect, diagnostics } = resolveRecallWebhookEffect(payload, "bot.fatal");
  assert.equal(effect.action, "mark_failed");
  assert.equal(diagnostics.subCode, "meeting_not_started");
});

test("permission-prompt and breakout-room bot.* events are recognized but cause no lifecycle regression", () => {
  for (const event of [
    "bot.recording_permission_allowed",
    "bot.recording_permission_denied",
    "bot.breakout_room_entered",
    "bot.breakout_room_left"
  ]) {
    const payload = { event, ...botLifecyclePayload(event.replace("bot.", "")) };
    const { effect } = resolveRecallWebhookEffect(payload, event);
    assert.equal(effect.action, "ignore", event);
  }
});

test("an unknown/future bot.* event is safely ignored and observable in diagnostics, never thrown", () => {
  const payload = {
    event: "bot.some_future_event",
    ...botLifecyclePayload("some_future_event")
  };
  assert.doesNotThrow(() => resolveRecallWebhookEffect(payload, "bot.some_future_event"));
  const { effect } = resolveRecallWebhookEffect(payload, "bot.some_future_event");
  assert.equal(effect.action, "ignore");
});

// ---------------------------------------------------------------------------
// Compatibility path: older consolidated bot.status_change / data.status.code shape.
// This is NOT the canonical Recall payload -- it's a fallback only, tested separately.
// ---------------------------------------------------------------------------

function legacyStatusChangePayload(code: string, extra: Record<string, unknown> = {}) {
  return { event: "bot.status_change", data: { bot_id: "bot-legacy-1", status: { code, ...extra } } };
}

test("[compat] legacy bot.status_change with data.status.code=call_ended still maps to processing", () => {
  const { effect } = resolveRecallWebhookEffect(legacyStatusChangePayload("call_ended"), "bot.status_change");
  assert.deepEqual(effect, { action: "set_status", status: "processing" });
});

test("[compat] legacy bot.status_change with data.status.code=fatal still marks the meeting failed", () => {
  const { effect } = resolveRecallWebhookEffect(
    legacyStatusChangePayload("fatal", { sub_code: "call_declined" }),
    "bot.status_change"
  );
  assert.equal(effect.action, "mark_failed");
});

test("[compat] a bot.status_change payload with no data.status.code is ignored, not thrown", () => {
  const { effect } = resolveRecallWebhookEffect(
    { event: "bot.status_change", data: { bot_id: "bot-1" } },
    "bot.status_change"
  );
  assert.equal(effect.action, "ignore");
});

// ---------------------------------------------------------------------------
// Artifact lifecycle (recording.*, transcript.*) -- unchanged by this correction.
// ---------------------------------------------------------------------------

test("transcript.processing sets status to processing", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "transcript.processing" }, "transcript.processing");
  assert.deepEqual(effect, { action: "set_status", status: "processing" });
});

test("transcript.done is the canonical transcript-import trigger", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "transcript.done" }, "transcript.done");
  assert.deepEqual(effect, { action: "import_transcript" });
});

test("transcript.failed is handled as a failure", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "transcript.failed" }, "transcript.failed");
  assert.equal(effect.action, "mark_failed");
});

test("recording.done is preserved as a safe, idempotent import fallback (matches transcript.done's action)", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "recording.done" }, "recording.done");
  assert.deepEqual(effect, { action: "import_transcript" });
});

test("recording.failed is handled as a failure", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "recording.failed" }, "recording.failed");
  assert.equal(effect.action, "mark_failed");
});

test("a completely unhandled event type is ignored, not thrown", () => {
  const { effect } = resolveRecallWebhookEffect({ event: "something.else" }, "something.else");
  assert.equal(effect.action, "ignore");
});

// ---------------------------------------------------------------------------
// mapBotLifecycleCodeToMeetingStatus (bare codes -- REST bot status + legacy compat path)
// ---------------------------------------------------------------------------

test("mapBotLifecycleCodeToMeetingStatus maps bare REST/legacy status codes", () => {
  assert.equal(mapBotLifecycleCodeToMeetingStatus("in_call_recording"), "recording");
  assert.equal(mapBotLifecycleCodeToMeetingStatus("call_ended"), "processing");
  assert.equal(mapBotLifecycleCodeToMeetingStatus("fatal"), "failed");
  assert.equal(mapBotLifecycleCodeToMeetingStatus("joining_call"), "joining");
  assert.equal(mapBotLifecycleCodeToMeetingStatus(null), null);
  assert.equal(mapBotLifecycleCodeToMeetingStatus("totally_unknown_code"), null);
});

// ---------------------------------------------------------------------------
// Forward-only status guard (idempotency + no regression)
// ---------------------------------------------------------------------------

test("allowedPriorStatuses only admits strictly-earlier statuses -- a late/duplicate event can't regress a meeting", () => {
  assert.deepEqual(allowedPriorStatuses("recording"), ["pending", "joining"]);
  assert.deepEqual(allowedPriorStatuses("processing"), ["pending", "joining", "recording"]);
  assert.equal(allowedPriorStatuses("recording").includes("recording"), false);
});

test("allowedPriorStatuses admits failure from any in-flight status but not from completed", () => {
  const priorForFailed = allowedPriorStatuses("failed");
  assert.equal(priorForFailed.includes("processing"), true);
  assert.equal(priorForFailed.includes("completed"), false);
});

test("shouldSkipDuplicateCompletion is true only once the transcript has already landed", () => {
  assert.equal(shouldSkipDuplicateCompletion("transcript_ready"), true);
  assert.equal(shouldSkipDuplicateCompletion("completed"), true);
  assert.equal(shouldSkipDuplicateCompletion("processing"), false);
  assert.equal(shouldSkipDuplicateCompletion("recording"), false);
});
