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
  resolved_speaker: string | null;
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
      resolved_speaker: null,
      speaker_confidence: extractSpeakerConfidence(utterance),
      text,
      timestamp: extractTimestamp(utterance),
      raw_payload: utterance
    });
  }

  return segments;
}

export function getRecallTranscriptDiagnostics(payload: unknown) {
  const entries = pickUtteranceArray(payload);
  const participantNames = new Set<string>();
  const diarizedSpeakerLabels = new Set<string>();
  const parserDerivedDiarizedLabels = new Set<string>();
  const speakerIds = new Set<string>();

  for (const entry of entries.slice(0, 25)) {
    const utterance = asObject(entry);
    if (!utterance) continue;
    const typedUtterance = utterance as RecallTranscriptEntry;
    const speaker = asObject(typedUtterance.speaker);
    const words = Array.isArray(typedUtterance.words) ? typedUtterance.words : [];
    const firstWord = asObject(words[0]);
    const participantName = extractParticipantName(utterance);
    const explicitDiarizedSpeaker =
      formatSpeakerLabel(typedUtterance.diarized_speaker) ??
      formatSpeakerLabel(typedUtterance.diarized_speaker_label) ??
      formatSpeakerLabel(typedUtterance.speaker_label) ??
      formatSpeakerLabel(speaker?.label as string | number | null | undefined) ??
      formatSpeakerLabel(firstWord?.speaker as string | number | null | undefined) ??
      formatSpeakerLabel(
        firstWord?.speaker_label as string | number | null | undefined
      ) ??
      formatSpeakerLabel(typedUtterance.channel);
    const parserDerivedDiarizedSpeaker = extractDiarizedSpeaker(utterance);
    const speakerId =
      idToDiagnosticString(typedUtterance.speaker_id) ??
      idToDiagnosticString(speaker?.id);
    if (participantName) participantNames.add(participantName);
    if (explicitDiarizedSpeaker) diarizedSpeakerLabels.add(explicitDiarizedSpeaker);
    if (parserDerivedDiarizedSpeaker) {
      parserDerivedDiarizedLabels.add(parserDerivedDiarizedSpeaker);
    }
    if (speakerId) speakerIds.add(speakerId);
  }

  return {
    transcript_entry_count: entries.length,
    sample_participant_names: Array.from(participantNames).slice(0, 5),
    sample_diarized_speaker_labels: Array.from(diarizedSpeakerLabels).slice(0, 5),
    sample_parser_derived_diarized_labels: Array.from(
      parserDerivedDiarizedLabels
    ).slice(0, 5),
    sample_speaker_ids: Array.from(speakerIds).slice(0, 5),
    sample_raw_entry_keys: entries.slice(0, 3).map((entry) => {
      const object = asObject(entry);
      return object ? Object.keys(object).sort() : [];
    })
  };
}

function idToDiagnosticString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asNonEmptyString(value);
}

function getStatus(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = asObject(value);
  return (
    asNonEmptyString(object?.code) ??
    asNonEmptyString(object?.status) ??
    null
  );
}

function getProvider(value: unknown): string | string[] | null {
  const providerName = asNonEmptyString(value);
  if (providerName) return providerName;
  const provider = asObject(value);
  return provider ? Object.keys(provider).sort() : null;
}

function getTranscriptConfig(transcript: JsonObject) {
  const metadata = asObject(transcript.metadata);
  const transcriptConfig =
    asObject(metadata?.transcript_config) ??
    asObject(metadata?.config) ??
    metadata;
  return {
    provider:
      getProvider(transcript.provider) ??
      getProvider(transcriptConfig?.provider),
    diarization:
      asObject(transcript.diarization) ??
      asObject(transcriptConfig?.diarization) ??
      null,
    status: getStatus(transcript.status) ?? getStatus(transcript.data)
  };
}

function getBotRecordingTranscript(payload: unknown) {
  const root = asObject(payload);
  const data = asObject(root?.data);
  const bot = asObject(root?.bot) ?? asObject(data?.bot) ?? root;
  const recordingConfig = asObject(bot?.recording_config);
  const botTranscriptConfig = asObject(recordingConfig?.transcript);
  const recordings = Array.isArray(bot?.recordings) ? bot.recordings : [];
  const recordingValue =
    recordings.find((value) => {
      const recording = asObject(value);
      const mediaShortcuts = asObject(recording?.media_shortcuts);
      return Boolean(asObject(mediaShortcuts?.transcript));
    }) ?? recordings[0];
  const recording = asObject(recordingValue);
  const mediaShortcuts = asObject(recording?.media_shortcuts);
  const transcript = asObject(mediaShortcuts?.transcript);

  return {
    recordingId: idToDiagnosticString(recording?.id),
    transcript,
    transcriptArtifactId: idToDiagnosticString(transcript?.id),
    botTranscriptConfig
  };
}

export type RecallTranscriptFetchDiagnostics = {
  botRequestUrl: string;
  botResponseStatus: number | null;
  botResponse: unknown;
  recordingId: string | null;
  transcriptArtifactId: string | null;
  transcriptProvider: string | string[] | null;
  transcriptDiarizationConfig: JsonObject | null;
  transcriptStatus: string | null;
  transcriptRetrieveUrl: string | null;
  transcriptRetrieveStatus: number | null;
  transcriptArtifactResponse: unknown;
  transcriptDownloadStatus: number | null;
};

export class RecallTranscriptFetchError extends Error {
  diagnostics: RecallTranscriptFetchDiagnostics;

  constructor(message: string, diagnostics: RecallTranscriptFetchDiagnostics) {
    super(message);
    this.name = "RecallTranscriptFetchError";
    this.diagnostics = diagnostics;
  }
}

export async function fetchRecallTranscriptWithDiagnostics(recallBotId: string) {
  const apiKey = process.env.RECALL_API_KEY?.trim();
  const region = process.env.RECALL_REGION?.trim() || "us-west-2";

  if (!apiKey) {
    throw new Error("Missing RECALL_API_KEY");
  }

  const botRequestUrl = `https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(recallBotId)}/`;
  const diagnostics: RecallTranscriptFetchDiagnostics = {
    botRequestUrl,
    botResponseStatus: null,
    botResponse: null,
    recordingId: null,
    transcriptArtifactId: null,
    transcriptProvider: null,
    transcriptDiarizationConfig: null,
    transcriptStatus: null,
    transcriptRetrieveUrl: null,
    transcriptRetrieveStatus: null,
    transcriptArtifactResponse: null,
    transcriptDownloadStatus: null
  };

  const botResponse = await fetch(botRequestUrl, {
    method: "GET",
    headers: {
      Authorization: `Token ${apiKey}`,
      Accept: "application/json"
    },
    cache: "no-store"
  });
  diagnostics.botResponseStatus = botResponse.status;
  const botBodyText = await botResponse.text();
  let botBody: unknown = null;
  try {
    botBody = botBodyText ? (JSON.parse(botBodyText) as unknown) : {};
  } catch {
    botBody = botBodyText;
  }
  diagnostics.botResponse = botBody;

  if (!botResponse.ok) {
    throw new RecallTranscriptFetchError(
      `Recall bot metadata fetch failed: ${botResponse.status}`,
      diagnostics
    );
  }

  const shortcut = getBotRecordingTranscript(botBody);
  diagnostics.recordingId = shortcut.recordingId;
  diagnostics.transcriptArtifactId = shortcut.transcriptArtifactId;
  const initialTranscriptConfig =
    shortcut.transcript ?? shortcut.botTranscriptConfig;
  if (initialTranscriptConfig) {
    const config = getTranscriptConfig(initialTranscriptConfig);
    diagnostics.transcriptProvider = config.provider;
    diagnostics.transcriptDiarizationConfig = config.diarization;
    diagnostics.transcriptStatus = config.status;
  }

  let transcriptArtifact: unknown = shortcut.transcript;
  if (shortcut.transcriptArtifactId) {
    const retrieveUrl = `https://${region}.recall.ai/api/v1/transcript/${encodeURIComponent(shortcut.transcriptArtifactId)}/`;
    diagnostics.transcriptRetrieveUrl = retrieveUrl;
    const transcriptResponse = await fetch(retrieveUrl, {
      method: "GET",
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json"
      },
      cache: "no-store"
    });
    diagnostics.transcriptRetrieveStatus = transcriptResponse.status;
    const transcriptResponseText = await transcriptResponse.text();
    try {
      transcriptArtifact = transcriptResponseText
        ? (JSON.parse(transcriptResponseText) as unknown)
        : {};
    } catch {
      transcriptArtifact = transcriptResponseText;
    }
    diagnostics.transcriptArtifactResponse = transcriptArtifact;

    if (!transcriptResponse.ok) {
      throw new RecallTranscriptFetchError(
        `Recall transcript retrieve failed: ${transcriptResponse.status}`,
        diagnostics
      );
    }

    const artifactObject = asObject(transcriptArtifact);
    if (artifactObject) {
      const config = getTranscriptConfig(artifactObject);
      diagnostics.transcriptProvider =
        config.provider ?? diagnostics.transcriptProvider;
      diagnostics.transcriptDiarizationConfig =
        config.diarization ?? diagnostics.transcriptDiarizationConfig;
      diagnostics.transcriptStatus =
        config.status ?? diagnostics.transcriptStatus;
    }
  } else {
    diagnostics.transcriptArtifactResponse = shortcut.transcript;
  }

  const downloadUrl = findTranscriptDownloadUrl(transcriptArtifact);
  console.info("[recall] Transcript artifact resolved", {
    bot_id: recallBotId,
    recording_id: diagnostics.recordingId,
    transcript_artifact_id: diagnostics.transcriptArtifactId,
    transcript_provider: diagnostics.transcriptProvider,
    transcript_diarization_config: diagnostics.transcriptDiarizationConfig,
    transcript_status: diagnostics.transcriptStatus
  });

  if (!downloadUrl) {
    console.info("[recall] Transcript data not ready", {
      bot_id: recallBotId,
      recording_id: diagnostics.recordingId,
      transcript_artifact_id: diagnostics.transcriptArtifactId,
      transcript_provider: diagnostics.transcriptProvider,
      transcript_diarization_config: diagnostics.transcriptDiarizationConfig,
      transcript_status: diagnostics.transcriptStatus,
      transcript_entry_count: 0,
      first_entry_keys: []
    });
    return { transcript: [], diagnostics };
  }

  const transcriptResponse = await fetch(downloadUrl, { method: "GET" });
  diagnostics.transcriptDownloadStatus = transcriptResponse.status;
  const transcriptBodyText = await transcriptResponse.text();
  let transcriptBody: unknown = transcriptBodyText;
  try {
    transcriptBody = transcriptBodyText ? (JSON.parse(transcriptBodyText) as unknown) : [];
  } catch {
    transcriptBody = transcriptBodyText;
  }

  if (!transcriptResponse.ok) {
    throw new RecallTranscriptFetchError(
      `Recall transcript download failed: ${transcriptResponse.status}`,
      diagnostics
    );
  }

  const transcriptDiagnostics = getRecallTranscriptDiagnostics(transcriptBody);
  console.info("[recall] Transcript downloaded", {
    bot_id: recallBotId,
    recording_id: diagnostics.recordingId,
    transcript_artifact_id: diagnostics.transcriptArtifactId,
    transcript_provider: diagnostics.transcriptProvider,
    transcript_diarization_config: diagnostics.transcriptDiarizationConfig,
    transcript_status: diagnostics.transcriptStatus,
    transcript_entry_count: transcriptDiagnostics.transcript_entry_count,
    first_entry_keys: transcriptDiagnostics.sample_raw_entry_keys[0] ?? []
  });

  return { transcript: transcriptBody, diagnostics };
}

export async function fetchRecallTranscript(recallBotId: string): Promise<unknown> {
  const result = await fetchRecallTranscriptWithDiagnostics(recallBotId);
  return result.transcript;
}
