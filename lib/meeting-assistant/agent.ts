import { z } from "zod";

import { getOpenAIModel, openai } from "@/lib/openai";
import type { MeetingAssistantExecutionContext } from "@/lib/meeting-assistant/context";
import { getTranscriptSpeakerLabel } from "@/lib/transcript-speaker";
import type { MeetingAssistantSource, MeetingComment } from "@/lib/types";
import type { TranscriptSegment } from "@/lib/types";

/**
 * You are Parfait's meeting execution assistant -- see SYSTEM_PROMPT below for the full
 * instructions given to the model. This module owns exactly one OpenAI call per user message
 * (the existing openai.responses.create + json_schema convention, same as
 * lib/task-categorization.ts and lib/ai/task-chat-agent.ts) and the deterministic resolution of
 * cited evidence back to real transcript segments. It never mutates Parfait data itself --
 * see the brief's read/write-safety split, honored via responseType="declined_mutation" rather
 * than any structured patch/apply machinery (deliberately far simpler than task-chat-agent.ts's
 * patch-proposal system, since v1 mutation support is explicitly out of scope).
 */

const generatedContentItemSchema = z
  .object({
    title: z.string().min(1),
    subject: z.string().nullable(),
    body: z.string().min(1)
  })
  .strict();

export const meetingAssistantResponseSchema = z
  .object({
    responseType: z.enum(["answer", "generated_content", "clarification", "declined_mutation"]),
    assistantMessage: z.string().min(1),
    generatedContent: z.array(generatedContentItemSchema),
    evidenceSegmentIds: z.array(z.string())
  })
  .strict();

export type MeetingAssistantAgentResult = z.infer<typeof meetingAssistantResponseSchema>;

const generatedContentItemJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    subject: { type: ["string", "null"] },
    body: { type: "string" }
  },
  required: ["title", "subject", "body"]
};

const meetingAssistantJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    responseType: {
      type: "string",
      enum: ["answer", "generated_content", "clarification", "declined_mutation"]
    },
    assistantMessage: { type: "string" },
    generatedContent: { type: "array", items: generatedContentItemJsonSchema },
    evidenceSegmentIds: { type: "array", items: { type: "string" } }
  },
  required: ["responseType", "assistantMessage", "generatedContent", "evidenceSegmentIds"]
};

const SYSTEM_PROMPT = [
  "You are Parfait's meeting execution assistant.",
  "",
  "You answer from:",
  "- canonical meeting execution data (commitments, tasks, dependencies, deliverables, Future Scope);",
  "- meeting transcript/evidence, when provided.",
  "",
  "You help the user:",
  "- understand the meeting;",
  "- understand responsibilities;",
  "- identify blockers;",
  "- create useful follow-up work (emails, Slack updates, status updates, agendas, summaries).",
  "",
  "Never invent tasks, commitments, owners, dates, decisions, or quotes. If information is",
  "unavailable, say so plainly rather than guessing.",
  "",
  "Current canonical Parfait state overrides old extracted/raw transcript attribution. Example:",
  "the transcript may have originally attributed a task to one person, but the user later",
  "corrected the owner in Parfait -- always answer with the current, corrected owner. You may",
  "mention transcript history as context, but the canonical assignment in the data provided is",
  "authoritative for ownership/status questions.",
  "",
  "100% of a commitment's child tasks being complete does NOT necessarily mean the commitment",
  "itself is complete -- these are separate facts. Answer 'is this commitment complete' from the",
  "commitment's own status field, and explicitly note when all child tasks are done but the",
  "commitment has not been marked complete.",
  "",
  "'Blocked' means a task has an is_blocked=true / blocked_by relationship in the data provided --",
  "use that directly, never guess at a blocking relationship the data doesn't state.",
  "",
  "If the user asks you to CHANGE Parfait data (reassign an owner, change a status, move",
  "something to Future Scope, edit any task/commitment field, delete anything), do not perform or",
  "claim to perform the change. Respond with responseType='declined_mutation' and tell them to",
  "use that task's or commitment's \"...\" menu to make the correction themselves.",
  "",
  "If the user asks a question, use responseType='answer' and answer concisely and",
  "conversationally -- this includes meta-questions like 'summarize this meeting' or 'what were",
  "the decisions'.",
  "",
  "If the user asks you to draft/write/create content (an email, Slack message, status update,",
  "agenda, summary, recap, follow-up, checklist), use responseType='generated_content'. Put one",
  "short sentence introducing it in assistantMessage (e.g. 'Here is a draft:') and put the actual",
  "draft(s) in generatedContent. Generate one generatedContent entry per person when the user asks",
  "for individual/per-person output (e.g. 'draft emails for everyone' or 'individual follow-ups'),",
  "or a single entry for one shared output otherwise. Only include people, work, and dates that",
  "exist in the provided context -- never invent an email address; omit it if unavailable.",
  "",
  "When the user says something like 'make that shorter', 'more casual', 'only include Aditya's",
  "tasks', 'remove the Future Scope section', 'make the subject more direct', or 'turn that into a",
  "Slack message', they mean the most recent generatedContent earlier in this conversation --",
  "revise it accordingly (using the same source data, not fabricating anything new) and return the",
  "revised version as new generatedContent with responseType='generated_content'.",
  "",
  "If you rely on specific transcript language to answer, list the exact segment ids you used in",
  "evidenceSegmentIds -- only ids that appear in the transcript excerpts you were given, never an",
  "invented one. Leave evidenceSegmentIds empty when you didn't need transcript evidence, or when",
  "none was provided.",
  "",
  "If structured commitments/tasks were not provided because the meeting has not been analyzed",
  "yet, say so plainly and suggest running Analyze Meeting; answer only from transcript evidence",
  "if any is available. If no transcript is available for a transcript-specific question, say",
  "transcript evidence isn't available rather than guessing.",
  "",
  "Return only the JSON object described by the schema."
].join("\n");

function commentToHistoryEntry(comment: MeetingComment) {
  const generated = comment.metadata?.generatedContent ?? [];
  const message =
    generated.length > 0
      ? [
          comment.message,
          ...generated.map((item) =>
            [
              `--- ${item.title} ---`,
              item.subject ? `Subject: ${item.subject}` : null,
              item.body
            ]
              .filter(Boolean)
              .join("\n")
          )
        ].join("\n")
      : comment.message;
  return { role: comment.role, message: message.slice(0, 4000) };
}

export async function runMeetingAssistantAgent(input: {
  executionContext: MeetingAssistantExecutionContext;
  transcriptSegments: TranscriptSegment[];
  history: MeetingComment[];
  latestUserMessage: string;
  meetingAnalyzed: boolean;
  hasTranscript: boolean;
}): Promise<
  | { ok: true; result: MeetingAssistantAgentResult; sources: MeetingAssistantSource[] }
  | { ok: false; error: string; details?: string }
> {
  const transcriptExcerpt = input.transcriptSegments.map((segment) => ({
    id: segment.id,
    speaker: getTranscriptSpeakerLabel(segment),
    // A short, human-readable time -- matches the convention already used for transcript
    // segments elsewhere (e.g. Task Workspace evidence), not an invented elapsed-time system.
    timestamp: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
      new Date(segment.timestamp)
    ),
    text: (segment.text ?? "").trim().slice(0, 600)
  }));

  const payload = {
    meeting_analyzed: input.meetingAnalyzed,
    transcript_available: input.hasTranscript,
    execution_context: input.executionContext,
    transcript_excerpt: transcriptExcerpt,
    // Bounded history, same limiting convention as the existing task/commitment chat agents.
    previous_messages: input.history.slice(-20).map(commentToHistoryEntry),
    latest_user_message: input.latestUserMessage
  };

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Respond to the latest message in this meeting conversation with the required JSON.\n\n${JSON.stringify(payload)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_assistant_response",
          strict: true,
          schema: meetingAssistantJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned an empty meeting assistant response." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid meeting assistant JSON.",
        details: raw.slice(0, 500)
      };
    }

    const validated = meetingAssistantResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "OpenAI meeting assistant response did not match the schema.",
        details: validated.error.message
      };
    }

    // Evidence is resolved server-side from segments we actually supplied -- an id the model
    // invented (or one outside this request's excerpt) is silently dropped, never trusted.
    const segmentById = new Map(input.transcriptSegments.map((segment) => [segment.id, segment]));
    const sources: MeetingAssistantSource[] = validated.data.evidenceSegmentIds
      .map((id) => segmentById.get(id))
      .filter((segment): segment is TranscriptSegment => Boolean(segment))
      .map((segment) => ({
        segment_id: segment.id,
        speaker: getTranscriptSpeakerLabel(segment),
        timestamp: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
          new Date(segment.timestamp)
        )
      }));

    return { ok: true, result: validated.data, sources };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to run the meeting assistant.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
