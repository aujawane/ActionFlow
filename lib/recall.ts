import { env } from "@/lib/env";

interface CreateRecallBotInput {
  meetingUrl: string;
  webhookUrl: string;
  meetingId: string;
}

interface RecallBotResponse {
  id: string;
  status: string;
}

export async function createRecallBot(
  input: CreateRecallBotInput
): Promise<RecallBotResponse> {
  const response = await fetch("https://api.recall.ai/api/v1/bot/", {
    method: "POST",
    headers: {
      Authorization: `Token ${env.RECALL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      meeting_url: input.meetingUrl,
      recording_config: {
        transcript: {
          provider: {
            deepgram_streaming: {}
          }
        }
      },
      metadata: {
        meeting_id: input.meetingId
      },
      webhook_url: input.webhookUrl
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create Recall bot: ${response.status} ${body}`);
  }

  return (await response.json()) as RecallBotResponse;
}

export function isValidRecallWebhookSignature(
  signatureHeader: string | null,
  rawBody: string
) {
  if (!signatureHeader) return false;

  // TODO: Replace this placeholder logic with Recall's official signature validation.
  // Use env.RECALL_WEBHOOK_SECRET and HMAC validation from Recall docs.
  return signatureHeader.length > 10 && rawBody.length > 0;
}
