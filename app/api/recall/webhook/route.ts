import { NextResponse } from "next/server";
import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase/admin";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function POST(request: Request) {
  const webhookSecret = process.env.RECALL_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Server missing RECALL_WEBHOOK_SECRET" },
      { status: 500 }
    );
  }

  const signature = request.headers.get("x-recall-signature");
  const rawBody = await request.text();
  if (!signature || !rawBody) {
    return NextResponse.json({ error: "Missing signature or body" }, { status: 401 });
  }

  const incoming = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const incomingBuffer = Buffer.from(incoming, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const validSignature =
    incomingBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(incomingBuffer, expectedBuffer);

  if (!validSignature) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    payload = asObject(parsed) ?? {};
  } catch {
    // Tolerant webhook handling: acknowledge malformed payloads without crashing.
    console.warn("Recall webhook: invalid JSON payload");
    return NextResponse.json({ ok: true });
  }

  const eventType = String(payload.event ?? payload.event_type ?? "unknown").toLowerCase();
  const data = asObject(payload.data) ?? {};
  const bot = asObject(data.bot) ?? {};
  const transcript = asObject(data.transcript) ?? {};
  const metadata = asObject(bot.metadata) ?? asObject(data.metadata) ?? {};

  const recallBotId = asString(bot.id) ?? asString(data.bot_id) ?? asString(payload.bot_id);
  const meetingIdFromMetadata = asString(metadata.meeting_id) ?? asString(metadata.meetingId);

  const resolveMeetingId = async (): Promise<string | null> => {
    if (meetingIdFromMetadata) return meetingIdFromMetadata;
    if (!recallBotId) return null;

    const { data: meeting } = await supabaseAdmin
      .from("meetings")
      .select("id")
      .eq("recall_bot_id", recallBotId)
      .single();
    return meeting?.id ?? null;
  };

  const meetingId = await resolveMeetingId();

  if (!meetingId) {
    console.info("Recall webhook: no matching meeting", {
      eventType,
      recallBotId,
      meetingIdFromMetadata
    });
    return NextResponse.json({ ok: true });
  }

  const normalizedBotStatus = String(bot.status ?? data.status ?? "").toLowerCase();

  let mappedStatus: "joining" | "recording" | "completed" | "failed" | null = null;
  if (
    eventType.includes("error") ||
    eventType.includes("fail") ||
    normalizedBotStatus.includes("error") ||
    normalizedBotStatus.includes("fail")
  ) {
    mappedStatus = "failed";
  } else if (
    eventType.includes("end") ||
    eventType.includes("complete") ||
    eventType.includes("done") ||
    normalizedBotStatus.includes("done") ||
    normalizedBotStatus.includes("complete")
  ) {
    mappedStatus = "completed";
  } else if (
    eventType.includes("transcript") ||
    eventType.includes("record") ||
    normalizedBotStatus.includes("in_call") ||
    normalizedBotStatus.includes("record")
  ) {
    mappedStatus = "recording";
  } else if (
    eventType.includes("join") ||
    normalizedBotStatus.includes("join")
  ) {
    mappedStatus = "joining";
  } else if (eventType !== "unknown") {
    console.info("Recall webhook: unknown event type", { eventType, normalizedBotStatus });
  }

  if (mappedStatus) {
    const { error: statusError } = await supabaseAdmin
      .from("meetings")
      .update({ status: mappedStatus })
      .eq("id", meetingId);

    if (statusError) {
      console.error("Recall webhook: failed updating meeting status", {
        meetingId,
        mappedStatus,
        error: statusError.message
      });
    }
  }

  const transcriptText =
    asString(transcript.text) ?? asString(transcript.words) ?? asString(data.text);

  if (transcriptText && transcriptText.trim()) {
    const speaker =
      asString(asObject(transcript.speaker)?.name) ??
      asString(transcript.speaker) ??
      asString(data.speaker);

    const timestamp =
      asString(transcript.timestamp) ??
      asString(transcript.start_timestamp) ??
      asString(data.timestamp) ??
      new Date().toISOString();

    const { error: insertError } = await supabaseAdmin.from("transcript_segments").insert({
      meeting_id: meetingId,
      speaker,
      text: transcriptText.trim(),
      timestamp,
      raw_payload: payload
    });

    if (insertError) {
      console.error("Recall webhook: failed inserting transcript segment", {
        meetingId,
        error: insertError.message
      });
    }
  }

  return NextResponse.json({ ok: true });
}
