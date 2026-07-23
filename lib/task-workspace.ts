import { z } from "zod";

import { getOpenAIModel, openai } from "@/lib/openai";
import {
  DELIVERABLE_FORMAT_INSTRUCTIONS,
  DELIVERABLE_PANEL_TITLES,
  getDeliverablePanelTitle,
  getTaskCategorization,
  normalizeTaskCategory
} from "@/lib/task-deliverables";
import {
  resolveTaskOwner
} from "@/lib/speaker-aliases";
import { getSegmentIdsFromTopic, loadResolvedMeetingTranscriptSegments } from "@/lib/transcript-segments";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  Meeting,
  MeetingTask,
  MeetingTaskWorkspaceType,
  MeetingTopic,
  TaskGuide,
  TaskPrompt,
  TranscriptSegment
} from "@/lib/types";

export type TaskWorkspaceContext = {
  task: MeetingTask;
  meeting: Meeting;
  topic: MeetingTopic | null;
  segments: TranscriptSegment[];
};

export const taskGuideSchema = z
  .object({
    summary: z.string(),
    objective: z.string(),
    steps: z.array(z.string()),
    recommendedApproach: z.string(),
    resources: z.array(z.string()),
    estimatedEffort: z.string(),
    successCriteria: z.array(z.string())
  })
  .strict();

export const generatedArtifactSchema = z
  .object({
    title: z.string(),
    content: z.string()
  })
  .strict();

export const taskPromptSchema = z
  .object({
    title: z.string(),
    prompt: z.string(),
    promptType: z.string()
  })
  .strict();

export type GeneratedArtifactDraft = z.infer<typeof generatedArtifactSchema>;

export const taskGuideJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    objective: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    recommendedApproach: { type: "string" },
    resources: { type: "array", items: { type: "string" } },
    estimatedEffort: { type: "string" },
    successCriteria: { type: "array", items: { type: "string" } }
  },
  required: [
    "summary",
    "objective",
    "steps",
    "recommendedApproach",
    "resources",
    "estimatedEffort",
    "successCriteria"
  ]
};

export const generatedArtifactJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    content: { type: "string" }
  },
  required: ["title", "content"]
};

export const taskPromptJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    prompt: { type: "string" },
    promptType: { type: "string" }
  },
  required: ["title", "prompt", "promptType"]
};

export const artifactTypeByWorkspaceType: Record<MeetingTaskWorkspaceType, string> = {
  research: DELIVERABLE_PANEL_TITLES.research_report,
  email: DELIVERABLE_PANEL_TITLES.email_draft,
  proposal: DELIVERABLE_PANEL_TITLES.document_draft,
  coding: DELIVERABLE_PANEL_TITLES.code_implementation_prompt,
  documentation: DELIVERABLE_PANEL_TITLES.document_draft,
  design: DELIVERABLE_PANEL_TITLES.design_brief,
  meeting_follow_up: DELIVERABLE_PANEL_TITLES.follow_up_message,
  planning: DELIVERABLE_PANEL_TITLES.action_plan,
  testing: DELIVERABLE_PANEL_TITLES.code_implementation_prompt,
  decision: DELIVERABLE_PANEL_TITLES.analysis_summary,
  learning: DELIVERABLE_PANEL_TITLES.research_report,
  website_change: DELIVERABLE_PANEL_TITLES.website_change_prompt,
  scheduling: DELIVERABLE_PANEL_TITLES.calendar_invite_draft,
  follow_up: DELIVERABLE_PANEL_TITLES.follow_up_message,
  analysis: DELIVERABLE_PANEL_TITLES.analysis_summary,
  document: DELIVERABLE_PANEL_TITLES.document_draft,
  other: DELIVERABLE_PANEL_TITLES.generic_next_steps
};

export const promptLabelByWorkspaceType: Partial<Record<MeetingTaskWorkspaceType, string>> = {
  coding: "Generate Implementation Prompt",
  documentation: "Generate Documentation Prompt",
  design: "Generate Design Prompt",
  testing: "Generate Test Prompt",
  planning: "Generate Planning Prompt",
  research: "Generate Research Prompt"
};

function getSegmentIds(topic: MeetingTopic | null) {
  return getSegmentIdsFromTopic(topic?.segment_ids);
}

export function normalizeWorkspaceType(
  workspaceType: string | null | undefined
): MeetingTaskWorkspaceType {
  const normalized = normalizeTaskCategory(workspaceType);
  return normalized as MeetingTaskWorkspaceType;
}

export function getArtifactTypeForTask(task: Pick<MeetingTask, "workspace_type">) {
  return artifactTypeByWorkspaceType[normalizeWorkspaceType(task.workspace_type)];
}

export function getPromptLabelForWorkspaceType(
  workspaceType: MeetingTaskWorkspaceType | string | null | undefined
) {
  return promptLabelByWorkspaceType[normalizeWorkspaceType(workspaceType)];
}

export function supportsTaskPrompt(
  workspaceType: MeetingTaskWorkspaceType | string | null | undefined
) {
  return Boolean(getPromptLabelForWorkspaceType(workspaceType));
}

export function getSuggestedSteps(value: MeetingTask["suggested_steps"]) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<string[]>((steps, step) => {
    if (typeof step === "string" && step.trim().length > 0) {
      steps.push(step.trim());
    }
    return steps;
  }, []);
}

export async function getTaskWorkspaceContext(
  taskId: string,
  userId: string
): Promise<
  | { ok: true; context: TaskWorkspaceContext }
  | { ok: false; status: number; error: string; details?: string }
> {
  const { data: task, error: taskError } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (taskError || !task) {
    return {
      ok: false,
      status: 404,
      error: "Task not found",
      details: taskError?.message
    };
  }

  const typedTask = task as MeetingTask;

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", typedTask.meeting_id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return {
      ok: false,
      status: 404,
      error: "Task not found",
      details: meetingError?.message
    };
  }

  const { data: topic } = typedTask.topic_id
    ? await supabaseAdmin
        .from("meeting_topics")
        .select("*")
        .eq("id", typedTask.topic_id)
        .eq("meeting_id", typedTask.meeting_id)
        .maybeSingle()
    : { data: null };

  const typedTopic = (topic as MeetingTopic | null) ?? null;
  const {
    segments,
    aliases,
    segmentsError,
    aliasesError
  } = await loadResolvedMeetingTranscriptSegments({
    meetingId: typedTask.meeting_id,
    segmentIds: getSegmentIds(typedTopic),
    limit: 12
  });

  if (segmentsError) {
    return {
      ok: false,
      status: 500,
      error: "Failed to load transcript context",
      details: segmentsError.message
    };
  }

  if (aliasesError) {
    return {
      ok: false,
      status: 500,
      error: "Failed to load speaker aliases",
      details: aliasesError.message
    };
  }

  const typedAliases = aliases;
  return {
    ok: true,
    context: {
      task: {
        ...typedTask,
        owner: resolveTaskOwner(typedTask.owner, typedAliases)
      },
      meeting: meeting as Meeting,
      topic: typedTopic,
      segments
    }
  };
}

export function buildTaskContextPrompt(context: TaskWorkspaceContext) {
  const suggestedSteps = getSuggestedSteps(context.task.suggested_steps);
  const transcript = context.segments
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "Unknown speaker";
      const text = segment.text.trim().replace(/\s+/g, " ");
      return `${speaker}: ${text}`;
    })
    .join("\n");

  return [
    `Task: ${context.task.task}`,
    `Owner: ${context.task.owner || "Unassigned"}`,
    `Task type: ${context.task.task_type}`,
    `Priority: ${context.task.priority}`,
    `Status: ${context.task.status}`,
    `Workspace type: ${normalizeWorkspaceType(context.task.workspace_type)}`,
    context.task.workspace_summary
      ? `Workspace summary: ${context.task.workspace_summary}`
      : null,
    context.task.source_quote ? `Source quote: ${context.task.source_quote}` : null,
    suggestedSteps.length > 0
      ? `Suggested steps:\n${suggestedSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
      : "Suggested steps: None provided",
    "",
    `Meeting: ${context.meeting.title || "Untitled meeting"}`,
    `Meeting URL: ${context.meeting.meeting_url}`,
    context.topic ? `Topic: ${context.topic.title}` : "Topic: Not available",
    context.topic?.summary ? `Topic summary: ${context.topic.summary}` : null,
    context.topic?.separation_reason
      ? `Topic separation reason: ${context.topic.separation_reason}`
      : null,
    "",
    "Transcript context:",
    transcript || "No transcript context available."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateTaskGuide(
  context: TaskWorkspaceContext
): Promise<
  | { ok: true; guide: TaskGuide }
  | { ok: false; error: string; details?: string }
> {
  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        {
          role: "system",
          content:
            "You are Parfait, an AI execution assistant. Your job is to help the user understand and complete work extracted from meetings. Be specific, practical, and grounded in the provided task and meeting context."
        },
        {
          role: "user",
          content: `Create a task-specific guide tailored to the workspace type.\n\n${buildTaskContextPrompt(
            context
          )}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_execution_guide",
          strict: true,
          schema: taskGuideJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) return { ok: false, error: "OpenAI returned empty guide output." };

    const parsed = JSON.parse(raw) as unknown;
    const validated = taskGuideSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Guide output did not match expected schema.",
        details: validated.error.message
      };
    }

    return { ok: true, guide: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to generate task guide.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export async function generateTaskDeliverableDraft(
  context: TaskWorkspaceContext
): Promise<
  | { ok: true; artifact: GeneratedArtifactDraft }
  | { ok: false; error: string; details?: string }
> {
  const categorization = getTaskCategorization(context.task);
  const deliverableType = categorization.deliverable_type;
  const panelTitle = getDeliverablePanelTitle(deliverableType);
  const formatInstructions = DELIVERABLE_FORMAT_INSTRUCTIONS[deliverableType];

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        {
          role: "system",
          content: [
            "You are Parfait, an AI task execution assistant.",
            "Generate the best possible deliverable for the task.",
            "Generate a practical, usable deliverable.",
            "If information is missing, use clear placeholders like [Recipient Name], [Date], or [Your Name].",
            "Do not say you cannot complete the task unless absolutely necessary.",
            "Do not include unnecessary explanation before the deliverable.",
            "Match the deliverable format to the deliverable type.",
            formatInstructions
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Task title: ${context.task.task}`,
            `Task description: ${context.task.workspace_summary ?? "Not provided."}`,
            `Category: ${categorization.category}`,
            `Deliverable type: ${deliverableType}`,
            "",
            buildTaskContextPrompt(context)
          ].join("\n")
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_deliverable_draft",
          strict: true,
          schema: generatedArtifactJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) return { ok: false, error: "OpenAI returned empty deliverable output." };

    const parsed = JSON.parse(raw) as unknown;
    const validated = generatedArtifactSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Deliverable output did not match expected schema.",
        details: validated.error.message
      };
    }

    return {
      ok: true,
      artifact: {
        title: validated.data.title || panelTitle,
        content: validated.data.content
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to generate task deliverable.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export async function generateTaskArtifactDraft(
  context: TaskWorkspaceContext
): Promise<
  | { ok: true; artifact: GeneratedArtifactDraft }
  | { ok: false; error: string; details?: string }
> {
  return generateTaskDeliverableDraft(context);
}

export async function generateTaskPrompt(
  context: TaskWorkspaceContext
): Promise<
  | { ok: true; taskPrompt: TaskPrompt }
  | { ok: false; error: string; details?: string }
> {
  const workspaceType = normalizeWorkspaceType(context.task.workspace_type);
  const promptLabel = getPromptLabelForWorkspaceType(workspaceType);

  if (!promptLabel) {
    return {
      ok: false,
      error: "Prompt generation is not available for this task workspace type."
    };
  }

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        {
          role: "system",
          content:
            "You are Parfait, an AI execution assistant. Your job is to create task-specific prompts that help the user complete work extracted from meetings. Be concrete, grounded in the task context, and include only details supported by the task, meeting topic, source quote, suggested steps, and transcript context."
        },
        {
          role: "user",
          content: `Create a ${promptLabel.toLowerCase()} for this ${workspaceType} task. The prompt should be ready to paste into an AI coding, research, documentation, design, testing, or planning tool as appropriate. Include explicit context, goals, constraints, acceptance criteria, and instructions to mark assumptions clearly.\n\n${buildTaskContextPrompt(
            context
          )}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_execution_prompt",
          strict: true,
          schema: taskPromptJsonSchema
        }
      }
    });

    const raw = response.output_text?.trim();
    if (!raw) return { ok: false, error: "OpenAI returned empty prompt output." };

    const parsed = JSON.parse(raw) as unknown;
    const validated = taskPromptSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Prompt output did not match expected schema.",
        details: validated.error.message
      };
    }

    return { ok: true, taskPrompt: validated.data };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to generate task prompt.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
