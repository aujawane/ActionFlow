import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchRecallTranscript,
  parseRecallTranscriptToSegments
} from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : null;
}

export async function POST(request: Request) {
  const isDev = process.env.NODE_ENV !== "production";
  const rawBody = await request.text();

  // TEMPORARY: Skip strict webhook signature verification in local MVP development.
  // TODO: Enforce strict signature verification for production hardening.
  if (!isDev) {
    const webhookSecret = process.env.RECALL_WEBHOOK_SECRET;
    const signature = request.headers.get("x-recall-signature");

    if (webhookSecret && signature && rawBody) {
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
    } else {
      console.warn("Recall webhook: signature verification skipped in production (missing secret/signature).");
    }
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

  console.info("RECALL WEBHOOK HIT");
  console.info("Recall webhook event", {
    event_type: eventType,
    bot_id: recallBotId,
    meeting_id: meetingIdFromMetadata
  });

  if (isDev) {
    console.info("Recall webhook complete payload", payload);
    console.info("Recall webhook payload probes", {
      keys: Object.keys(payload),
      data: payload.data ?? null,
      transcript: payload.transcript ?? null,
      words: payload.words ?? null,
      participant: payload.participant ?? null,
      speaker: payload.speaker ?? null
    });

    // Temporary local debug capture to inspect raw Recall event shape over time.
    try {
      const debugDir = path.join(process.cwd(), ".tmp");
      const debugFile = path.join(debugDir, "recall-webhook-events.log");
      await mkdir(debugDir, { recursive: true });
      await appendFile(
        debugFile,
        [
          `\n=== ${new Date().toISOString()} ===`,
          `event_type=${eventType}`,
          `bot_id=${recallBotId ?? "null"}`,
          `meeting_id=${meetingIdFromMetadata ?? "null"}`,
          `raw_body=${rawBody}`
        ].join("\n") + "\n"
      );
    } catch (fileLogError) {
      console.warn("Recall webhook debug file write failed", {
        error: fileLogError instanceof Error ? fileLogError.message : "Unknown file write error"
      });
    }
  }

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

  if (isDev) {
    console.info("Recall webhook event received", {
      event_type: eventType,
      bot_id: recallBotId,
      meeting_id: meetingId ?? meetingIdFromMetadata
    });
  }

  if (!meetingId) {
    console.info("Recall webhook: no matching meeting", {
      eventType,
      recallBotId,
      meetingIdFromMetadata
    });
    return NextResponse.json({ ok: true });
  }

  const transcriptId =
    asString(transcript.id) ??
    (typeof transcript.id === "number" ? String(transcript.id) : null);
  if (eventType === "transcript.done" && transcriptId) {
    try {
      console.info("Recall transcript.done received", {
        transcript_id: transcriptId,
        meeting_id: meetingId
      });

      const transcriptContent = await fetchRecallTranscript(transcriptId);
      const parsedRows = parseRecallTranscriptToSegments(transcriptContent);
      console.info("Recall transcript content rows found", {
        transcript_id: transcriptId,
        row_count: parsedRows.length
      });

      let insertedCount = 0;
      if (parsedRows.length > 0) {
        const { data: insertedRows, error: insertError } = await supabaseAdmin
          .from("transcript_segments")
          .insert(
            parsedRows.map((row) => ({
              meeting_id: meetingId,
              speaker: row.speaker,
              participant_name: row.participant_name,
              diarized_speaker: row.diarized_speaker,
              speaker_confidence: row.speaker_confidence,
              text: row.text,
              timestamp: row.timestamp,
              raw_payload: row.raw_payload
            }))
          )
          .select("id");

        if (insertError) {
          console.error("Recall transcript.done insert failed", {
            transcript_id: transcriptId,
            meeting_id: meetingId,
            error: insertError.message
          });
        } else {
          insertedCount = insertedRows?.length ?? 0;
        }
      }

      console.info("Recall transcript segments inserted", {
        transcript_id: transcriptId,
        meeting_id: meetingId,
        inserted_count: insertedCount
      });

      await supabaseAdmin
        .from("meetings")
        .update({ status: "completed" })
        .eq("id", meetingId);
    } catch (error) {
      console.error("Recall transcript.done processing failed", {
        transcript_id: transcriptId,
        meeting_id: meetingId,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }

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

  if (isDev) {
    console.info("Recall webhook transcript diagnostics", {
      event_type: eventType,
      bot_id: recallBotId,
      meeting_id: meetingId,
      transcript_text_length: transcriptText?.length ?? 0
    });
  }

  if (transcriptText && transcriptText.trim()) {
    const transcriptParticipant = asObject(transcript.participant);
    const dataParticipant = asObject(data.participant);
    const payloadParticipant = asObject(payload.participant);
    const participantName =
      asNonEmptyString(transcriptParticipant?.name) ??
      asNonEmptyString(dataParticipant?.name) ??
      asNonEmptyString(payloadParticipant?.name) ??
      asNonEmptyString(transcript.participant_name) ??
      asNonEmptyString(data.participant_name) ??
      asNonEmptyString(payload.participant_name);
    const rawDiarizedSpeaker =
      asNonEmptyString(transcript.diarized_speaker) ??
      asNonEmptyString(transcript.diarized_speaker_label) ??
      asNonEmptyString(transcript.speaker_label) ??
      asNonEmptyString(data.diarized_speaker) ??
      asNonEmptyString(data.speaker_label) ??
      asNonEmptyString(payload.diarized_speaker) ??
      asNonEmptyString(payload.speaker_label);
    const diarizedSpeaker =
      rawDiarizedSpeaker && /^speaker\s+/i.test(rawDiarizedSpeaker)
        ? rawDiarizedSpeaker
        : rawDiarizedSpeaker
          ? `Speaker ${rawDiarizedSpeaker}`
          : null;
    const speaker =
      participantName ??
      diarizedSpeaker ??
      asNonEmptyString(asObject(transcript.speaker)?.name) ??
      asNonEmptyString(transcript.speaker) ??
      asNonEmptyString(data.speaker) ??
      asNonEmptyString(payload.speaker);
    const speakerConfidence =
      typeof transcript.speaker_confidence === "number"
        ? transcript.speaker_confidence
        : typeof transcript.confidence === "number"
          ? transcript.confidence
          : typeof data.speaker_confidence === "number"
            ? data.speaker_confidence
            : typeof data.confidence === "number"
              ? data.confidence
              : null;

    const timestamp =
      asString(transcript.timestamp) ??
      asString(transcript.start_timestamp) ??
      asString(data.timestamp) ??
      new Date().toISOString();

    const { error: insertError } = await supabaseAdmin.from("transcript_segments").insert({
      meeting_id: meetingId,
      speaker,
      participant_name: participantName,
      diarized_speaker: diarizedSpeaker,
      speaker_confidence: speakerConfidence,
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
