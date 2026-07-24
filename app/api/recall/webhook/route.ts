import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { processCompletedRecallMeeting } from "@/lib/recall/processing";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Imports transcript and enqueues background analysis. Model work runs elsewhere.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractRecallBotId(payload: JsonObject): string | null {
  const payloadBot = asObject(payload.bot);
  const data = asObject(payload.data);
  const dataBot = asObject(data?.bot);

  return (
    asId(payloadBot?.id) ??
    asId(dataBot?.id) ??
    asId(data?.id) ??
    asId(payload.bot_id)
  );
}

function isCompletionEvent(eventType: string) {
  return (
    eventType.includes("transcript.done") ||
    eventType.includes("transcript.ready") ||
    eventType.includes("recording.done") ||
    eventType.includes("call_ended") ||
    eventType === "bot.done" ||
    eventType.includes("completed") ||
    eventType.includes("finished")
  );
}

function isFailureEvent(eventType: string) {
  return (
    eventType.includes("failed") ||
    eventType.includes("error") ||
    eventType.includes("fatal")
  );
}

function isRecordingEvent(eventType: string) {
  return (
    eventType.includes("in_call") ||
    eventType.includes("recording") ||
    eventType.includes("joined")
  );
}

function isJoiningEvent(eventType: string) {
  return eventType.includes("joining") || eventType.includes("waiting_room");
}

async function verifyWebhook(request: Request, rawBody: string) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  const webhookSecret = process.env.RECALL_WEBHOOK_SECRET?.trim();
  const signature = request.headers.get("x-recall-signature");
  if (!webhookSecret || !signature || !rawBody) {
    console.error("Recall webhook signature verification failed: missing secret or signature.");
    return false;
  }

  const incoming = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  let incomingBuffer: Buffer;
  let expectedBuffer: Buffer;
  try {
    const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    incomingBuffer = Buffer.from(incoming, "hex");
    expectedBuffer = Buffer.from(expected, "hex");
  } catch (error) {
    console.error("Recall webhook signature verification failed: invalid signature encoding.", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return false;
  }

  return (
    incomingBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(incomingBuffer, expectedBuffer)
  );
}

async function processCompletionWithRetry({
  meetingId,
  recallBotId,
  requestOrigin,
  eventType
}: {
  meetingId: string;
  recallBotId: string;
  requestOrigin: string;
  eventType: string;
}) {
  const attempts = eventType.includes("transcript.done") ? 1 : 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await processCompletedRecallMeeting({
      meetingId,
      recallBotId,
      requestOrigin
    });

    console.info("Recall webhook processing result", {
      event_type: eventType,
      bot_id: recallBotId,
      meeting_id: meetingId,
      attempt,
      status: result.status,
      inserted_segments: result.insertedCount,
      analysis_status: result.analysisStatus
    });

    if (result.status === "transcript_ready" || attempt === attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }

  throw new Error("Recall webhook processing ended without a result.");
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!(await verifyWebhook(request, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    payload = asObject(JSON.parse(rawBody) as unknown) ?? {};
  } catch {
    console.warn("Recall webhook: invalid JSON payload");
    return NextResponse.json({ ok: true });
  }

  const fullEventType = String(payload.event ?? payload.event_type ?? "unknown");
  const eventType = fullEventType.toLowerCase();
  const recallBotId = extractRecallBotId(payload);

  console.info("Recall webhook received", {
    event_type: fullEventType,
    bot_id: recallBotId
  });

  if (!recallBotId) {
    console.info("Recall webhook: payload did not contain a bot id", {
      event_type: fullEventType
    });
    return NextResponse.json({ ok: true });
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("recall_bot_id", recallBotId)
    .is("deleted_at", null)
    .maybeSingle();
  const meetingId = meeting?.id ?? null;

  console.info("Recall webhook meeting match", {
    event_type: fullEventType,
    bot_id: recallBotId,
    meeting_id: meetingId
  });

  if (meetingError || !meetingId) {
    console.info("Recall webhook: no matching meeting", {
      event_type: fullEventType,
      bot_id: recallBotId,
      error: meetingError?.message ?? null
    });
    return NextResponse.json({ ok: true });
  }

  if (isFailureEvent(eventType)) {
    await supabaseAdmin.from("meetings").update({ status: "failed" }).eq("id", meetingId);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  if (isCompletionEvent(eventType)) {
    try {
      const result = await processCompletionWithRetry({
        meetingId,
        recallBotId,
        requestOrigin: new URL(request.url).origin,
        eventType
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      console.error("Recall webhook processing failed", {
        event_type: fullEventType,
        bot_id: recallBotId,
        meeting_id: meetingId,
        error: error instanceof Error ? error.message : "Unknown error"
      });
      // Keep the meeting recoverable. Only explicit Recall failure events set
      // the terminal failed status.
      await supabaseAdmin.from("meetings").update({ status: "processing" }).eq("id", meetingId);
      return NextResponse.json({ ok: true, status: "processing" });
    }
  }

  if (isRecordingEvent(eventType)) {
    await supabaseAdmin.from("meetings").update({ status: "recording" }).eq("id", meetingId);
  } else if (isJoiningEvent(eventType)) {
    await supabaseAdmin.from("meetings").update({ status: "joining" }).eq("id", meetingId);
  }

  return NextResponse.json({ ok: true });
}
