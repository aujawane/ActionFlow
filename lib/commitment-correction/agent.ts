import { getOpenAIModel, openai } from "@/lib/openai";
import type { CommitmentCorrectionContext } from "@/lib/commitment-correction/context";
import {
  commitmentCorrectionJsonSchema,
  commitmentCorrectionResponseSchema
} from "@/lib/commitment-correction/schema";
import type { CommitmentCorrectionResponse } from "@/lib/commitment-correction/schema";

/**
 * Correct-with-Parfait: a small, single-entity assistant that turns a freeform correction
 * request ("the deadline is August 20") into structured proposed changes -- never a direct
 * database write. See lib/commitment-correction/validate.ts for the server-side layer that
 * re-validates every value this agent proposes before anything is ever applied; this module only
 * interprets, it never mutates.
 */

const SYSTEM_PROMPT = [
  "You are Parfait's correction assistant for a single commitment ticket.",
  "",
  "The user will describe, in their own words, something wrong with this commitment. Interpret",
  "their request against the CURRENT commitment state provided below and propose structured",
  "changes. You never apply anything yourself -- the server validates and applies changes only",
  "after the user clicks Apply. Never say or imply that a change has already been made.",
  "",
  "You may only propose changes to these fields, and no others: title, description, owner,",
  "supporting_person, due_date, priority, status. If the user describes something that isn't a",
  "correction to one of these fields (e.g. moving this to Future Scope, dismissing it, merging it",
  "with a duplicate), do not propose a change -- use responseType='clarification' or 'answer' and",
  "explain what you can't do here, or ask what they'd like.",
  "",
  "For 'owner': proposed_value must be the EXACT name of one of the participant_options provided,",
  "or the literal string 'Unassigned'. Never invent, abbreviate, or guess a name. If the user's",
  "mention (e.g. a first name) matches more than one participant, do NOT produce a proposal for",
  "that field -- respond with responseType='clarification', name the specific matching",
  "candidates, and ask which one they mean.",
  "",
  "For 'supporting_person': set supporting_person_from to the EXACT current supporting person",
  "being replaced (must be one of commitment.supporting_people) and proposed_value to their",
  "EXACT replacement (same participant-matching rule as owner). If it's unclear which existing",
  "supporting person the user means -- e.g. there are multiple and they didn't say which --",
  "ask a clarifying question instead of guessing. current_value should be the person being",
  "replaced (same as supporting_person_from) for display purposes.",
  "",
  "For 'due_date': interpret the request (including relative phrases like 'next Friday' or 'by",
  "the end of next week') using the provided 'today' date as the reference point, and set",
  "proposed_value to the resolved ABSOLUTE date in YYYY-MM-DD format. Never leave it relative.",
  "",
  "For 'priority': proposed_value must be exactly one of: low, medium, high.",
  "For 'status': proposed_value must be exactly one of: pending, in_progress, completed,",
  "dismissed, blocked. Map natural phrasing to these exact tokens (e.g. 'finished'/'done' ->",
  "completed, 'not started' -> pending).",
  "",
  "current_value should reflect the commitment's actual current value for that field so the user",
  "can see what is changing.",
  "",
  "The user may describe multiple corrections in one message (e.g. owner, due date, and priority",
  "together) -- return one entry per field in `changes`.",
  "",
  "If the user sends a follow-up that refines a change you already proposed earlier in this",
  "conversation (e.g. 'actually make it August 22'), replace that field's proposed_value with the",
  "new value -- do not add a second, conflicting entry for the same field, and do not repeat",
  "changes from earlier in the conversation that the user did not just re-confirm.",
  "",
  "If a request is ambiguous, low-confidence, or could reasonably map to more than one different",
  "outcome (e.g. 'this doesn't belong here' could mean Future Scope, a duplicate, or the wrong",
  "commitment entirely), do not propose a change -- ask a short clarifying question instead",
  "(responseType='clarification', changes=[]).",
  "",
  "If the user is only asking a question (not requesting a change), use responseType='answer'.",
  "",
  "Never invent a value with no basis in the user's message. Never propose a change you are not",
  "reasonably confident about -- ask instead.",
  "",
  "Return only the JSON object described by the schema."
].join("\n");

function historyEntry(entry: { role: "user" | "assistant"; message: string }) {
  return { role: entry.role, message: entry.message.slice(0, 4000) };
}

export async function runCommitmentCorrectionAgent(input: {
  context: CommitmentCorrectionContext;
  history: Array<{ role: "user" | "assistant"; message: string }>;
  latestUserMessage: string;
}): Promise<
  | { ok: true; result: CommitmentCorrectionResponse }
  | { ok: false; error: string; details?: string }
> {
  const payload = {
    commitment: input.context.commitment,
    source_meeting: input.context.source_meeting,
    today: input.context.today,
    participant_options: input.context.participant_options,
    // Bounded history, same limiting convention as every other chat-style agent in this repo
    // (see lib/meeting-assistant/agent.ts).
    previous_messages: input.history.slice(-20).map(historyEntry),
    latest_user_message: input.latestUserMessage
  };

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Respond to the latest message about this commitment with the required JSON.\n\n${JSON.stringify(payload)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "commitment_correction_response",
          strict: true,
          schema: commitmentCorrectionJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned an empty correction response." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid correction JSON.",
        details: raw.slice(0, 500)
      };
    }

    const validated = commitmentCorrectionResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "OpenAI correction response did not match the schema.",
        details: validated.error.message
      };
    }

    return { ok: true, result: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to run the correction assistant.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
