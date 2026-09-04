import type { Meeting } from "@/lib/types";

export type MeetingStatus = Meeting["status"];

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value);
}

/**
 * Recall's current dashboard webhook schema (both bot lifecycle events and artifact events)
 * carries the bot id at `data.bot.id`. Older/legacy shapes are kept as fallbacks purely for
 * robustness -- `data.bot_id` and top-level `bot`/`bot_id` were never confirmed as real Recall
 * payload shapes, but checking them costs nothing and protects against a misconfigured or
 * older-generation sender.
 */
export function extractRecallBotId(payload: JsonObject): string | null {
  const data = asObject(payload.data);
  return (
    asId(asObject(data?.bot)?.id) ??
    asId(data?.bot_id) ??
    asId(asObject(payload.bot)?.id) ??
    asId(payload.bot_id) ??
    null
  );
}

/** The meeting lifecycle Parfait's webhook/reconciliation logic can move forward through
 * automatically. `failed` is intentionally not part of this ladder -- it's reachable from any
 * non-`completed` status (see allowedPriorStatuses) rather than occupying a fixed rank. */
const MEETING_STATUS_ORDER: readonly MeetingStatus[] = [
  "pending",
  "joining",
  "recording",
  "processing",
  "transcript_ready",
  "completed"
];

/**
 * Statuses a meeting may move to `target` FROM, for use as a Supabase `.in("status", ...)` guard
 * on the update. This makes every automatic status write forward-only and idempotent in a single
 * atomic query -- no read-then-write race, and a duplicate/out-of-order/late webhook event can
 * never regress an already-advanced meeting (e.g. a delayed `bot.in_call_recording` arriving after
 * `bot.call_ended` already moved the meeting to `processing`).
 */
export function allowedPriorStatuses(target: MeetingStatus): MeetingStatus[] {
  if (target === "failed") {
    // A fatal/failure event is meaningful from any in-flight status, but a meeting whose analysis
    // already completed successfully should not be retroactively hidden by a late failure event.
    return MEETING_STATUS_ORDER.filter((status) => status !== "completed");
  }
  const index = MEETING_STATUS_ORDER.indexOf(target);
  return index <= 0 ? [] : [...MEETING_STATUS_ORDER.slice(0, index)];
}

/** A meeting that already reached transcript_ready/completed has already been imported (and
 * analysis already enqueued or finished) by an earlier delivery of the same completion event --
 * a duplicate/retried transcript.done must not re-import or re-enqueue analysis. */
export function shouldSkipDuplicateCompletion(status: MeetingStatus): boolean {
  return status === "transcript_ready" || status === "completed";
}

/** Statuses where the manual "Sync Status" recovery action (POST /api/meetings/[id]/sync-status)
 * is meaningful: the meeting is still in-flight on Recall's side and could be stuck because a
 * webhook was missed. A meeting that already has its transcript (transcript_ready/completed) has
 * nothing left to reconcile, and "pending"/"failed" aren't in-flight states a bot-status check can
 * move forward, so the action is hidden for those to avoid suggesting it does something useful
 * there. Shared by the meeting detail page so this list has one definition. */
export function isSyncStatusRecoverable(status: MeetingStatus): boolean {
  return status === "joining" || status === "recording" || status === "processing";
}

/**
 * CANONICAL bot lifecycle mapping, keyed by Recall's current documented top-level `event` names
 * (docs.recall.ai "Bot Webhooks"). A `null` value means "recognized, but intentionally no
 * automatic status effect" (permission prompts, breakout rooms); `bot.fatal` is handled
 * separately below since it needs the `mark_failed` action, not `set_status`. This table is the
 * only source of truth for bot.* -> meeting-status decisions.
 */
const BOT_LIFECYCLE_EVENT_TO_STATUS: Record<string, MeetingStatus | null> = {
  "bot.joining_call": "joining",
  "bot.in_waiting_room": "joining",
  "bot.in_call_not_recording": "joining",
  "bot.recording_permission_allowed": null,
  "bot.recording_permission_denied": null,
  "bot.in_call_recording": "recording",
  "bot.breakout_room_entered": null,
  "bot.breakout_room_left": null,
  // The call has ended; Recall still needs to finish producing recording/transcript artifacts.
  // Transcript readiness is signalled separately by transcript.done, never assumed here.
  "bot.call_ended": "processing",
  // The bot has fully shut down. Treated the same as bot.call_ended (idempotent -- both just
  // ensure the meeting is at least "processing") as a safety net in case a call_ended delivery
  // is lost.
  "bot.done": "processing"
};

/**
 * COMPATIBILITY-ONLY: some Recall configurations may still deliver a consolidated
 * `bot.status_change` event with the real code nested at `data.status.code` (an older shape this
 * app originally assumed was canonical). Kept only as a secondary fallback path -- real,
 * documented bot.* event names above are what Recall's current dashboard sends and take priority.
 * Bare codes here (no "bot." prefix) also double as the vocabulary Recall's REST
 * `GET /bot/{id}/` status field uses -- see mapBotLifecycleCodeToMeetingStatus, reused by
 * sync-status's manual reconciliation.
 */
const LEGACY_BARE_STATUS_CODE_TO_STATUS: Record<string, MeetingStatus | null> = {
  joining_call: "joining",
  in_waiting_room: "joining",
  in_call_not_recording: "joining",
  recording_permission_allowed: null,
  recording_permission_denied: null,
  in_call_recording: "recording",
  breakout_room_entered: null,
  breakout_room_left: null,
  call_ended: "processing",
  done: "processing"
};

/** Shared by the sync-status reconciliation route (Recall's REST bot status, which reports bare
 * codes like "in_call_recording" rather than "bot.in_call_recording") and the legacy
 * bot.status_change compatibility path below. */
export function mapBotLifecycleCodeToMeetingStatus(
  code: string | null | undefined
): MeetingStatus | null {
  if (!code) return null;
  const normalized = code.trim().toLowerCase();
  if (normalized === "fatal") return "failed";
  return LEGACY_BARE_STATUS_CODE_TO_STATUS[normalized] ?? null;
}

export type RecallWebhookEffect =
  | { action: "set_status"; status: MeetingStatus }
  | { action: "import_transcript" }
  | { action: "mark_failed"; detail: string }
  | { action: "ignore"; reason: string };

export type RecallWebhookDiagnostics = {
  statusCode: string | null;
  subCode: string | null;
  message: string | null;
  updatedAt: string | null;
};

const EMPTY_DIAGNOSTICS: RecallWebhookDiagnostics = {
  statusCode: null,
  subCode: null,
  message: null,
  updatedAt: null
};

/** Bot lifecycle event diagnostic detail lives at `data.data.*` (yes, doubly-nested "data" --
 * that's Recall's documented shape: the outer `data` wraps the webhook envelope, the inner
 * `data` is the status-change record itself), not `data.status.*`. */
function readBotLifecycleDiagnostics(payload: JsonObject): RecallWebhookDiagnostics {
  const outerData = asObject(payload.data);
  const innerData = asObject(outerData?.data);
  return {
    statusCode: asString(innerData?.code)?.toLowerCase() ?? null,
    subCode: asString(innerData?.sub_code),
    message: asString(innerData?.message),
    updatedAt: asString(innerData?.updated_at)
  };
}

const ARTIFACT_STATUS_EVENTS = new Set(["recording.processing", "transcript.processing"]);
const ARTIFACT_IMPORT_EVENTS = new Set(["transcript.done", "recording.done"]);
const ARTIFACT_FAILURE_EVENTS = new Set(["recording.failed", "transcript.failed"]);

/**
 * Classifies a single Recall webhook delivery into exactly one effect.
 *
 * Canonical path: Recall's current dashboard sends distinct top-level `event` names for every
 * bot lifecycle transition (`bot.joining_call`, `bot.call_ended`, `bot.fatal`, ...) -- these are
 * matched directly by name via BOT_LIFECYCLE_EVENT_TO_STATUS, never by substring. Artifact events
 * (`recording.*`, `transcript.*`) keep their own distinct top-level names.
 *
 * Compatibility path: `bot.status_change` (an older consolidated event this app originally
 * assumed was canonical) is still accepted, interpreted via `data.status.code`, but only as a
 * fallback -- see resolveLegacyStatusChangeEffect.
 *
 * Anything else, including a future bot.* event Recall might add, is safely ignored and logged,
 * never thrown.
 */
export function resolveRecallWebhookEffect(
  payload: JsonObject,
  eventType: string
): { effect: RecallWebhookEffect; diagnostics: RecallWebhookDiagnostics } {
  if (eventType === "bot.fatal") {
    const diagnostics = readBotLifecycleDiagnostics(payload);
    return {
      effect: {
        action: "mark_failed",
        detail: diagnostics.subCode ? `fatal:${diagnostics.subCode}` : "fatal"
      },
      diagnostics
    };
  }

  if (eventType in BOT_LIFECYCLE_EVENT_TO_STATUS) {
    const diagnostics = readBotLifecycleDiagnostics(payload);
    const target = BOT_LIFECYCLE_EVENT_TO_STATUS[eventType];
    if (!target) {
      return {
        effect: { action: "ignore", reason: `no lifecycle effect for event: ${eventType}` },
        diagnostics
      };
    }
    return { effect: { action: "set_status", status: target }, diagnostics };
  }

  if (ARTIFACT_STATUS_EVENTS.has(eventType)) {
    return { effect: { action: "set_status", status: "processing" }, diagnostics: EMPTY_DIAGNOSTICS };
  }
  if (ARTIFACT_IMPORT_EVENTS.has(eventType)) {
    return { effect: { action: "import_transcript" }, diagnostics: EMPTY_DIAGNOSTICS };
  }
  if (ARTIFACT_FAILURE_EVENTS.has(eventType)) {
    return { effect: { action: "mark_failed", detail: eventType }, diagnostics: EMPTY_DIAGNOSTICS };
  }

  if (eventType === "bot.status_change") {
    return resolveLegacyStatusChangeEffect(payload);
  }

  return {
    effect: { action: "ignore", reason: `unhandled event type: ${eventType}` },
    diagnostics: EMPTY_DIAGNOSTICS
  };
}

/** COMPATIBILITY-ONLY. See the module-level comment on LEGACY_BARE_STATUS_CODE_TO_STATUS -- this
 * is not the shape Recall's current dashboard sends, but is kept as a fallback in case some
 * account/integration still delivers it. */
function resolveLegacyStatusChangeEffect(
  payload: JsonObject
): { effect: RecallWebhookEffect; diagnostics: RecallWebhookDiagnostics } {
  const data = asObject(payload.data);
  const status = asObject(data?.status);
  const code = asString(status?.code)?.toLowerCase() ?? null;
  const diagnostics: RecallWebhookDiagnostics = {
    statusCode: code,
    subCode: asString(status?.sub_code),
    message: asString(status?.message),
    updatedAt: asString(status?.updated_at)
  };

  if (!code) {
    return {
      effect: { action: "ignore", reason: "bot.status_change payload had no data.status.code" },
      diagnostics
    };
  }
  if (code === "fatal") {
    return {
      effect: {
        action: "mark_failed",
        detail: diagnostics.subCode ? `fatal:${diagnostics.subCode}` : "fatal"
      },
      diagnostics
    };
  }
  if (!(code in LEGACY_BARE_STATUS_CODE_TO_STATUS)) {
    return {
      effect: { action: "ignore", reason: `unrecognized bot status code: ${code}` },
      diagnostics
    };
  }
  const target = LEGACY_BARE_STATUS_CODE_TO_STATUS[code];
  if (!target) {
    return {
      effect: { action: "ignore", reason: `no lifecycle effect for status code: ${code}` },
      diagnostics
    };
  }
  return { effect: { action: "set_status", status: target }, diagnostics };
}
