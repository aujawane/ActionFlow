import type {
  MeetingTask,
  MeetingTaskWorkspaceType,
  TaskCategory,
  TaskCategorizationMetadata,
  TaskDeliverableType
} from "@/lib/types";

export const TASK_CATEGORIES: TaskCategory[] = [
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
];

export const TASK_DELIVERABLE_TYPES: TaskDeliverableType[] = [
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
];

const LEGACY_WORKSPACE_TO_CATEGORY: Record<string, TaskCategory> = {
  meeting_follow_up: "follow_up",
  decision: "analysis",
  documentation: "document",
  proposal: "document",
  testing: "coding",
  learning: "research"
};

export const CATEGORY_TO_DELIVERABLE: Record<TaskCategory, TaskDeliverableType> = {
  email: "email_draft",
  research: "research_report",
  website_change: "website_change_prompt",
  design: "design_brief",
  scheduling: "calendar_invite_draft",
  follow_up: "follow_up_message",
  coding: "code_implementation_prompt",
  planning: "action_plan",
  analysis: "analysis_summary",
  document: "document_draft",
  other: "generic_next_steps"
};

export const DELIVERABLE_BUTTON_LABELS: Record<TaskDeliverableType, string> = {
  email_draft: "Draft email",
  research_report: "Create report",
  website_change_prompt: "Create dev prompt",
  design_brief: "Create design brief",
  calendar_invite_draft: "Draft invite",
  follow_up_message: "Draft follow-up",
  code_implementation_prompt: "Create coding prompt",
  action_plan: "Create plan",
  analysis_summary: "Create summary",
  document_draft: "Draft document",
  generic_next_steps: "Do it for me"
};

export const DELIVERABLE_PANEL_TITLES: Record<TaskDeliverableType, string> = {
  email_draft: "Email Draft",
  research_report: "Research Report",
  website_change_prompt: "Developer Prompt",
  design_brief: "Design Brief",
  calendar_invite_draft: "Calendar Invite Draft",
  follow_up_message: "Follow-up Message",
  code_implementation_prompt: "Technical Implementation Prompt",
  action_plan: "Action Plan",
  analysis_summary: "Analysis Summary",
  document_draft: "Document Draft",
  generic_next_steps: "Suggested Next Steps"
};

export const DELIVERABLE_FORMAT_INSTRUCTIONS: Record<TaskDeliverableType, string> = {
  email_draft:
    "Include a subject line and email body. Use placeholders like [Recipient Name] when needed.",
  research_report:
    "Include title, summary, findings, recommendations, and next steps.",
  website_change_prompt:
    "Write a detailed developer/Codex prompt with requirements, files to inspect, UI behavior, edge cases, and acceptance criteria.",
  design_brief:
    "Include goal, current problem, desired UX, design requirements, and success criteria.",
  calendar_invite_draft:
    "Include title, attendee placeholders, time placeholders, agenda, and description.",
  follow_up_message:
    "Write a concise message suitable for Slack, email, or chat.",
  code_implementation_prompt:
    "Write a precise engineering prompt with implementation steps and acceptance criteria.",
  action_plan:
    "Include ordered steps, owner placeholders, priority, and timeline.",
  analysis_summary:
    "Include key observations, risks, recommendations, and next actions.",
  document_draft: "Create a structured document draft.",
  generic_next_steps: "Create useful, ordered next steps."
};

export const CATEGORY_DISPLAY_LABELS: Record<TaskCategory, string> = {
  email: "Email",
  research: "Research",
  website_change: "Website Change",
  design: "Design",
  scheduling: "Scheduling",
  follow_up: "Follow-up",
  coding: "Coding",
  planning: "Planning",
  analysis: "Analysis",
  document: "Document",
  other: "Other"
};

export function normalizeTaskCategory(
  value: string | null | undefined
): TaskCategory {
  const normalized = (value ?? "other").trim().toLowerCase();
  if (TASK_CATEGORIES.includes(normalized as TaskCategory)) {
    return normalized as TaskCategory;
  }
  return LEGACY_WORKSPACE_TO_CATEGORY[normalized] ?? "other";
}

export function normalizeDeliverableType(
  value: string | null | undefined,
  category?: TaskCategory
): TaskDeliverableType {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized &&
    TASK_DELIVERABLE_TYPES.includes(normalized as TaskDeliverableType)
  ) {
    return normalized as TaskDeliverableType;
  }
  return CATEGORY_TO_DELIVERABLE[category ?? "other"];
}

export function workspaceTypeToCategory(
  workspaceType: MeetingTaskWorkspaceType | string | null | undefined
): TaskCategory {
  return normalizeTaskCategory(workspaceType);
}

export function categoryToWorkspaceType(category: TaskCategory): MeetingTaskWorkspaceType {
  return category;
}

export function getDeliverableTypeForCategory(category: TaskCategory): TaskDeliverableType {
  return CATEGORY_TO_DELIVERABLE[category];
}

export function getDeliverableButtonLabel(
  deliverableType: TaskDeliverableType | string | null | undefined
): string {
  const normalized = normalizeDeliverableType(deliverableType);
  return DELIVERABLE_BUTTON_LABELS[normalized];
}

export function getDeliverablePanelTitle(
  deliverableType: TaskDeliverableType | string | null | undefined
): string {
  const normalized = normalizeDeliverableType(deliverableType);
  return DELIVERABLE_PANEL_TITLES[normalized];
}

export function getCategoryDisplayLabel(
  category: TaskCategory | string | null | undefined
): string {
  return CATEGORY_DISPLAY_LABELS[normalizeTaskCategory(category)];
}

export function buildFallbackCategorization(
  reason = "Categorization unavailable; using safe defaults."
): TaskCategorizationMetadata {
  return {
    category: "other",
    deliverable_type: "generic_next_steps",
    confidence: 0,
    reason,
    missing_info: [],
    suggested_button_label: DELIVERABLE_BUTTON_LABELS.generic_next_steps
  };
}

export function parseCategorizationMetadata(
  value: unknown
): TaskCategorizationMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const category = normalizeTaskCategory(
    typeof record.category === "string" ? record.category : null
  );
  const deliverable_type = normalizeDeliverableType(
    typeof record.deliverable_type === "string" ? record.deliverable_type : null,
    category
  );
  const confidence =
    typeof record.confidence === "number" && record.confidence >= 0
      ? Math.min(record.confidence, 1)
      : 0;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const missing_info = Array.isArray(record.missing_info)
    ? record.missing_info.filter((item): item is string => typeof item === "string")
    : [];
  const suggested_button_label =
    typeof record.suggested_button_label === "string" &&
    record.suggested_button_label.trim()
      ? record.suggested_button_label.trim()
      : getDeliverableButtonLabel(deliverable_type);

  if (!reason) return null;

  return {
    category,
    deliverable_type,
    confidence,
    reason,
    missing_info,
    suggested_button_label
  };
}

export function getTaskCategorization(task: MeetingTask): TaskCategorizationMetadata {
  const parsed = parseCategorizationMetadata(task.categorization_metadata);
  if (parsed) return parsed;

  const category = workspaceTypeToCategory(task.workspace_type);
  const deliverable_type = getDeliverableTypeForCategory(category);
  return {
    category,
    deliverable_type,
    confidence: task.confidence ?? 0,
    reason: "Derived from task workspace type.",
    missing_info: [],
    suggested_button_label: getDeliverableButtonLabel(deliverable_type)
  };
}

export function getArtifactTypeLabel(deliverableType: TaskDeliverableType): string {
  return DELIVERABLE_PANEL_TITLES[deliverableType];
}

export function shouldReturnExistingDeliverable(input: {
  regenerate: boolean;
  artifact: { status?: string | null; content?: string | null } | null;
}) {
  if (input.regenerate || !input.artifact) return false;
  return input.artifact.status !== "failed" && Boolean(input.artifact.content?.trim());
}
