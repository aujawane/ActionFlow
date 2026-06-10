interface CreateRecallBotInput {
  meetingUrl: string;
  meetingId: string;
}

interface RecallBotResponse {
  id: string;
  status: string;
}

function getRecallApiKey() {
  const apiKey = process.env.RECALL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing RECALL_API_KEY");
  }
  return apiKey;
}

export async function createRecallBot(
  input: CreateRecallBotInput
): Promise<RecallBotResponse> {
  const apiKey = getRecallApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch("https://api.recall.ai/api/v1/bot/", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        meeting_url: input.meetingUrl,
        bot_name: "Workflow",
        metadata: {
          meeting_id: input.meetingId
        },
        recording_config: {
          transcript: {
            provider: {
              deepgram_streaming: {}
            }
          }
        }
      }),
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
      throw new Error(`Recall bot creation failed (${response.status}): ${details}`);
    }

    const bot = responseJson as Partial<RecallBotResponse> | null;
    if (!bot?.id || typeof bot.id !== "string") {
      throw new Error("Recall response missing bot id.");
    }

    return {
      id: bot.id,
      status: typeof bot.status === "string" ? bot.status : "unknown"
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Recall bot creation timed out.");
    }
    throw error instanceof Error
      ? error
      : new Error("Unknown error while creating Recall bot.");
  } finally {
    clearTimeout(timeout);
  }
}
