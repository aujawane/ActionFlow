import { getOpenAIModel, openai } from "@/lib/openai";
import { PARFAIT_RESPONSE_INSTRUCTIONS } from "@/lib/parfait-response/prompt";
import { parfaitResponseJsonSchema, parseParfaitResponse } from "@/lib/parfait-response/schema";
import type { ParfaitResponse } from "@/lib/types";

/**
 * Commitment Workspace's "Ask Parfait" -- the first chat surface migrated to the shared
 * structured-response contract (see PR description rollout notes for why this one first: it had
 * zero structured output before this, a bare openai.responses.create text call with no schema at
 * all, so there was no existing behavior to preserve or reconcile). Domain instructions (what the
 * assistant knows, what it must never claim) stay specific to this surface; response-SHAPE
 * instructions are shared (lib/parfait-response/prompt.ts) so every migrated surface answers the
 * same way structurally.
 */

const SYSTEM_PROMPT = [
  "You are Parfait, helping execute one commitment. Use the commitment, its tasks, evidence, and",
  "conversation history provided to answer. Identify blockers and the next concrete action when",
  "relevant to the question. Do not claim to edit data -- you can only describe what should",
  "change; the user makes changes elsewhere in the product.",
  "",
  PARFAIT_RESPONSE_INSTRUCTIONS
].join("\n");

export async function runCommitmentChatAgent(input: {
  commitment: unknown;
  tasks: unknown;
  conversation: Array<{ role: string; message: string }>;
  latestMessage: string;
}): Promise<
  | { ok: true; response: ParfaitResponse }
  | { ok: false; error: string; details?: string }
> {
  try {
    const result = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            commitment: input.commitment,
            tasks: input.tasks,
            conversation: input.conversation,
            latest_message: input.latestMessage
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "parfait_commitment_chat_response",
          strict: true,
          schema: parfaitResponseJsonSchema
        }
      }
    });

    const raw = result.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned an empty response." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "OpenAI returned invalid JSON.", details: raw.slice(0, 500) };
    }

    const validated = parseParfaitResponse(parsed);
    if (!validated.ok) {
      return {
        ok: false,
        error: "OpenAI response did not match the shared response schema.",
        details: validated.error
      };
    }

    return { ok: true, response: validated.response };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to run the commitment chat assistant.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
