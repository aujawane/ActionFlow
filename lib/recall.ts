import crypto from "node:crypto";

import { env } from "@/lib/env";

interface CreateRecallBotInput {
  meetingUrl: string;
  webhookUrl: string;
  meetingId: string;
}

interface RecallBotResponse {
  id: string;
  status: string;
}

export type RecallMeetingStatus = "joining" | "in_progress" | "completed" | "failed";

export interface RecallWebhookPayload {
  event?: string;
  data?: {
    bot?: {
      id?: string;
      status?: string;
      metadata?: { meeting_id?: string };
    };
    transcript?: {
      speaker?: { name?: string };
      text?: string;
      words?: string;
      timestamp?: string;
      start_timestamp?: string;
      end_timestamp?: string;
    };
  };
}

export async function createRecallBot(
  input: CreateRecallBotInput
): Promise<RecallBotResponse> {
  const response = await fetch("https://api.recall.ai/api/v1/bot/", {
    method: "POST",
    headers: {
      Authorization: `Token ${env.RECALL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      meeting_url: input.meetingUrl,
      recording_config: {
        transcript: {
          provider: {
            deepgram_streaming: {}
          }
        }
      },
      metadata: {
        meeting_id: input.meetingId
      },
      webhook_url: input.webhookUrl
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create Recall bot: ${response.status} ${body}`);
  }

  return (await response.json()) as RecallBotResponse;
}

export function isValidRecallWebhookSignature(
  signatureHeader: string | null,
  rawBody: string
) {
  if (!signatureHeader || !rawBody) return false;

  const incoming = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expected = crypto
    .createHmac("sha256", env.RECALL_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const incomingBuffer = Buffer.from(incoming, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (incomingBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(incomingBuffer, expectedBuffer);
}

export function parseRecallWebhookPayload(rawBody: string): {
  ok: true;
  payload: RecallWebhookPayload;
} | {
  ok: false;
  error: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "Invalid JSON payload" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = parsed as RecallWebhookPayload;
  if (payload.event !== undefined && typeof payload.event !== "string") {
    return { ok: false, error: "Invalid event type" };
  }

  if (payload.data !== undefined && typeof payload.data !== "object") {
    return { ok: false, error: "Invalid data object" };
  }

  return { ok: true, payload };
}

export function mapRecallStatus(payload: RecallWebhookPayload): RecallMeetingStatus | null {
  const event = payload.event?.toLowerCase() ?? "";
  const botStatus = payload.data?.bot?.status?.toLowerCase() ?? "";

  if (
    event.includes("error") ||
    event.includes("fail") ||
    botStatus.includes("error") ||
    botStatus.includes("fail")
  ) {
    return "failed";
  }

  if (
    event.includes("done") ||
    event.includes("complete") ||
    event.includes("ended") ||
    botStatus.includes("done") ||
    botStatus.includes("complete")
  ) {
    return "completed";
  }

  if (
    event.includes("record") ||
    event.includes("transcript") ||
    botStatus.includes("in_call") ||
    botStatus.includes("record")
  ) {
    return "in_progress";
  }

  if (
    event.includes("join") ||
    botStatus.includes("join")
  ) {
    return "joining";
  }

  return null;
}
