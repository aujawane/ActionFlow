interface CreateRecallBotInput {
  meetingUrl: string;
  meetingId: string;
}

interface RecallBotResponse {
  id: string;
  status: string;
}

export type RecallBotStatusResult = {
  id: string;
  status: string;
  raw: unknown;
  transcriptId: string | null;
  transcriptAvailable: boolean;
};

function getRecallApiKey() {
  const apiKey = process.env.RECALL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing RECALL_API_KEY");
  }
  return apiKey;
}

export async function createRecallBot(
  input: CreateRecallBotInput
): Promise<RecallBotResponse> {
  const apiKey = getRecallApiKey();
  const region = process.env.RECALL_REGION?.trim() || "us-west-2";
  const meetingUrl = input.meetingUrl.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const requestUrl = `https://${region}.recall.ai/api/v1/bot/`;
    const botName = "Parfait Notetaker";
    const authorizationHeader = `Token ${apiKey}`;
    const requestBody = {
      bot_name: botName,
      meeting_url: meetingUrl,
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: {
              mode: "prioritize_low_latency",
              language_code: "en"
            }
          },
          diarization: {
            use_separate_streams_when_available: true
          }
        }
      },
      output_media: {
        screenshare: {
          kind: "onboarding"
        }
      },
      metadata: {
        meetingId: input.meetingId
      }
    };

    console.info("[recall] Create bot request diagnostics", {
      endpoint: `https://${region}.recall.ai/api/v1/bot/`,
      payload_keys: Object.keys(requestBody).sort(),
      recording_config_keys: Object.keys(requestBody.recording_config).sort(),
      transcript_config_keys: Object.keys(
        requestBody.recording_config.transcript
      ).sort(),
      provider_keys: Object.keys(
        requestBody.recording_config.transcript.provider
      ).sort(),
      transcription_options: null,
      diarization: requestBody.recording_config.transcript.diarization
    });

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: authorizationHeader,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const responseText = await response.text();
    let responseJson: unknown = null;
    try {
      responseJson = responseText ? (JSON.parse(responseText) as unknown) : null;
    } catch {
      responseJson = null;
    }

    if (!response.ok) {
      const details =
        responseJson && typeof responseJson === "object"
          ? JSON.stringify(responseJson)
          : responseText || "Unknown Recall response";
      console.error("Recall bot creation request failed", {
        status: response.status,
        response_body_type: Array.isArray(responseJson)
          ? "array"
          : typeof responseJson,
        response_body_keys:
          responseJson && typeof responseJson === "object" && !Array.isArray(responseJson)
            ? Object.keys(responseJson as Record<string, unknown>).sort()
            : [],
        response_body_length: responseText.length
      });
      throw new Error(`Recall bot creation failed: ${response.status} ${details}`);
    }

    const bot = responseJson as Partial<RecallBotResponse> | null;
    if (!bot?.id || typeof bot.id !== "string") {
      throw new Error("Recall response missing bot id.");
    }

    console.info("Recall bot created", { bot_id: bot.id });

    return {
      id: bot.id,
      status: typeof bot.status === "string" ? bot.status : "unknown"
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Recall bot creation failed: timeout");
    }
    throw error instanceof Error
      ? error
      : new Error("Recall bot creation failed: unknown error");
  } finally {
    clearTimeout(timeout);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idToString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value);
}

function findTranscriptId(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;

  const object = asObject(value);
  if (!object) return null;

  const directTranscript = asObject(object.transcript);
  const directTranscriptId = idToString(directTranscript?.id) ?? idToString(object.transcript_id);
  if (directTranscriptId) return directTranscriptId;

  for (const key of ["transcripts", "transcript_artifacts", "recordings", "artifacts"]) {
    const array = object[key];
    if (!Array.isArray(array)) continue;
    for (const item of array) {
      const itemObject = asObject(item);
      if (key === "recordings") {
        const mediaShortcuts = asObject(itemObject?.media_shortcuts);
        const recordingTranscript = asObject(mediaShortcuts?.transcript);
        const recordingTranscriptId = idToString(recordingTranscript?.id);
        if (recordingTranscriptId) return recordingTranscriptId;
        const nested = findTranscriptId(item, depth + 1);
        if (nested) return nested;
        continue;
      }
      const itemTranscriptId =
        idToString(itemObject?.transcript_id) ??
        idToString(asObject(itemObject?.transcript)?.id) ??
        idToString(itemObject?.id);
      if (itemTranscriptId) return itemTranscriptId;
      const nested = findTranscriptId(item, depth + 1);
      if (nested) return nested;
    }
  }

  const data = asObject(object.data);
  return data ? findTranscriptId(data, depth + 1) : null;
}

function hasTranscriptDownloadUrl(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;

  const object = asObject(value);
  if (!object) return false;

  const data = asObject(object.data);
  if (asString(data?.download_url)) return true;

  const mediaShortcuts = asObject(object.media_shortcuts);
  const transcript = asObject(mediaShortcuts?.transcript);
  const transcriptData = asObject(transcript?.data);
  if (asString(transcriptData?.download_url)) return true;

  for (const key of ["recordings", "transcripts", "transcript_artifacts", "artifacts"]) {
    const array = object[key];
    if (!Array.isArray(array)) continue;
    if (array.some((item) => hasTranscriptDownloadUrl(item, depth + 1))) return true;
  }

  const nestedData = data ? hasTranscriptDownloadUrl(data, depth + 1) : false;
  if (nestedData) return true;

  const bot = asObject(object.bot);
  return bot ? hasTranscriptDownloadUrl(bot, depth + 1) : false;
}

function extractBotStatus(value: unknown): string {
  const object = asObject(value) ?? {};
  const data = asObject(object.data);
  const bot = asObject(object.bot) ?? asObject(data?.bot);

  return (
    asString(object.status) ??
    asString(asObject(object.status)?.code) ??
    asString(bot?.status) ??
    asString(asObject(bot?.status)?.code) ??
    asString(data?.status) ??
    asString(asObject(data?.status)?.code) ??
    "unknown"
  );
}

export async function fetchRecallBotStatus(botId: string): Promise<RecallBotStatusResult> {
  const apiKey = getRecallApiKey();
  const region = process.env.RECALL_REGION?.trim() || "us-west-2";
  const response = await fetch(
    `https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(botId)}/`,
    {
      method: "GET",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const responseText = await response.text();
  let responseJson: unknown = responseText;
  try {
    responseJson = responseText ? (JSON.parse(responseText) as unknown) : {};
  } catch {
    responseJson = responseText;
  }

  if (!response.ok) {
    throw new Error(`Recall bot status fetch failed: ${response.status}`);
  }

  const transcriptId = findTranscriptId(responseJson);
  return {
    id: idToString((asObject(responseJson) ?? {}).id) ?? botId,
    status: extractBotStatus(responseJson),
    raw: responseJson,
    transcriptId,
    transcriptAvailable: Boolean(transcriptId || hasTranscriptDownloadUrl(responseJson))
  };
}
