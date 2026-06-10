type JsonObject = Record<string, unknown>;

export interface ParsedTranscriptSegment {
  speaker: string | null;
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
        return asString(asWordObject?.text) ?? asString(asWordObject?.word) ?? "";
      })
      .join(" ")
      .trim();
    if (joined) return joined;
  }

  return "";
}

function extractSpeaker(utterance: JsonObject): string | null {
  return (
    asString(utterance.speaker_name) ??
    asString(utterance.speaker) ??
    asString(utterance.participant_name) ??
    asString(utterance.participant) ??
    null
  );
}

function extractTimestamp(utterance: JsonObject): string {
  return (
    asString(utterance.start_timestamp) ??
    asString(utterance.timestamp) ??
    asString(utterance.end_timestamp) ??
    new Date().toISOString()
  );
}

function pickUtteranceArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  const obj = asObject(payload);
  if (!obj) return [];

  const transcript = obj.transcript;
  if (Array.isArray(transcript)) return transcript;

  const utterances = obj.utterances;
  if (Array.isArray(utterances)) return utterances;

  const results = obj.results;
  if (Array.isArray(results)) return results;

  const nestedData = asObject(obj.data);
  if (nestedData) {
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

  const url = `https://${region}.recall.ai/api/v1/transcript/${encodeURIComponent(transcriptId)}/`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const bodyText = await response.text();
  if (!response.ok) {
    console.error("Recall transcript fetch failed", {
      status: response.status,
      body: bodyText
    });
    throw new Error(`Recall transcript fetch failed: ${response.status} ${bodyText}`);
  }

  try {
    return bodyText ? (JSON.parse(bodyText) as unknown) : {};
  } catch {
    return {};
  }
}
