import type { AllowedTaskPatch } from "@/lib/task-clarification-patches";
import type {
  MeetingTaskPriority,
  MeetingTaskStatus,
  MeetingTaskType
} from "@/lib/types";

export type TaskChatPatchCandidate = {
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  assignee?: string | null;
  priority?: MeetingTaskPriority | null;
  status?: MeetingTaskStatus | null;
  due_date?: string | null;
  task_type?: MeetingTaskType | null;
  suggested_next_steps?: string[] | string | null;
  rationale?: string | null;
  supporting_context?: string | null;
  [key: string]: unknown;
};

function cleanPatchString(value: string | null | undefined) {
  return value?.trim() || null;
}

export function normalizeSuggestedSteps(value: unknown): string[] | null {
  if (typeof value !== "string" && !Array.isArray(value)) return null;
  const values = Array.isArray(value) ? value : value.split(/\r?\n|;/);
  const steps = values
    .filter((step): step is string => typeof step === "string")
    .map((step) =>
      step
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s*/, "")
        .trim()
        .slice(0, 500)
    )
    .filter(Boolean)
    .slice(0, 20);
  return steps.length > 0 ? steps : null;
}

export function getTaskChatPatchConflict(candidate: TaskChatPatchCandidate) {
  const owner = cleanPatchString(candidate.owner);
  const assignee = cleanPatchString(candidate.assignee);
  if (owner && assignee && owner.toLowerCase() !== assignee.toLowerCase()) {
    return "owner and assignee contain different values";
  }
  return null;
}

export function sanitizeTaskChatPatch(
  candidate: TaskChatPatchCandidate
): AllowedTaskPatch {
  const patch: AllowedTaskPatch = {};
  const title = cleanPatchString(candidate.title);
  const description = cleanPatchString(candidate.description);
  const owner =
    cleanPatchString(candidate.owner) ?? cleanPatchString(candidate.assignee);
  const dueDate = cleanPatchString(candidate.due_date);
  const suggestedSteps = normalizeSuggestedSteps(candidate.suggested_next_steps);
  const rationale = cleanPatchString(candidate.rationale);
  const supportingContext = cleanPatchString(candidate.supporting_context);

  if (title) patch.task = title;
  if (description) patch.workspace_summary = description;
  if (owner) patch.owner = /^unassigned$/i.test(owner) ? null : owner;
  if (candidate.priority) patch.priority = candidate.priority;
  if (candidate.status) patch.status = candidate.status;
  if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) patch.due_date = dueDate;
  if (candidate.task_type) patch.task_type = candidate.task_type;
  if (suggestedSteps) patch.suggested_steps = suggestedSteps;
  if (rationale) patch.rationale = rationale;
  if (supportingContext) patch.supporting_context = supportingContext;

  // Unknown keys are deliberately excluded from the database patch.
  return patch;
}

export function canApplyTaskChatPatch(input: {
  shouldUpdateTask: boolean;
  confidence: number;
  patch: AllowedTaskPatch;
}) {
  return (
    input.shouldUpdateTask &&
    input.confidence >= 0.75 &&
    Object.keys(input.patch).length > 0
  );
}
