type JsonObject = Record<string, unknown>;

export interface RecallTranscriptParticipant {
  id?: number | string;
  name?: string | null;
}

export interface RecallTranscriptWord {
  text?: string | null;
  word?: string | null;
  start_timestamp?: string | null;
  end_timestamp?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  start?: string | number | null;
  end?: string | number | null;
}

export interface RecallTranscriptEntry {
  participant?: RecallTranscriptParticipant | string | null;
  participant_name?: string | null;
  speaker?: { name?: string | null } | string | null;
  speaker_name?: string | null;
  speaker_label?: string | null;
  diarized_speaker?: string | null;
  diarized_speaker_label?: string | null;
  channel?: string | number | null;
  confidence?: number | null;
  speaker_confidence?: number | null;
  text?: string | null;
  words?: RecallTranscriptWord[] | string | null;
  start_timestamp?: string | null;
  timestamp?: string | null;
  end_timestamp?: string | null;
}

export interface ParsedTranscriptSegment {
  speaker: string | null;
  participant_name: string | null;
  diarized_speaker: string | null;
  speaker_confidence: number | null;
  text: string;
  timestamp: string;
  raw_payload: unknown;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTimestamp(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : null;
}

function extractText(utterance: JsonObject): string {
  const fromText = asString(utterance.text);
  if (fromText && fromText.trim()) return fromText.trim();

  const fromWords = utterance.words;
  if (typeof fromWords === "string" && fromWords.trim()) {
    return fromWords.trim();
  }

  if (Array.isArray(fromWords)) {
    const joined = fromWords
      .map((word) => {
        if (typeof word === "string") return word;
        const asWordObject = asObject(word);
        return asNonEmptyString(asWordObject?.text) ?? asNonEmptyString(asWordObject?.word) ?? "";
      })
      .join(" ")
      .trim();
    if (joined) return joined;
  }

  return "";
}

function extractSpeaker(utterance: JsonObject): string | null {
  const typedUtterance = utterance as RecallTranscriptEntry;
  const speaker = asObject(typedUtterance.speaker);

  return (
    extractParticipantName(utterance) ??
    extractDiarizedSpeaker(utterance) ??
    asNonEmptyString(speaker?.name) ??
    asNonEmptyString(typedUtterance.speaker_name) ??
    asNonEmptyString(typedUtterance.speaker) ??
    asNonEmptyString(typedUtterance.participant) ??
    null
  );
}

function extractParticipantName(utterance: JsonObject): string | null {
  const typedUtterance = utterance as RecallTranscriptEntry;
  const participant = asObject(typedUtterance.participant);
  return (
    asNonEmptyString(participant?.name) ??
    asNonEmptyString(typedUtterance.participant_name) ??
    null
  );
}

function formatSpeakerLabel(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `Speaker ${value}`;
  }

  const label = asNonEmptyString(value);
  if (!label) return null;
  return /^speaker\s+/i.test(label) ? label : `Speaker ${label}`;
}

function extractDiarizedSpeaker(utterance: JsonObject): string | null {
  const typedUtterance = utterance as RecallTranscriptEntry;
  const speaker = asObject(typedUtterance.speaker);
  const words = Array.isArray(typedUtterance.words) ? typedUtterance.words : [];
  const firstWord = asObject(words[0]);

  return (
    formatSpeakerLabel(typedUtterance.diarized_speaker) ??
    formatSpeakerLabel(typedUtterance.diarized_speaker_label) ??
    formatSpeakerLabel(typedUtterance.speaker_label) ??
    formatSpeakerLabel(speaker?.label as string | number | null | undefined) ??
    formatSpeakerLabel(speaker?.id as string | number | null | undefined) ??
    formatSpeakerLabel(firstWord?.speaker as string | number | null | undefined) ??
    formatSpeakerLabel(firstWord?.speaker_label as string | number | null | undefined) ??
    formatSpeakerLabel(typedUtterance.channel) ??
    null
  );
}

function extractSpeakerConfidence(utterance: JsonObject): number | null {
  const typedUtterance = utterance as RecallTranscriptEntry;
  const speaker = asObject(typedUtterance.speaker);
  return (
    asNumber(typedUtterance.speaker_confidence) ??
    asNumber(typedUtterance.confidence) ??
    asNumber(speaker?.confidence) ??
    null
  );
}

function extractTimestamp(utterance: JsonObject): string {
  const fromWords = utterance.words;
  if (Array.isArray(fromWords)) {
    const firstWord = asObject(fromWords[0]);
    const firstWordTimestamp =
      asTimestamp(firstWord?.start_timestamp) ??
      asTimestamp(firstWord?.start_time) ??
      asTimestamp(firstWord?.start);
    if (firstWordTimestamp) return firstWordTimestamp;
  }

  return (
    asTimestamp(utterance.start_timestamp) ??
    asTimestamp(utterance.timestamp) ??
    asTimestamp(utterance.end_timestamp) ??
    new Date().toISOString()
  );
}

function pickUtteranceArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  const obj = asObject(payload);
  if (!obj) return [];

  const segments = obj.segments;
  if (Array.isArray(segments)) return segments;

  const transcript = obj.transcript;
  if (Array.isArray(transcript)) return transcript;

  const utterances = obj.utterances;
  if (Array.isArray(utterances)) return utterances;

  const results = obj.results;
  if (Array.isArray(results)) return results;

  const nestedData = asObject(obj.data);
  if (nestedData) {
    if (Array.isArray(nestedData.segments)) return nestedData.segments;
    if (Array.isArray(nestedData.transcript)) return nestedData.transcript;
    if (Array.isArray(nestedData.utterances)) return nestedData.utterances;
    if (Array.isArray(nestedData.results)) return nestedData.results;
  }

  return [];
}

export function parseRecallTranscriptToSegments(payload: unknown): ParsedTranscriptSegment[] {
  const utterances = pickUtteranceArray(payload);

  const segments: ParsedTranscriptSegment[] = [];
  for (const entry of utterances) {
    const utterance = asObject(entry);
    if (!utterance) continue;

    const text = extractText(utterance);
    if (!text) continue;

    segments.push({
      speaker: extractSpeaker(utterance),
      participant_name: extractParticipantName(utterance),
      diarized_speaker: extractDiarizedSpeaker(utterance),
      speaker_confidence: extractSpeakerConfidence(utterance),
      text,
      timestamp: extractTimestamp(utterance),
      raw_payload: utterance
    });
  }

  return segments;
}

export async function fetchRecallTranscript(transcriptId: string): Promise<unknown> {
  const apiKey = process.env.RECALL_API_KEY?.trim();
  const region = process.env.RECALL_REGION?.trim();

  if (!apiKey) {
    throw new Error("Missing RECALL_API_KEY");
  }

  if (!region) {
    throw new Error("Missing RECALL_REGION");
  }

  const isDev = process.env.NODE_ENV !== "production";
  const metadataUrl = `https://${region}.recall.ai/api/v1/transcript/${encodeURIComponent(transcriptId)}/`;
  console.info("Recall transcript metadata fetch request", { request_url: metadataUrl });

  const metadataResponse = await fetch(metadataUrl, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const metadataBodyText = await metadataResponse.text();
  let metadataBody: unknown = metadataBodyText;
  try {
    metadataBody = metadataBodyText ? (JSON.parse(metadataBodyText) as unknown) : {};
  } catch {
    metadataBody = metadataBodyText;
  }

  if (!metadataResponse.ok) {
    console.error("Recall transcript metadata fetch failed", {
      status: metadataResponse.status,
      body: metadataBodyText
    });
    throw new Error(
      `Recall transcript fetch failed: ${metadataResponse.status} ${metadataBodyText}`
    );
  }

  const metadataObject = asObject(metadataBody);
  const metadataData = asObject(metadataObject?.data);
  const downloadUrl =
    asString(metadataData?.download_url) ?? asString(metadataData?.provider_data_download_url);

  if (!downloadUrl) {
    throw new Error("Recall transcript metadata missing data.download_url");
  }

  const contentResponse = await fetch(downloadUrl, { method: "GET" });
  console.info("Recall transcript content fetch response", {
    status: contentResponse.status
  });

  const contentBodyText = await contentResponse.text();
  let contentBody: unknown = contentBodyText;
  try {
    contentBody = contentBodyText ? (JSON.parse(contentBodyText) as unknown) : {};
  } catch {
    contentBody = contentBodyText;
  }

  if (!contentResponse.ok) {
    console.error("Recall transcript content fetch failed", {
      status: contentResponse.status,
      body: contentBodyText
    });
    throw new Error(
      `Recall transcript content fetch failed: ${contentResponse.status} ${contentBodyText}`
    );
  }

  if (isDev) {
    const contentObject = asObject(contentBody);
    console.info("Recall transcript content keys", {
      keys: contentObject ? Object.keys(contentObject) : []
    });

    const candidates = [
      contentObject?.utterances,
      contentObject?.segments,
      contentObject?.transcript,
      contentObject?.results
    ].find((value) => Array.isArray(value)) as unknown[] | undefined;

    console.info("Recall transcript first items", {
      first_three: candidates ? candidates.slice(0, 3) : []
    });
  }

  return contentBody;
}
