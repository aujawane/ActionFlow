import type {
  MeetingTask,
  MeetingTaskPriority,
  MeetingTaskStatus,
  MeetingTaskType
} from "@/lib/types";

export type AllowedTaskPatch = Partial<
  Pick<
    MeetingTask,
    | "task"
    | "workspace_summary"
    | "owner"
    | "priority"
    | "status"
    | "due_date"
    | "task_type"
    | "suggested_steps"
    | "rationale"
    | "supporting_context"
  >
>;

export type TaskClarificationProposal =
  | {
      kind: "patch";
      patch: AllowedTaskPatch;
      assistantMessage: string;
    }
  | {
      kind: "ambiguous";
      assistantMessage: string;
    }
  | { kind: "none" };

function cleanValue(value: string) {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyMatchedCase(replacement: string, matched: string) {
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(matched) && replacement === replacement.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replaceOccurrences(value: string, from: string, to: string) {
  let changed = false;
  let appliedReplacement = to;
  const next = value.replace(new RegExp(escapeRegExp(from), "gi"), (matched) => {
    changed = true;
    appliedReplacement = applyMatchedCase(to, matched);
    return appliedReplacement;
  });
  return { value: next, changed, appliedReplacement };
}

function parseReplacement(message: string) {
  const patterns = [
    /\binstead of\s+(.+?)\s+(?:it is|use|should be)\s+(.+?)\s*$/i,
    /\bchange\s+(.+?)\s+to\s+(.+?)\s*$/i
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const from = cleanValue(match[1] ?? "");
    const to = cleanValue(match[2] ?? "");
    if (from && to && from.length <= 120 && to.length <= 120) {
      return { from, to };
    }
  }
  return null;
}

function parseName(message: string) {
  const match = message.match(
    /\b(?:assigned to|assignee(?: should be| is)?|owner(?: should be| is)?)\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,3})[.!?]*\s*$/i
  );
  return match?.[1] ? cleanValue(match[1]) : null;
}

function parsePriority(message: string): MeetingTaskPriority | null {
  const match = message.match(/\bpriority\s+(?:should be|is|to)\s+(low|medium|high)\b/i);
  return (match?.[1]?.toLowerCase() as MeetingTaskPriority | undefined) ?? null;
}

function parseStatus(message: string): MeetingTaskStatus | null {
  const match = message.match(
    /\bstatus\s+(?:should be|is|to)\s+(pending|in[ _-]?progress|completed|dismissed)\b/i
  );
  if (!match?.[1]) return null;
  const value = match[1].toLowerCase().replace(/[ -]/g, "_");
  return value as MeetingTaskStatus;
}

function parseTaskType(message: string): MeetingTaskType | null {
  const match = message.match(
    /\btask type\s+(?:should be|is|to)\s+(commitment|implicit[ _-]?commitment|unassigned[ _-]?work)\b/i
  );
  if (!match?.[1]) return null;
  return match[1].toLowerCase().replace(/[ -]/g, "_") as MeetingTaskType;
}

function parseDirectTextField(message: string, field: "title" | "description") {
  const pattern =
    field === "title"
      ? /\b(?:change\s+)?(?:task\s+)?title\s+(?:to|should be|is)\s+(.+?)\s*$/i
      : /\b(?:change\s+)?description\s+(?:to|should be|is)\s+(.+?)\s*$/i;
  const match = message.match(pattern);
  const value = match?.[1] ? cleanValue(match[1]) : null;
  return value && value.length <= 2000 ? value : null;
}

export function proposeTaskPatch(
  task: MeetingTask,
  clarification: string
): TaskClarificationProposal {
  const message = clarification.trim();
  const replacement = parseReplacement(message);
  if (replacement) {
    const titleResult = replaceOccurrences(task.task, replacement.from, replacement.to);
    const descriptionResult = task.workspace_summary
      ? replaceOccurrences(task.workspace_summary, replacement.from, replacement.to)
      : null;
    const patch: AllowedTaskPatch = {};
    if (titleResult.changed) patch.task = titleResult.value;
    if (descriptionResult?.changed) {
      patch.workspace_summary = descriptionResult.value;
    }

    if (Object.keys(patch).length === 0) {
      return {
        kind: "ambiguous",
        assistantMessage: `I saved your clarification, but I could not find “${replacement.from}” in the task title or description. Please confirm which text should change.`
      };
    }

    const appliedReplacement = titleResult.changed
      ? titleResult.appliedReplacement
      : descriptionResult?.appliedReplacement ?? replacement.to;
    return {
      kind: "patch",
      patch,
      assistantMessage: `I updated the task to replace “${replacement.from}” with “${appliedReplacement}”.`
    };
  }

  const patch: AllowedTaskPatch = {};
  const updates: string[] = [];
  const owner = parseName(message);
  if (owner) {
    patch.owner = owner;
    updates.push(`assigned it to ${owner}`);
  }
  const priority = parsePriority(message);
  if (priority) {
    patch.priority = priority;
    updates.push(`set priority to ${priority}`);
  }
  const status = parseStatus(message);
  if (status) {
    patch.status = status;
    updates.push(`set status to ${status.replace("_", " ")}`);
  }
  const taskType = parseTaskType(message);
  if (taskType) {
    patch.task_type = taskType;
    updates.push(`set task type to ${taskType.replaceAll("_", " ")}`);
  }
  const title = parseDirectTextField(message, "title");
  if (title) {
    patch.task = title;
    updates.push("updated the title");
  }
  const description = parseDirectTextField(message, "description");
  if (description) {
    patch.workspace_summary = description;
    updates.push("updated the description");
  }
  const dueDate =
    /\b(?:deadline|due date|due)\b/i.test(message)
      ? message.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1]
      : null;
  if (dueDate) {
    patch.due_date = dueDate;
    updates.push(`set due date to ${dueDate}`);
  }

  if (updates.length > 0) {
    return {
      kind: "patch",
      patch,
      assistantMessage: `I ${updates.join(" and ")}.`
    };
  }

  if (/\b(?:deadline|due date|due)\b/i.test(message)) {
    return {
      kind: "ambiguous",
      assistantMessage:
        "Please provide the due date as a calendar date, for example 2026-07-17."
    };
  }

  if (
    /\b(?:instead|change|correct|wrong|should|assign|priority|status|task type)\b/i.test(
      message
    )
  ) {
    return {
      kind: "ambiguous",
      assistantMessage:
        "I saved this clarification, but I could not determine one safe task change. Please specify the exact task field and value to update."
    };
  }

  return { kind: "none" };
}
