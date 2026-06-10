import { NextResponse } from "next/server";

import {
  isValidRecallWebhookSignature,
  mapRecallStatus,
  parseRecallWebhookPayload
} from "@/lib/recall";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const signature = request.headers.get("x-recall-signature");
  const rawBody = await request.text();

  if (!isValidRecallWebhookSignature(signature, rawBody)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = parseRecallWebhookPayload(rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const payload = parsed.payload;

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
    const { data, error } = await supabaseAdmin
      .from("meetings")
      .select("id")
      .eq("recall_bot_id", recallBotId ?? "")
      .single();
    if (error) return null;
    return data?.id ?? null;
  };

  const resolvedMeetingId = await resolveMeetingId();
  if (!resolvedMeetingId) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const transcript = payload.data?.transcript;
  if (transcript) {
    const content = transcript?.text ?? transcript?.words ?? "";
    const startedAt =
      transcript?.timestamp ??
      transcript?.start_timestamp ??
      new Date().toISOString();

    if (content.trim()) {
      const { error: transcriptInsertError } = await supabaseAdmin
        .from("transcript_segments")
        .insert({
        meeting_id: resolvedMeetingId,
        speaker_name: transcript?.speaker?.name ?? null,
        content,
        started_at: startedAt,
        ended_at: transcript?.end_timestamp ?? null,
        raw_payload: payload
      });

      if (transcriptInsertError) {
        return NextResponse.json(
          {
            error: "Failed to store transcript segment",
            details: transcriptInsertError.message
          },
          { status: 500 }
        );
      }
    }
  }

  const meetingStatus = mapRecallStatus(payload);
  if (meetingStatus) {
    const { error: statusUpdateError } = await supabaseAdmin
      .from("meetings")
      .update({ status: meetingStatus })
      .eq("id", resolvedMeetingId);

    if (statusUpdateError) {
      return NextResponse.json(
        { error: "Failed to update meeting status", details: statusUpdateError.message },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}
