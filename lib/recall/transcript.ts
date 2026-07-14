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
  speaker_id?: string | number | null;
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
    formatSpeakerLabel(typedUtterance.speaker_id) ??
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
    formatSpeakerLabel(typedUtterance.speaker_id) ??
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

function findTranscriptDownloadUrl(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;

  const object = asObject(value);
  if (!object) return null;

  const data = asObject(object.data);
  const directDownloadUrl = asNonEmptyString(data?.download_url);
  if (directDownloadUrl) return directDownloadUrl;

  const mediaShortcuts = asObject(object.media_shortcuts);
  const mediaTranscript = asObject(mediaShortcuts?.transcript);
  const mediaTranscriptData = asObject(mediaTranscript?.data);
  const shortcutDownloadUrl = asNonEmptyString(mediaTranscriptData?.download_url);
  if (shortcutDownloadUrl) return shortcutDownloadUrl;

  for (const key of ["recordings", "transcripts", "transcript_artifacts", "artifacts"]) {
    const array = object[key];
    if (!Array.isArray(array)) continue;

    for (const item of array) {
      const nestedDownloadUrl = findTranscriptDownloadUrl(item, depth + 1);
      if (nestedDownloadUrl) return nestedDownloadUrl;
    }
  }

  const nestedDataDownloadUrl = data ? findTranscriptDownloadUrl(data, depth + 1) : null;
  if (nestedDataDownloadUrl) return nestedDataDownloadUrl;

  const bot = asObject(object.bot);
  return bot ? findTranscriptDownloadUrl(bot, depth + 1) : null;
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

export async function fetchRecallTranscript(recallBotId: string): Promise<unknown> {
  const apiKey = process.env.RECALL_API_KEY?.trim();
  const region = process.env.RECALL_REGION?.trim() || "us-west-2";

  if (!apiKey) {
    throw new Error("Missing RECALL_API_KEY");
  }

  const directTranscriptUrl = `https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(recallBotId)}/transcript/`;
  const directResponse = await fetch(directTranscriptUrl, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
  const directBodyText = await directResponse.text();

  if (directResponse.ok) {
    let directBody: unknown = directBodyText;
    try {
      directBody = directBodyText ? (JSON.parse(directBodyText) as unknown) : [];
    } catch {
      directBody = directBodyText;
    }

    const directEntries = Array.isArray(directBody)
      ? directBody
      : pickUtteranceArray(directBody);
    console.info("Recall bot transcript endpoint fetched", {
      bot_id: recallBotId,
      transcript_entry_count: directEntries.length
    });
    return directBody;
  }

  // Some Recall workspaces return a legacy-endpoint response here. Fall back
  // to the current bot recording transcript download URL without ever using
  // /api/v1/transcript/{transcript_id}/.
  console.info("Recall bot transcript endpoint unavailable; checking bot recording", {
    bot_id: recallBotId,
    status: directResponse.status
  });

  const botUrl = `https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(recallBotId)}/`;
  const botResponse = await fetch(botUrl, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const botBodyText = await botResponse.text();
  let botBody: unknown = botBodyText;
  try {
    botBody = botBodyText ? (JSON.parse(botBodyText) as unknown) : {};
  } catch {
    botBody = botBodyText;
  }

  if (!botResponse.ok) {
    console.error("Recall bot metadata fetch failed", {
      bot_id: recallBotId,
      status: botResponse.status,
      body: botBodyText
    });
    throw new Error(`Recall bot metadata fetch failed: ${botResponse.status}`);
  }

  const downloadUrl = findTranscriptDownloadUrl(botBody);
  if (!downloadUrl) {
    console.info("Recall transcript download URL not ready", {
      bot_id: recallBotId,
      transcript_entry_count: 0,
      sample_speakers: []
    });
    return [];
  }

  const transcriptResponse = await fetch(downloadUrl, { method: "GET" });
  const transcriptBodyText = await transcriptResponse.text();
  let transcriptBody: unknown = transcriptBodyText;
  try {
    transcriptBody = transcriptBodyText ? (JSON.parse(transcriptBodyText) as unknown) : [];
  } catch {
    transcriptBody = transcriptBodyText;
  }

  if (!transcriptResponse.ok) {
    console.error("Recall transcript download failed", {
      bot_id: recallBotId,
      status: transcriptResponse.status,
      body: transcriptBodyText
    });
    throw new Error(`Recall transcript download failed: ${transcriptResponse.status}`);
  }

  const entries = Array.isArray(transcriptBody) ? transcriptBody : pickUtteranceArray(transcriptBody);
  const sampleSpeakers = entries
    .slice(0, 5)
    .map((entry) => {
      const object = asObject(entry);
      const participant = asObject(object?.participant);
      return (
        asNonEmptyString(participant?.name) ??
        asNonEmptyString(object?.speaker) ??
        asNonEmptyString(object?.speaker_id) ??
        "Unknown Speaker"
      );
    });

  console.info("Recall transcript downloaded", {
    bot_id: recallBotId,
    transcript_entry_count: entries.length,
    sample_speakers: sampleSpeakers
  });

  return transcriptBody;
}
