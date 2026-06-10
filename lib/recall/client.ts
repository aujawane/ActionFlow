interface CreateRecallBotInput {
  meetingUrl: string;
  meetingId: string;
}

interface RecallBotResponse {
  id: string;
  status: string;
}

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
  const meetingUrl = input.meetingUrl.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const requestUrl = "https://us-west-2.recall.ai/api/v1/bot/";
    const botName = "Workflow Notetaker";
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

    console.info("Recall request diagnostics", {
      url: requestUrl,
      bot_name: botName,
      meeting_url: meetingUrl,
      auth_starts_with_token: authorizationHeader.startsWith("Token "),
      recording_config_exists: Boolean(requestBody.recording_config)
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
        body: details
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
