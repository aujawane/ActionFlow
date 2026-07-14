import { z } from "zod";

import type { AllowedTaskPatch } from "@/lib/task-clarification-patches";
import type {
  MeetingTask,
  TaskComment,
  TaskCommentMetadata
} from "@/lib/types";

const storedPatchSchema = z
  .object({
    task: z.string().min(1).optional(),
    workspace_summary: z.string().min(1).optional(),
    owner: z.string().min(1).nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    status: z
      .enum(["pending", "in_progress", "completed", "dismissed"])
      .optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    task_type: z
      .enum(["commitment", "implicit_commitment", "unassigned_work"])
      .optional(),
    suggested_steps: z.array(z.string().min(1)).min(1).max(20).optional(),
    rationale: z.string().min(1).optional(),
    supporting_context: z.string().min(1).optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

const metadataSchema = z
  .object({
    proposal: z
      .object({
        id: z.string().uuid(),
        patch: storedPatchSchema,
        confidence: z.number().min(0).max(1),
        status: z.enum(["pending", "applied", "superseded"]),
        source: z.enum(["agent", "fallback"])
      })
      .optional()
  })
  .strict();

export type StoredTaskProposal = NonNullable<
  z.infer<typeof metadataSchema>["proposal"]
>;

export function parseTaskCommentMetadata(value: unknown): TaskCommentMetadata {
  const parsed = metadataSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as TaskCommentMetadata)
    : {};
}

export function createPendingProposalMetadata(input: {
  patch: AllowedTaskPatch;
  confidence: number;
  source: "agent" | "fallback";
}): TaskCommentMetadata {
  const patch = storedPatchSchema.parse(input.patch);
  return {
    proposal: {
      id: crypto.randomUUID(),
      patch,
      confidence: input.confidence,
      status: "pending",
      source: input.source
    }
  } as TaskCommentMetadata;
}

export function findLatestPendingProposal(comments: TaskComment[]) {
  for (const comment of [...comments].reverse()) {
    if (comment.role !== "assistant" && comment.role !== "system") continue;
    const metadata = parseTaskCommentMetadata(comment.metadata);
    if (metadata.proposal?.status === "pending") {
      return {
        commentId: comment.id,
        proposal: metadata.proposal as StoredTaskProposal
      };
    }
  }
  return null;
}

export function updateProposalStatus(
  metadata: unknown,
  status: "applied" | "superseded"
): TaskCommentMetadata {
  const parsed = parseTaskCommentMetadata(metadata);
  if (!parsed.proposal) return {};
  return {
    proposal: {
      ...parsed.proposal,
      status
    }
  };
}

export function isTaskUpdateConfirmation(message: string) {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");
  return new Set([
    "yes",
    "yes looks good",
    "yes, looks good",
    "looks good",
    "confirm",
    "confirmed",
    "apply it",
    "go ahead"
  ]).has(normalized);
}

const FIELD_LABELS: Record<keyof AllowedTaskPatch, string> = {
  task: "title",
  workspace_summary: "description",
  owner: "owner",
  priority: "priority",
  status: "status",
  due_date: "due date",
  task_type: "task type",
  suggested_steps: "suggested next steps",
  rationale: "rationale",
  supporting_context: "supporting context"
};

export function getTaskPatchLabels(patch: AllowedTaskPatch) {
  return Object.keys(patch).map(
    (key) => FIELD_LABELS[key as keyof AllowedTaskPatch]
  );
}

export function formatAppliedPatchMessage(patch: AllowedTaskPatch) {
  return `Updated: ${getTaskPatchLabels(patch).join(", ")}.`;
}

export function formatPendingPatchMessage(patch: AllowedTaskPatch) {
  return `Pending update: ${getTaskPatchLabels(patch).join(
    ", "
  )}. Confirm to apply these exact changes.`;
}

function valuesMatch(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

export function taskContainsPatch(
  task: MeetingTask,
  patch: AllowedTaskPatch
) {
  return Object.entries(patch).every(([key, value]) =>
    valuesMatch(task[key as keyof MeetingTask], value)
  );
}
