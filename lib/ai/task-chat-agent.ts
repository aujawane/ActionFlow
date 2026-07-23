import { z } from "zod";

import { getOpenAIModel, openai } from "@/lib/openai";
import type { Meeting, MeetingTask, TaskComment } from "@/lib/types";

const agentPatchSchema = z
  .object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    owner: z.string().nullable(),
    assignee: z.string().nullable(),
    priority: z.enum(["low", "medium", "high"]).nullable(),
    status: z
      .enum(["pending", "in_progress", "completed", "dismissed"])
      .nullable(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    task_type: z
      .enum(["commitment", "implicit_commitment", "unassigned_work"])
      .nullable(),
    suggested_next_steps: z.union([z.array(z.string()), z.string()]).nullable(),
    rationale: z.string().nullable(),
    supporting_context: z.string().nullable()
  })
  .strict();

const taskChatAgentSchema = z
  .object({
    assistantMessage: z.string().min(1),
    intent: z.enum([
      "answer",
      "propose_update",
      "apply_update",
      "ask_confirmation"
    ]),
    shouldUpdateTask: z.boolean(),
    taskPatch: agentPatchSchema,
    requiresConfirmation: z.boolean(),
    pendingPatch: agentPatchSchema.nullable(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export type TaskChatAgentResult = z.infer<typeof taskChatAgentSchema>;

const agentPatchJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    owner: { type: ["string", "null"] },
    assignee: { type: ["string", "null"] },
    priority: {
      type: ["string", "null"],
      enum: ["low", "medium", "high", null]
    },
    status: {
      type: ["string", "null"],
      enum: ["pending", "in_progress", "completed", "dismissed", null]
    },
    due_date: {
      type: ["string", "null"],
      pattern: "^\\d{4}-\\d{2}-\\d{2}$"
    },
    task_type: {
      type: ["string", "null"],
      enum: ["commitment", "implicit_commitment", "unassigned_work", null]
    },
    suggested_next_steps: {
      anyOf: [
        { type: "array", items: { type: "string" }, maxItems: 20 },
        { type: "string" },
        { type: "null" }
      ]
    },
    rationale: { type: ["string", "null"] },
    supporting_context: { type: ["string", "null"] }
  },
  required: [
    "title",
    "description",
    "owner",
    "assignee",
    "priority",
    "status",
    "due_date",
    "task_type",
    "suggested_next_steps",
    "rationale",
    "supporting_context"
  ]
};

const taskChatAgentJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantMessage: { type: "string" },
    intent: {
      type: "string",
      enum: ["answer", "propose_update", "apply_update", "ask_confirmation"]
    },
    shouldUpdateTask: { type: "boolean" },
    taskPatch: agentPatchJsonSchema,
    requiresConfirmation: { type: "boolean" },
    pendingPatch: {
      anyOf: [agentPatchJsonSchema, { type: "null" }]
    },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: [
    "assistantMessage",
    "intent",
    "shouldUpdateTask",
    "taskPatch",
    "requiresConfirmation",
    "pendingPatch",
    "confidence"
  ]
};

export async function runTaskChatAgent(input: {
  task: MeetingTask;
  meeting: Meeting;
  comments: TaskComment[];
  transcriptSnippets: string[];
  latestUserMessage: string;
}): Promise<
  | { ok: true; result: TaskChatAgentResult }
  | { ok: false; error: string; details?: string }
> {
  const systemPrompt = [
    "You are a task assistant inside Parfait.",
    "You help clarify and improve exactly one task extracted from a meeting.",
    "Use only the task, meeting, comment history, and transcript context provided.",
    "Never invent details not supported by that context.",
    "If the user asks a question, use intent='answer', answer it, and set shouldUpdateTask=false.",
    "If the user clearly corrects a name or term, update both title and description wherever appropriate.",
    "For phrases like 'instead of X it is Y', replace X with Y wherever it occurs.",
    "Use intent='apply_update' only for explicit, unambiguous edits supplied by the user.",
    "If you author new content, such as suggested next steps the user did not dictate, use intent='propose_update', requiresConfirmation=true, and put the exact proposal in both taskPatch and pendingPatch.",
    "If uncertain, use intent='ask_confirmation', requiresConfirmation=true, and do not claim the task changed.",
    "Set shouldUpdateTask=true only for intent='apply_update'.",
    "Only populate fields supported by the request and context.",
    "Never say that a field was updated; the server will report updates after database verification.",
    "Return valid JSON matching the schema and no other text.",
    "Every patch key is required by the schema; use null for unchanged fields and pendingPatch=null when there is no proposal.",
    "Use owner='Unassigned' when the user clearly asks to remove assignment.",
    "owner and assignee are aliases; populate at most one of them.",
    "suggested_next_steps may be a string array or text, but prefer a concise string array.",
    "When updating due_date, return an ISO calendar date in YYYY-MM-DD format."
  ].join("\n");

  const context = {
    task: {
      title: input.task.task,
      description: input.task.workspace_summary,
      owner: input.task.owner,
      priority: input.task.priority,
      status: input.task.status,
      due_date: input.task.due_date,
      task_type: input.task.task_type,
      source_quote: input.task.source_quote,
      suggested_steps: input.task.suggested_steps,
      rationale: input.task.rationale,
      supporting_context: input.task.supporting_context
    },
    meeting: {
      title: input.meeting.title,
      platform: input.meeting.platform,
      status: input.meeting.status
    },
    previousComments: input.comments.slice(-20).map((comment) => ({
      role: comment.role,
      message: comment.message.slice(0, 2000),
      proposalStatus: comment.metadata?.proposal?.status
    })),
    transcriptSnippets: input.transcriptSnippets.slice(0, 12),
    latestUserMessage: input.latestUserMessage
  };

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Review this task conversation and respond with the required JSON.\n\n${JSON.stringify(
            context
          )}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_chat_agent_response",
          strict: true,
          schema: taskChatAgentJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned an empty task chat response." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned invalid task chat JSON.",
        details: raw.slice(0, 500)
      };
    }

    const validated = taskChatAgentSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "OpenAI task chat response did not match the schema.",
        details: validated.error.message
      };
    }

    return { ok: true, result: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to run the OpenAI task chat agent.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
