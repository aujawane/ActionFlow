import type { TranscriptSegment } from "@/lib/types";

type TranscriptSpeakerFields = Pick<TranscriptSegment, "participant_name" | "speaker">;

/** The launch speaker model uses only attribution Recall provides directly. */
export function getTranscriptSpeakerLabel(segment: TranscriptSpeakerFields) {
  return (
    segment.participant_name?.trim() ||
    segment.speaker?.trim() ||
    "Unknown Speaker"
  );
}

export function normalizeTranscriptSpeaker<T extends TranscriptSpeakerFields>(segment: T): T {
  return {
    ...segment,
    speaker: getTranscriptSpeakerLabel(segment)
  };
}
