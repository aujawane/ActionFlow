import type { MeetingSpeakerAlias, TranscriptSegment } from "@/lib/types";

export function buildSpeakerAliasMap(aliases: MeetingSpeakerAlias[]) {
  return new Map(
    aliases.map((alias) => [alias.raw_speaker_label.trim(), alias.display_name.trim()])
  );
}

export function getRawSpeakerLabel(segment: Pick<TranscriptSegment, "diarized_speaker" | "speaker">) {
  return segment.diarized_speaker?.trim() || segment.speaker?.trim() || null;
}

export function getResolvedSpeakerName(
  segment: Pick<
    TranscriptSegment,
    "speaker" | "participant_name" | "diarized_speaker"
  >,
  aliasMap: Map<string, string>,
  ambiguousParticipants = new Set<string>()
) {
  const rawLabel = getRawSpeakerLabel(segment);
  if (rawLabel && aliasMap.has(rawLabel)) {
    return aliasMap.get(rawLabel) ?? rawLabel;
  }

  const participantName = segment.participant_name?.trim();
  if (
    participantName &&
    segment.diarized_speaker?.trim() &&
    ambiguousParticipants.has(participantName)
  ) {
    return segment.diarized_speaker.trim();
  }

  return segment.speaker?.trim() || segment.participant_name?.trim() || rawLabel || "Unknown Speaker";
}

export function applySpeakerAliases<T extends TranscriptSegment>(
  segments: T[],
  aliases: MeetingSpeakerAlias[]
) {
  const aliasMap = buildSpeakerAliasMap(aliases);
  const diarizedLabelsByParticipant = new Map<string, Set<string>>();
  for (const segment of segments) {
    const participantName = segment.participant_name?.trim();
    const diarizedSpeaker = segment.diarized_speaker?.trim();
    if (!participantName || !diarizedSpeaker) continue;

    const labels = diarizedLabelsByParticipant.get(participantName) ?? new Set<string>();
    labels.add(diarizedSpeaker);
    diarizedLabelsByParticipant.set(participantName, labels);
  }
  const ambiguousParticipants = new Set(
    Array.from(diarizedLabelsByParticipant.entries())
      .filter(([, labels]) => labels.size > 1)
      .map(([participantName]) => participantName)
  );

  return segments.map((segment) => ({
    ...segment,
    speaker: getResolvedSpeakerName(segment, aliasMap, ambiguousParticipants)
  }));
}

export function getMappableSpeakerLabels(segments: TranscriptSegment[]) {
  const labels = new Set<string>();
  for (const segment of segments) {
    const label = segment.diarized_speaker?.trim();
    if (label) labels.add(label);
  }
  return Array.from(labels).sort((a, b) => a.localeCompare(b));
}
