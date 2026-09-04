import { NextResponse } from "next/server";

import { enqueueRecallTranscriptImport } from "@/lib/recall/enqueue-transcript-import";
import { applyGuardedMeetingStatus } from "@/lib/recall/processing";
import {
  shouldRequireRecallWebhookVerification,
  verifyRecallWebhookPayload
} from "@/lib/recall/webhook-auth";
import { extractRecallBotId, resolveRecallWebhookEffect } from "@/lib/recall/webhook-events";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Verifies the request, classifies the event, and persists minimal lifecycle state. Recall
 * documents a 15-second response timeout, so the actual transcript fetch/download/import never
 * runs inline here -- it's dispatched to a durable Workflow SDK job (see
 * lib/recall/enqueue-transcript-import.ts) and this handler returns as soon as that's queued.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  const verification = verifyRecallWebhookPayload({
    rawBody,
    headers: {
      webhookId: request.headers.get("webhook-id") ?? request.headers.get("svix-id"),
      webhookTimestamp:
        request.headers.get("webhook-timestamp") ?? request.headers.get("svix-timestamp"),
      webhookSignature:
        request.headers.get("webhook-signature") ?? request.headers.get("svix-signature")
    },
    secret: process.env.RECALL_WEBHOOK_SECRET,
    requireVerification: shouldRequireRecallWebhookVerification({
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV
    })
  });

  if (!verification.ok) {
    console.error("[recall-webhook] Rejected: signature verification failed.", {
      reason: verification.reason
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    payload = asObject(JSON.parse(rawBody) as unknown) ?? {};
  } catch {
    // Malformed bytes will still be malformed on retry -- acknowledge so Recall stops resending.
    console.warn("[recall-webhook] Invalid JSON payload; acknowledging to stop retries.");
    return NextResponse.json({ ok: true });
  }

  const eventType = String(payload.event ?? payload.event_type ?? "unknown").toLowerCase();
  const recallBotId = extractRecallBotId(payload);

  console.info("[recall-webhook] Received", { event_type: eventType, bot_id: recallBotId });

  if (!recallBotId) {
    // No bot id to act on, and retrying the identical payload won't produce one -- acknowledge.
    console.info("[recall-webhook] Payload did not contain a bot id", { event_type: eventType });
    return NextResponse.json({ ok: true });
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("recall_bot_id", recallBotId)
    .is("deleted_at", null)
    .maybeSingle();

  if (meetingError || !meeting) {
    // No meeting to update (deleted, or a bot id we've never seen) -- nothing to retry into.
    console.info("[recall-webhook] No matching meeting", {
      event_type: eventType,
      bot_id: recallBotId,
      error: meetingError?.message ?? null
    });
    return NextResponse.json({ ok: true });
  }

  const { effect, diagnostics } = resolveRecallWebhookEffect(payload, eventType);

  console.info("[recall-webhook] Resolved effect", {
    event_type: eventType,
    bot_id: recallBotId,
    meeting_id: meeting.id,
    action: effect.action,
    status_code: diagnostics.statusCode,
    sub_code: diagnostics.subCode
  });

  try {
    if (effect.action === "ignore") {
      return NextResponse.json({ ok: true, action: "ignored", reason: effect.reason });
    }

    if (effect.action === "mark_failed") {
      await supabaseAdmin.from("meetings").update({ status: "failed" }).eq("id", meeting.id);
      console.error("[recall-webhook] Meeting marked failed", {
        meeting_id: meeting.id,
        bot_id: recallBotId,
        event_type: eventType,
        detail: effect.detail,
        message: diagnostics.message
      });
      return NextResponse.json({ ok: true, status: "failed" });
    }

    if (effect.action === "set_status") {
      const applied = await applyGuardedMeetingStatus(meeting.id, effect.status);
      return NextResponse.json({ ok: true, status: effect.status, applied });
    }

    // effect.action === "import_transcript" -- persist minimal lifecycle state inline (fast, a
    // single guarded Supabase update), then dispatch the durable workflow that will actually do
    // the slow Recall fetch/download/import. enqueueRecallTranscriptImport only awaits the
    // Workflow SDK's start() -- i.e. confirmation the run was *enqueued* -- not the workflow
    // itself completing, so this stays fast. It's awaited directly (not deferred via after()) so
    // a dispatch failure throws here and falls into the catch below as a 502, letting Recall
    // retry, instead of being silently lost after we've already returned 200.
    // processCompletedRecallMeeting (run inside that workflow) already short-circuits a meeting
    // that's already transcript_ready/completed, so a duplicate transcript.done/recording.done
    // delivery dispatching a second run is safe.
    const applied = await applyGuardedMeetingStatus(meeting.id, "processing");
    await enqueueRecallTranscriptImport({
      meetingId: meeting.id,
      recallBotId,
      requestOrigin: new URL(request.url).origin
    });

    console.info("[recall-webhook] Transcript import queued", {
      event_type: eventType,
      bot_id: recallBotId,
      meeting_id: meeting.id,
      applied
    });

    return NextResponse.json({ ok: true, status: "processing", queued: true });
  } catch (error) {
    // A transient failure here (e.g. a Supabase error on the status write) must not be swallowed
    // behind a 200 -- that would tell Recall the delivery succeeded and permanently forfeit its
    // own built-in retry-on-non-2xx window (up to 24h). Returning 5xx lets Recall redeliver this
    // same event later; every write above is idempotent, so a retried delivery is safe.
    console.error("[recall-webhook] Processing failed; returning 5xx so Recall retries.", {
      event_type: eventType,
      bot_id: recallBotId,
      meeting_id: meeting.id,
      action: effect.action,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 502 });
  }
}
