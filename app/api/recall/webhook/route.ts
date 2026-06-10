import { NextResponse } from "next/server";

import { isValidRecallWebhookSignature } from "@/lib/recall";
import { supabaseAdmin } from "@/lib/supabase/admin";

type RecallWebhookPayload = {
  event?: string;
  data?: {
    bot?: {
      id?: string;
      status?: string;
      metadata?: { meeting_id?: string };
    };
    transcript?: {
      speaker?: { name?: string };
      words?: string;
      text?: string;
      start_timestamp?: string;
      end_timestamp?: string;
    };
  };
};

export async function POST(request: Request) {
  const signature = request.headers.get("x-recall-signature");
  const rawBody = await request.text();

  if (!isValidRecallWebhookSignature(signature, rawBody)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: RecallWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RecallWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = payload.event ?? "";
  const meetingId = payload.data?.bot?.metadata?.meeting_id;
  const recallBotId = payload.data?.bot?.id;

  if (!meetingId && !recallBotId) {
    return NextResponse.json(
      { error: "Missing meeting identity in payload" },
      { status: 400 }
    );
  }

  const resolveMeetingId = async () => {
    if (meetingId) return meetingId;
    const { data } = await supabaseAdmin
      .from("meetings")
      .select("id")
      .eq("recall_bot_id", recallBotId ?? "")
      .single();
    return data?.id ?? null;
  };

  const resolvedMeetingId = await resolveMeetingId();
  if (!resolvedMeetingId) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  if (event.includes("transcript")) {
    const transcript = payload.data?.transcript;
    const content = transcript?.text ?? transcript?.words ?? "";

    if (content.trim()) {
      await supabaseAdmin.from("transcript_segments").insert({
        meeting_id: resolvedMeetingId,
        speaker_name: transcript?.speaker?.name ?? null,
        content,
        started_at: transcript?.start_timestamp ?? new Date().toISOString(),
        ended_at: transcript?.end_timestamp ?? null,
        raw_payload: payload
      });
    }
  }

  const botStatus = payload.data?.bot?.status;
  if (botStatus) {
    const statusMap: Record<string, string> = {
      joining: "joining",
      in_call: "in_progress",
      done: "completed",
      error: "failed"
    };
    await supabaseAdmin
      .from("meetings")
      .update({ status: statusMap[botStatus] ?? "in_progress" })
      .eq("id", resolvedMeetingId);
  }

  return NextResponse.json({ ok: true });
}
