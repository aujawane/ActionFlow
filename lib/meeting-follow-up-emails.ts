import { z } from "zod";

import { OPENAI_MODEL, openai } from "@/lib/openai";
import type { MeetingTask } from "@/lib/types";

export const FOLLOW_UP_EMAIL_SYSTEM_PROMPT = `You are Parfait, an AI meeting follow-up assistant.

Generate polished follow-up email drafts from meeting tasks.

Return only valid JSON matching the requested schema.

Rules:
- Do not invent tasks.
- Use only the tasks provided.
- If a task has an assignee, put it under that person.
- If a task is unassigned and generating a team summary, include it under Unassigned.
- For individual emails, include only tasks assigned to that recipient.
- If recipient email is missing, use null.
- Keep emails professional, friendly, and concise.
- Include clear bullet points for action items.
- Include due dates when available.
- Include suggested next steps when useful, but do not make the email too long.
- Use placeholders like [Your Name] when sender information is unknown.
- Do not send emails. Generate drafts only.`;

const generatedIndividualEmailSchema = z
  .object({
    recipient_name: z.string().min(1),
    recipient_email: z.string().nullable(),
    subject: z.string().min(1),
    body: z.string().min(1),
    task_ids: z.array(z.string())
  })
  .strict();

const generatedIndividualEmailsSchema = z
  .object({ emails: z.array(generatedIndividualEmailSchema) })
  .strict();

const generatedTeamEmailSchema = z
  .object({
    email: z
      .object({
        subject: z.string().min(1),
        body: z.string().min(1),
        included_task_ids: z.array(z.string())
      })
      .strict()
  })
  .strict();

const individualEmailsJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          recipient_name: { type: "string" },
          recipient_email: { type: ["string", "null"] },
          subject: { type: "string" },
          body: { type: "string" },
          task_ids: { type: "array", items: { type: "string" } }
        },
        required: [
          "recipient_name",
          "recipient_email",
          "subject",
          "body",
          "task_ids"
        ]
      }
    }
  },
  required: ["emails"]
};

const teamEmailJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: {
      type: "object",
      additionalProperties: false,
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
        included_task_ids: { type: "array", items: { type: "string" } }
      },
      required: ["subject", "body", "included_task_ids"]
    }
  },
  required: ["email"]
};

export type FollowUpTask = {
  id: string;
  title: string;
  assignee: string | null;
  due_date: string | null;
  description: string | null;
  context: string | null;
  suggested_next_steps: string[];
};

export type FollowUpParticipant = {
  name: string;
  email: string | null;
};

function normalizeAssignee(owner: string | null | undefined) {
  const ownerName = owner?.trim();
  if (!ownerName || ownerName.toLowerCase() === "unassigned") return null;
  return ownerName;
}

function suggestedSteps(task: MeetingTask) {
  if (!Array.isArray(task.suggested_steps)) return [];
  return task.suggested_steps.reduce<string[]>((steps, step) => {
    if (typeof step === "string" && step.trim()) steps.push(step.trim());
    return steps;
  }, []);
}

export function toFollowUpTasks(tasks: MeetingTask[]): FollowUpTask[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.task,
    assignee: normalizeAssignee(task.owner),
    due_date: task.due_date ?? null,
    description: task.workspace_summary ?? null,
    context: task.supporting_context ?? task.source_quote ?? null,
    suggested_next_steps: suggestedSteps(task)
  }));
}

export function groupTasksByAssignee(tasks: FollowUpTask[]) {
  const groups = new Map<string, FollowUpTask[]>();
  for (const task of tasks) {
    if (!task.assignee) continue;
    const key = task.assignee.toLocaleLowerCase();
    const existing = groups.get(key);
    if (existing) existing.push(task);
    else groups.set(key, [task]);
  }
  return Array.from(groups.values())
    .map((group) => ({ assignee: group[0].assignee!, tasks: group }))
    .sort((a, b) => a.assignee.localeCompare(b.assignee));
}

type GenerationContext = {
  meetingTitle: string;
  meetingDate: string | null;
  participants: FollowUpParticipant[];
  meetingContext: string;
};

function individualUserPrompt(
  context: GenerationContext,
  groups: ReturnType<typeof groupTasksByAssignee>
) {
  return `Generate individual follow-up emails for this meeting.

Meeting:
${context.meetingTitle}

Date:
${context.meetingDate ?? "Not available"}

Participants:
${JSON.stringify(context.participants)}

Tasks grouped by assignee:
${JSON.stringify(groups)}

Meeting context or summary:
${context.meetingContext || "Not available"}

Return JSON with:
{
  "emails": [{
    "recipient_name": string,
    "recipient_email": string | null,
    "subject": string,
    "body": string,
    "task_ids": string[]
  }]
}`;
}

function teamUserPrompt(context: GenerationContext, tasks: FollowUpTask[]) {
  return `Generate one team follow-up email for this meeting.

Meeting:
${context.meetingTitle}

Date:
${context.meetingDate ?? "Not available"}

Participants:
${JSON.stringify(context.participants)}

All tasks:
${JSON.stringify(tasks)}

Meeting context or summary:
${context.meetingContext || "Not available"}

Return JSON with:
{
  "email": {
    "subject": string,
    "body": string,
    "included_task_ids": string[]
  }
}`;
}

export async function generateIndividualFollowUpDrafts(
  context: GenerationContext & { tasks: FollowUpTask[] }
) {
  const groups = groupTasksByAssignee(context.tasks);
  if (groups.length === 0) {
    return {
      ok: false as const,
      error:
        "Individual emails require assigned tasks. Use Team summary email instead or assign tasks first."
    };
  }

  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: FOLLOW_UP_EMAIL_SYSTEM_PROMPT },
        { role: "user", content: individualUserPrompt(context, groups) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_individual_follow_up_emails",
          strict: true,
          schema: individualEmailsJsonSchema
        }
      }
    });

    const parsed = generatedIndividualEmailsSchema.safeParse(
      JSON.parse(response.output_text?.trim() || "null")
    );
    if (!parsed.success) {
      return {
        ok: false as const,
        error: "Follow-up email output did not match the expected schema.",
        details: parsed.error.message
      };
    }

    const generatedByRecipient = new Map(
      parsed.data.emails.map((email) => [email.recipient_name.toLowerCase(), email])
    );
    const emails = groups.map((group) => {
      const generated = generatedByRecipient.get(group.assignee.toLowerCase());
      if (!generated) throw new Error(`OpenAI omitted ${group.assignee}'s email.`);
      return {
        ...generated,
        recipient_name: group.assignee,
        recipient_email: null,
        task_ids: group.tasks.map((task) => task.id)
      };
    });

    return { ok: true as const, emails };
  } catch (error) {
    return {
      ok: false as const,
      error: "Failed to generate individual follow-up emails.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export async function generateTeamFollowUpDraft(
  context: GenerationContext & { tasks: FollowUpTask[] }
) {
  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: FOLLOW_UP_EMAIL_SYSTEM_PROMPT },
        { role: "user", content: teamUserPrompt(context, context.tasks) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_team_follow_up_email",
          strict: true,
          schema: teamEmailJsonSchema
        }
      }
    });

    const parsed = generatedTeamEmailSchema.safeParse(
      JSON.parse(response.output_text?.trim() || "null")
    );
    if (!parsed.success) {
      return {
        ok: false as const,
        error: "Follow-up email output did not match the expected schema.",
        details: parsed.error.message
      };
    }

    return {
      ok: true as const,
      email: {
        ...parsed.data.email,
        included_task_ids: context.tasks.map((task) => task.id)
      }
    };
  } catch (error) {
    return {
      ok: false as const,
      error: "Failed to generate the team follow-up email.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
