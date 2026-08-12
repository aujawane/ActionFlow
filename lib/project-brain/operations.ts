import {
  projectChangeOperationSchema,
  type ProjectChangeOperation
} from "./schemas";

export const MILESTONE_OPERATION_TYPES = new Set<ProjectChangeOperation["type"]>([
  "create_milestone",
  "update_milestone",
  "rename_milestone",
  "merge_milestones",
  "archive_milestone",
  "defer_milestone"
]);

export type ProjectBrainOperationGroup =
  | "Project Context"
  | "Commitments"
  | "Tasks"
  | "People"
  | "Requirements and Decisions"
  | "Dependencies";

export function operationGroup(
  operation: ProjectChangeOperation
): ProjectBrainOperationGroup {
  if (
    operation.type === "update_project" ||
    operation.type === "update_project_memory"
  ) {
    return "Project Context";
  }
  if (MILESTONE_OPERATION_TYPES.has(operation.type)) return "Commitments";
  if (
    operation.type === "create_task" ||
    operation.type === "update_task" ||
    operation.type === "move_task" ||
    operation.type === "merge_tasks" ||
    operation.type === "archive_task" ||
    operation.type === "update_task_status" ||
    operation.type === "assign_task_owner"
  ) {
    return "Tasks";
  }
  if (operation.type === "add_project_participant") return "People";
  if (
    operation.type === "add_requirement" ||
    operation.type === "update_requirement" ||
    operation.type === "add_decision" ||
    operation.type === "supersede_decision" ||
    operation.type === "add_constraint" ||
    operation.type === "remove_constraint"
  ) {
    return "Requirements and Decisions";
  }
  return "Dependencies";
}

export function requiresMilestonePlanning(message: string) {
  return /\b(reorganize|restructure|consolidate|merge|rename)\b.{0,40}\b(milestones?|project|plan)\b|\b(change|clarify|update|reduce|expand)\b.{0,40}\b(mvp|scope|phase|release)\b|\b(informational|static)\b.{0,30}\b(website|site|mvp)\b|\b(move|defer|later|future)\b.{0,40}\b(feature|scope|phase|e-?commerce|authentication|payments?|subscriptions?|ordering)\b/i.test(
    message
  );
}

export function proposalCompletenessWarnings(input: {
  message: string;
  operations: ProjectChangeOperation[];
}) {
  if (
    requiresMilestonePlanning(input.message) &&
    !input.operations.some((operation) =>
      MILESTONE_OPERATION_TYPES.has(operation.type)
    )
  ) {
    return [
      "Scope changed substantially, but no milestone operations were generated."
    ];
  }
  return [];
}

export function normalizeOperationsForApply(
  operations: ProjectChangeOperation[]
): ProjectChangeOperation[] {
  return operations.map((operation) => {
    if (operation.type === "rename_milestone") {
      return {
        type: "update_milestone",
        milestoneId: operation.milestoneId,
        changes: { title: operation.title },
        explanation: operation.explanation,
        evidence: operation.evidence,
        warning: operation.warning
      };
    }
    if (operation.type === "defer_milestone") {
      return {
        type: "archive_milestone",
        milestoneId: operation.milestoneId,
        reason: operation.reason,
        explanation: operation.explanation,
        evidence: operation.evidence,
        warning: operation.warning
      };
    }
    return operation;
  });
}

export type ProposalTargetValidation =
  | { ok: true }
  | { ok: false; reason: "stale_execution_target" | "outside_project"; message: string };

/**
 * Every operation that targets an existing milestone/task must reference a row that is actually
 * in the caller's current-generation context (ProjectBrainContext.milestones/tasks -- see
 * lib/project-brain/context.ts). A target id missing from that context is either (a) a row that
 * belongs to a superseded analysis generation -- context.ts excludes it deliberately and tracks it
 * in staleMilestoneIds/staleTaskIds precisely so this check can name it -- or (b) genuinely outside
 * the project. Never silently retarget a stale proposal to a different row; reject with a
 * diagnostic the caller can act on instead.
 */
export function validateProposalTargets(
  operations: unknown[],
  context: {
    milestones: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    staleMilestoneIds: Set<string>;
    staleTaskIds: Set<string>;
  }
): ProposalTargetValidation {
  const milestoneIds = new Set(context.milestones.map((item) => String(item.id)));
  const taskIds = new Set(context.tasks.map((item) => String(item.id)));
  for (const operation of operations) {
    const candidate = operation as Record<string, unknown>;
    for (const key of ["milestoneId", "targetMilestoneId"]) {
      const value = candidate[key];
      if (typeof value !== "string" || milestoneIds.has(value)) continue;
      if (context.staleMilestoneIds.has(value)) {
        return {
          ok: false,
          reason: "stale_execution_target",
          message: "This proposal references a milestone from a superseded analysis generation."
        };
      }
      return {
        ok: false,
        reason: "outside_project",
        message: "Proposal references a milestone outside this project."
      };
    }
    for (const key of ["taskId", "dependsOnTaskId", "survivorTaskId"]) {
      const value = candidate[key];
      if (typeof value !== "string" || taskIds.has(value)) continue;
      if (context.staleTaskIds.has(value)) {
        return {
          ok: false,
          reason: "stale_execution_target",
          message: "This proposal references a task from a superseded analysis generation."
        };
      }
      return {
        ok: false,
        reason: "outside_project",
        message: "Proposal references a task outside this project."
      };
    }
  }
  return { ok: true };
}

export function validateOperationsIndividually(values: unknown[]) {
  const operations: ProjectChangeOperation[] = [];
  const rejected: Array<{ index: number; type: string | null; reason: string }> =
    [];
  values.forEach((value, index) => {
    const parsed = projectChangeOperationSchema.safeParse(value);
    if (parsed.success) {
      operations.push(parsed.data);
      return;
    }
    const type =
      value && typeof value === "object" && !Array.isArray(value)
        ? String((value as { type?: unknown }).type ?? "") || null
        : null;
    rejected.push({
      index,
      type,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
    });
  });
  return { operations, rejected };
}
