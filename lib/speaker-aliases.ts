import type {
  MeetingSpeakerAlias,
  MeetingSpeakerRosterItem,
  MeetingTask,
  TranscriptSegment
} from "@/lib/types";

export function buildSpeakerAliasMap(aliases: MeetingSpeakerAlias[]) {
  return new Map(
    aliases.map((alias) => [
      alias.raw_speaker_label.trim().toLowerCase(),
      alias.display_name.trim()
    ])
  );
}

function cleanLabel(value: string | null | undefined) {
  return value?.trim() || null;
}

export function getRawSpeakerLabel(
  segment: Pick<
    TranscriptSegment,
    "diarized_speaker" | "participant_name" | "speaker"
  >
) {
  return (
    cleanLabel(segment.diarized_speaker) ??
    cleanLabel(segment.participant_name) ??
    cleanLabel(segment.speaker) ??
    "Unknown Speaker"
  );
}

export function getAmbiguousParticipantNames(
  segments: Array<
    Pick<TranscriptSegment, "participant_name" | "diarized_speaker">
  >
) {
  const diarizedLabelsByParticipant = new Map<string, Set<string>>();
  for (const segment of segments) {
    const participantName = cleanLabel(segment.participant_name);
    const diarizedSpeaker = cleanLabel(segment.diarized_speaker);
    if (!participantName || !diarizedSpeaker) continue;

    const labels = diarizedLabelsByParticipant.get(participantName) ?? new Set<string>();
    labels.add(diarizedSpeaker);
    diarizedLabelsByParticipant.set(participantName, labels);
  }

  return new Set(
    Array.from(diarizedLabelsByParticipant.entries())
      .filter(([, labels]) => labels.size > 1)
      .map(([participantName]) => participantName)
  );
}

export function getMappedSpeakerName(
  rawSpeakerLabel: string,
  aliasMap: Map<string, string>
) {
  return aliasMap.get(rawSpeakerLabel.trim().toLowerCase()) ?? null;
}

export function getResolvedSpeakerName(
  segment: Pick<
    TranscriptSegment,
    "speaker" | "participant_name" | "diarized_speaker" | "resolved_speaker"
  >,
  aliasMap: Map<string, string>,
  ambiguousParticipants = new Set<string>()
) {
  const rawLabel = getRawSpeakerLabel(segment);
  const mappedName = getMappedSpeakerName(rawLabel, aliasMap);
  if (mappedName) return mappedName;

  const persistedResolution = cleanLabel(segment.resolved_speaker);
  if (persistedResolution) return persistedResolution;

  const participantName = cleanLabel(segment.participant_name);
  const diarizedSpeaker = cleanLabel(segment.diarized_speaker);
  if (
    participantName &&
    diarizedSpeaker &&
    ambiguousParticipants.has(participantName)
  ) {
    return diarizedSpeaker;
  }

  return (
    participantName ??
    diarizedSpeaker ??
    cleanLabel(segment.speaker) ??
    "Unknown Speaker"
  );
}

export function applySpeakerAliases<T extends TranscriptSegment>(
  segments: T[],
  aliases: MeetingSpeakerAlias[]
) {
  const aliasMap = buildSpeakerAliasMap(aliases);
  const ambiguousParticipants = getAmbiguousParticipantNames(segments);

  return segments.map((segment) => {
    const rawSpeakerLabel = getRawSpeakerLabel(segment);
    const mappedName = getMappedSpeakerName(rawSpeakerLabel, aliasMap);
    const resolvedSpeaker = mappedName ?? cleanLabel(segment.resolved_speaker);
    return {
      ...segment,
      resolved_speaker: resolvedSpeaker,
      speaker: getResolvedSpeakerName(segment, aliasMap, ambiguousParticipants)
    };
  });
}

export function getMappableSpeakerLabels(segments: TranscriptSegment[]) {
  const labels = new Set<string>();
  for (const segment of segments) {
    const label = getRawSpeakerLabel(segment);
    if (label) labels.add(label);
  }
  return Array.from(labels).sort((a, b) => a.localeCompare(b));
}

function matchesName(value: string | null | undefined, candidates: string[]) {
  const normalizedValue = cleanLabel(value)?.toLowerCase();
  return (
    Boolean(normalizedValue) &&
    candidates.some((candidate) => candidate.trim().toLowerCase() === normalizedValue)
  );
}

const ACTION_LANGUAGE_PATTERN =
  /\b(?:i\s+will|i['’]ll|i['’]m\s+going\s+to|i\s+am\s+going\s+to|my\s+task|i\s+can|i['’]ll\s+take|i\s+can\s+take|i['’]ll\s+handle|i\s+will\s+handle)\b/i;

function shortenQuote(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= 180) return normalized;
  const shortened = normalized.slice(0, 177);
  const lastSpace = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, Math.max(lastSpace, 120))}…`;
}

function getRepresentativeQuote(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const actionSentence = sentences.find((sentence) =>
    ACTION_LANGUAGE_PATTERN.test(sentence)
  );
  return shortenQuote(actionSentence ?? normalized);
}

export function extractPossibleNameHints(texts: string[]) {
  const hints = new Map<string, string>();
  const patterns = [
    /\b(?:I['’]m|I am)\s+([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,2})(?=[,.!?]|$)/gu,
    /\bThis is\s+([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,2})(?=[,.!?]|$)/gu,
    /\bMy name is\s+([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,2})(?=[,.!?]|$)/gu,
    /(?:^|[.!?]\s+)([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,2})\s+here\b/gu
  ];

  for (const text of texts) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const hint = match[1]?.trim();
        if (!hint || /^going(?:\s+to)?$/i.test(hint)) continue;
        if (!hints.has(hint.toLowerCase())) hints.set(hint.toLowerCase(), hint);
      }
    }
  }

  return Array.from(hints.values()).slice(0, 4);
}

export function selectExampleQuotes(texts: string[]) {
  const candidates = texts
    .map((text, index) => ({
      quote: getRepresentativeQuote(text),
      priority: ACTION_LANGUAGE_PATTERN.test(text) ? 1 : 0,
      index
    }))
    .filter((item) => item.quote.length > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  const seen = new Set<string>();
  const quotes: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push(candidate.quote);
    if (quotes.length === 4) break;
  }
  return quotes;
}

export function resolveTaskOwner(
  owner: string | null,
  aliases: MeetingSpeakerAlias[]
) {
  const normalizedOwner = cleanLabel(owner);
  if (!normalizedOwner) return null;

  const alias = aliases.find(
    (item) => item.raw_speaker_label.trim().toLowerCase() === normalizedOwner.toLowerCase()
  );
  return alias?.display_name.trim() || normalizedOwner;
}

export function applySpeakerAliasesToTasks<T extends MeetingTask>(
  tasks: T[],
  aliases: MeetingSpeakerAlias[]
) {
  return tasks.map((task) => ({
    ...task,
    owner: resolveTaskOwner(task.owner, aliases)
  }));
}

export function buildMeetingSpeakerRoster({
  segments,
  aliases,
  tasks
}: {
  segments: TranscriptSegment[];
  aliases: MeetingSpeakerAlias[];
  tasks: MeetingTask[];
}): MeetingSpeakerRosterItem[] {
  const aliasMap = buildSpeakerAliasMap(aliases);
  const rawLabelByResolvedName = new Map(
    aliases.map((alias) => [
      alias.display_name.trim().toLowerCase(),
      alias.raw_speaker_label.trim()
    ])
  );
  const ambiguousParticipants = getAmbiguousParticipantNames(segments);
  const rosterByRawLabel = new Map<
    string,
    {
      rawSpeakerLabel: string;
      participantName: string | null;
      diarizedSpeaker: string | null;
      persistedResolution: string | null;
      segmentCount: number;
      segmentTexts: string[];
    }
  >();

  for (const segment of segments) {
    const rawSpeakerLabel =
      cleanLabel(segment.diarized_speaker) ??
      cleanLabel(segment.participant_name) ??
      (cleanLabel(segment.resolved_speaker)
        ? rawLabelByResolvedName.get(
            cleanLabel(segment.resolved_speaker)!.toLowerCase()
          )
        : null) ??
      cleanLabel(segment.speaker) ??
      "Unknown Speaker";
    const key = rawSpeakerLabel.toLowerCase();
    const current = rosterByRawLabel.get(key);
    rosterByRawLabel.set(key, {
      rawSpeakerLabel: current?.rawSpeakerLabel ?? rawSpeakerLabel,
      participantName:
        current?.participantName ?? cleanLabel(segment.participant_name),
      diarizedSpeaker:
        current?.diarizedSpeaker ?? cleanLabel(segment.diarized_speaker),
      persistedResolution:
        current?.persistedResolution ?? cleanLabel(segment.resolved_speaker),
      segmentCount: (current?.segmentCount ?? 0) + 1,
      segmentTexts: [...(current?.segmentTexts ?? []), segment.text]
    });
  }

  for (const alias of aliases) {
    const rawSpeakerLabel = alias.raw_speaker_label.trim();
    const key = rawSpeakerLabel.toLowerCase();
    if (!rosterByRawLabel.has(key)) {
      rosterByRawLabel.set(key, {
        rawSpeakerLabel,
        participantName: null,
        diarizedSpeaker: /^speaker\b/i.test(rawSpeakerLabel)
          ? rawSpeakerLabel
          : null,
        persistedResolution: alias.display_name.trim(),
        segmentCount: 0,
        segmentTexts: []
      });
    }
  }

  return Array.from(rosterByRawLabel.values())
    .map((entry) => {
      const mappedName = getMappedSpeakerName(entry.rawSpeakerLabel, aliasMap);
      const isAmbiguous = Boolean(
        entry.participantName &&
          entry.diarizedSpeaker &&
          ambiguousParticipants.has(entry.participantName)
      );
      const displayName =
        mappedName ??
        entry.persistedResolution ??
        (isAmbiguous
          ? entry.diarizedSpeaker
          : entry.participantName ?? entry.diarizedSpeaker) ??
        entry.rawSpeakerLabel;
      const ownerCandidates = [
        entry.rawSpeakerLabel,
        displayName,
        ...(mappedName ? [mappedName] : [])
      ];

      return {
        rawSpeakerLabel: entry.rawSpeakerLabel,
        displayName,
        participantName: entry.participantName,
        diarizedSpeaker: entry.diarizedSpeaker,
        isResolved: Boolean(mappedName ?? entry.persistedResolution),
        isAmbiguous,
        segmentCount: entry.segmentCount,
        taskCount: tasks.filter((task) => matchesName(task.owner, ownerCandidates)).length,
        exampleQuotes: selectExampleQuotes(entry.segmentTexts),
        possibleNameHints: extractPossibleNameHints(entry.segmentTexts)
      };
    })
    .sort((a, b) => a.rawSpeakerLabel.localeCompare(b.rawSpeakerLabel));
}
