import { z } from "zod";

import { getOpenAIModel, openai } from "@/lib/openai";
import {
  buildFallbackCategorization,
  CATEGORY_TO_DELIVERABLE,
  categoryToWorkspaceType,
  getDeliverableButtonLabel,
  normalizeDeliverableType,
  normalizeTaskCategory,
  parseCategorizationMetadata,
  TASK_CATEGORIES,
  TASK_DELIVERABLE_TYPES
} from "@/lib/task-deliverables";
import { getSuggestedSteps } from "@/lib/task-workspace";
import type {
  MeetingTask,
  MeetingTaskWorkspaceType,
  TaskCategorizationMetadata,
  TaskDeliverableType
} from "@/lib/types";

const categorizationResultSchema = z
  .object({
    category: z.enum([
      "email",
      "research",
      "website_change",
      "design",
      "scheduling",
      "follow_up",
      "coding",
      "planning",
      "analysis",
      "document",
      "other"
    ]),
    deliverable_type: z.enum([
      "email_draft",
      "research_report",
      "website_change_prompt",
      "design_brief",
      "calendar_invite_draft",
      "follow_up_message",
      "code_implementation_prompt",
      "action_plan",
      "analysis_summary",
      "document_draft",
      "generic_next_steps"
    ]),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    missing_info: z.array(z.string()),
    suggested_button_label: z.string().min(1)
  })
  .strict();

const batchCategorizationSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          task_id: z.string().uuid(),
          category: categorizationResultSchema.shape.category,
          deliverable_type: categorizationResultSchema.shape.deliverable_type,
          confidence: categorizationResultSchema.shape.confidence,
          reason: categorizationResultSchema.shape.reason,
          missing_info: categorizationResultSchema.shape.missing_info,
          suggested_button_label:
            categorizationResultSchema.shape.suggested_button_label
        })
        .strict()
    )
  })
  .strict();

export type TaskCategorizationResult = z.infer<typeof categorizationResultSchema>;

const categorizationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string", enum: TASK_CATEGORIES },
    deliverable_type: { type: "string", enum: TASK_DELIVERABLE_TYPES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    missing_info: { type: "array", items: { type: "string" } },
    suggested_button_label: { type: "string" }
  },
  required: [
    "category",
    "deliverable_type",
    "confidence",
    "reason",
    "missing_info",
    "suggested_button_label"
  ]
};

const batchCategorizationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          category: { type: "string", enum: TASK_CATEGORIES },
          deliverable_type: { type: "string", enum: TASK_DELIVERABLE_TYPES },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          missing_info: { type: "array", items: { type: "string" } },
          suggested_button_label: { type: "string" }
        },
        required: [
          "task_id",
          "category",
          "deliverable_type",
          "confidence",
          "reason",
          "missing_info",
          "suggested_button_label"
        ]
      }
    }
  },
  required: ["tasks"]
};

function buildCategorizationContext(input: {
  task: Pick<
    MeetingTask,
    "task" | "workspace_summary" | "suggested_steps" | "source_quote" | "owner"
  >;
  meetingContext?: string;
}) {
  const steps = getSuggestedSteps(input.task.suggested_steps);
  return {
    title: input.task.task,
    description: input.task.workspace_summary ?? "",
    owner: input.task.owner ?? "Unassigned",
    source_quote: input.task.source_quote ?? "",
    suggested_next_steps: steps,
    meeting_context: input.meetingContext ?? "No meeting context available."
  };
}

function normalizeCategorizationResult(
  raw: TaskCategorizationResult
): TaskCategorizationMetadata {
  const category = normalizeTaskCategory(raw.category);
  const expectedDeliverable = CATEGORY_TO_DELIVERABLE[category];
  const deliverable_type = normalizeDeliverableType(raw.deliverable_type, category);
  const alignedDeliverable =
    deliverable_type === expectedDeliverable ? deliverable_type : expectedDeliverable;

  return {
    category,
    deliverable_type: alignedDeliverable,
    confidence: raw.confidence,
    reason: raw.reason.trim(),
    missing_info: raw.missing_info.map((item) => item.trim()).filter(Boolean).slice(0, 10),
    suggested_button_label:
      raw.suggested_button_label.trim() ||
      getDeliverableButtonLabel(alignedDeliverable)
  };
}

const SYSTEM_PROMPT = [
  "You classify tasks for a productivity app called Parfait.",
  "Return only valid JSON.",
  "Choose the best category and deliverable type.",
  "",
  "Allowed categories:",
  TASK_CATEGORIES.join(", "),
  "",
  "Allowed deliverable types:",
  TASK_DELIVERABLE_TYPES.join(", "),
  "",
  "Rules:",
  "- If the task asks to contact someone by email, use email/email_draft.",
  "- If the task asks to investigate, compare, or find information, use research/research_report.",
  "- If the task asks to change a website, app UI, dashboard, layout, text, or product behavior, use website_change/website_change_prompt.",
  "- If the task asks to improve visuals, layout, brand, or user experience, use design/design_brief.",
  "- If the task asks to arrange a meeting or event, use scheduling/calendar_invite_draft.",
  "- If the task asks to remind, message, or follow up with someone, use follow_up/follow_up_message.",
  "- If the task asks to build, debug, fix, or implement code, use coding/code_implementation_prompt.",
  "- If the task asks to plan work, create a roadmap, or organize steps, use planning/action_plan.",
  "- If the task asks to review or summarize information, use analysis/analysis_summary.",
  "- If the task asks to write a doc, spec, memo, or proposal, use document/document_draft.",
  "- If uncertain, choose other/generic_next_steps.",
  "- suggested_button_label must match the deliverable type."
].join("\n");

export async function categorizeTaskWithOpenAI(input: {
  task: MeetingTask;
  meetingContext?: string;
}): Promise<
  | { ok: true; result: TaskCategorizationMetadata; workspace_type: MeetingTaskWorkspaceType }
  | { ok: false; error: string; details?: string; fallback: TaskCategorizationMetadata }
> {
  const context = buildCategorizationContext(input);

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Classify this task and return the required JSON.\n\n${JSON.stringify(context)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_categorization",
          strict: true,
          schema: categorizationJsonSchema
        }
      }
    });

    const rawText = response.output_text?.trim();
    if (!rawText) {
      const fallback = buildFallbackCategorization("OpenAI returned empty categorization.");
      return { ok: false, error: "Empty categorization response.", fallback };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const fallback = buildFallbackCategorization("OpenAI returned invalid JSON.");
      return { ok: false, error: "Invalid categorization JSON.", fallback };
    }

    const validated = categorizationResultSchema.safeParse(parsed);
    if (!validated.success) {
      const fallback = buildFallbackCategorization(
        "OpenAI categorization did not match schema."
      );
      return {
        ok: false,
        error: "Categorization schema mismatch.",
        details: validated.error.message,
        fallback
      };
    }

    const result = normalizeCategorizationResult(validated.data);
    return {
      ok: true,
      result,
      workspace_type: categoryToWorkspaceType(result.category)
    };
  } catch (error) {
    const fallback = buildFallbackCategorization("OpenAI categorization failed.");
    return {
      ok: false,
      error: "Failed to categorize task.",
      details: error instanceof Error ? error.message : "Unknown error",
      fallback
    };
  }
}

export async function categorizeTasksBatchWithOpenAI(input: {
  tasks: Array<{
    task: MeetingTask;
    meetingContext?: string;
  }>;
}): Promise<
  | {
      ok: true;
      results: Array<{
        taskId: string;
        metadata: TaskCategorizationMetadata;
        workspace_type: MeetingTaskWorkspaceType;
      }>;
    }
  | { ok: false; error: string; details?: string }
> {
  if (input.tasks.length === 0) {
    return { ok: true, results: [] };
  }

  const payload = {
    tasks: input.tasks.map(({ task, meetingContext }) => ({
      task_id: task.id,
      ...buildCategorizationContext({ task, meetingContext })
    }))
  };

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Classify each task and return JSON with a tasks array. Each item must include task_id plus the categorization fields.\n\n${JSON.stringify(payload)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_categorization_batch",
          strict: true,
          schema: batchCategorizationJsonSchema
        }
      }
    });

    const rawText = response.output_text?.trim();
    if (!rawText) {
      return { ok: false, error: "Empty batch categorization response." };
    }

    const parsed = JSON.parse(rawText) as unknown;
    const validated = batchCategorizationSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Batch categorization schema mismatch.",
        details: validated.error.message
      };
    }

    return {
      ok: true,
      results: validated.data.tasks.map((item) => {
        const metadata = normalizeCategorizationResult(item);
        return {
          taskId: item.task_id,
          metadata,
          workspace_type: categoryToWorkspaceType(metadata.category)
        };
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to batch categorize tasks.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export function buildTaskCategorizationUpdate(metadata: TaskCategorizationMetadata) {
  return {
    workspace_type: categoryToWorkspaceType(metadata.category),
    categorization_metadata: metadata
  };
}

export function getFallbackCategorizationForTask(
  task: MeetingTask,
  reason?: string
): TaskCategorizationMetadata {
  const existing = parseCategorizationMetadata(task.categorization_metadata);
  if (existing) return existing;
  return buildFallbackCategorization(reason);
}

export type { TaskDeliverableType };
