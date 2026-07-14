import { fetchRecallTranscript, parseRecallTranscriptToSegments } from "@/lib/recall/transcript";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function replaceMeetingTranscriptFromRecall({
  meetingId,
  recallBotId
}: {
  meetingId: string;
  recallBotId: string;
}) {
  const transcriptContent = await fetchRecallTranscript(recallBotId);
  const parsedRows = parseRecallTranscriptToSegments(transcriptContent);
  const sampleSpeakers = parsedRows
    .slice(0, 5)
    .map((row) => row.speaker ?? row.participant_name ?? row.diarized_speaker ?? "Unknown Speaker");

  console.info("Recall transcript rows parsed", {
    bot_id: recallBotId,
    transcript_entry_count: parsedRows.length,
    sample_speakers: sampleSpeakers
  });

  if (parsedRows.length === 0) {
    return { insertedCount: 0, parsedCount: 0, ready: false };
  }

  await supabaseAdmin.from("transcript_segments").delete().eq("meeting_id", meetingId);

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
    throw new Error(insertError.message);
  }

  return {
    insertedCount: insertedRows?.length ?? 0,
    parsedCount: parsedRows.length,
    ready: true
  };
}
