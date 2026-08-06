import { z } from "zod";

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const priority = z.enum(["low", "medium", "high"]);
const taskStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "dismissed",
  "blocked"
]);
const milestoneStatus = taskStatus;

export const projectBrainReferenceSchema = z
  .object({
    type: z.enum([
      "project",
      "meeting",
      "milestone",
      "task",
      "decision",
      "requirement",
      "constraint"
    ]),
    id: uuid,
    label: z.string().min(1).max(300)
  })
  .strict();

const operationMetadata = {
  explanation: z.string().min(1).max(2000),
  evidence: z.array(projectBrainReferenceSchema),
  warning: z.string().max(1000).nullable()
};

const projectChanges = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    goal: z.string().max(5000).nullable().optional(),
    status: z.enum(["planning", "active", "on_hold", "completed", "archived"]).optional()
  })
  .strict();

export const projectMemoryChangesSchema = z
  .object({
    summary: z.string().max(8000).nullable().optional(),
    goal: z.string().max(5000).nullable().optional(),
    product_description: z.string().max(8000).nullable().optional(),
    target_audience: z.string().max(5000).nullable().optional(),
    current_scope: z.array(z.string().max(1000)).optional(),
    future_scope: z.array(z.string().max(1000)).optional(),
    technical_context: z.record(z.string(), z.unknown()).optional(),
    design_context: z.record(z.string(), z.unknown()).optional(),
    constraints: z.array(z.string().max(1000)).optional(),
    assumptions: z.array(z.string().max(1000)).optional(),
    success_criteria: z.array(z.string().max(1000)).optional()
  })
  .strict();

const taskChanges = z
  .object({
    task: z.string().min(1).max(500).optional(),
    description: z.string().max(4000).nullable().optional(),
    owner: z.string().max(160).nullable().optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: priority.optional(),
    status: taskStatus.optional()
  })
  .strict();

const milestoneChanges = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).nullable().optional(),
    owner: z.string().max(160).nullable().optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: priority.optional(),
    status: milestoneStatus.optional(),
    completion_state: z
      .enum(["open", "in_progress", "blocked", "completed", "cancelled"])
      .optional()
  })
  .strict();

export const projectChangeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update_project"), changes: projectChanges, ...operationMetadata }).strict(),
  z.object({ type: z.literal("update_project_memory"), changes: projectMemoryChangesSchema, ...operationMetadata }).strict(),
  z.object({
    type: z.literal("create_milestone"),
    title: z.string().min(1).max(500),
    description: z.string().max(5000).nullable(),
    owner: z.string().max(160).nullable(),
    owners: z.array(z.string().max(160)),
    priority,
    ...operationMetadata
  }).strict(),
  z.object({ type: z.literal("update_milestone"), milestoneId: uuid, changes: milestoneChanges, ...operationMetadata }).strict(),
  z.object({
    type: z.literal("rename_milestone"),
    milestoneId: uuid,
    title: z.string().min(1).max(500),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("merge_milestones"),
    sourceMilestoneIds: z.array(uuid).min(2).max(30),
    targetMilestoneId: nullableUuid,
    target: z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(5000).nullable()
    }).strict(),
    ...operationMetadata
  }).strict(),
  z.object({ type: z.literal("archive_milestone"), milestoneId: uuid, reason: z.string().min(1).max(1000), ...operationMetadata }).strict(),
  z.object({
    type: z.literal("defer_milestone"),
    milestoneId: uuid,
    reason: z.string().min(1).max(1000),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("create_task"),
    milestoneId: uuid,
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    ownerName: z.string().max(160).nullable(),
    priority,
    workspaceType: z.string().max(80),
    position: z.number().int().min(0),
    ...operationMetadata
  }).strict(),
  z.object({ type: z.literal("update_task"), taskId: uuid, changes: taskChanges, ...operationMetadata }).strict(),
  z.object({ type: z.literal("move_task"), taskId: uuid, targetMilestoneId: uuid, ...operationMetadata }).strict(),
  z.object({
    type: z.literal("merge_tasks"),
    survivorTaskId: uuid,
    mergedTaskIds: z.array(uuid).min(1).max(50),
    ...operationMetadata
  }).strict(),
  z.object({ type: z.literal("archive_task"), taskId: uuid, reason: z.string().min(1).max(1000), ...operationMetadata }).strict(),
  z.object({ type: z.literal("update_task_status"), taskId: uuid, status: taskStatus, ...operationMetadata }).strict(),
  z.object({ type: z.literal("assign_task_owner"), taskId: uuid, ownerName: z.string().max(160).nullable(), ...operationMetadata }).strict(),
  z.object({
    type: z.literal("add_requirement"),
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    category: z.string().max(100),
    status: z.enum(["active", "satisfied", "deferred", "archived"]),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("update_requirement"),
    requirementId: uuid,
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    category: z.string().max(100),
    status: z.enum(["active", "satisfied", "deferred", "archived"]),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("add_decision"),
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("supersede_decision"),
    decisionId: uuid,
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    ...operationMetadata
  }).strict(),
  z.object({
    type: z.literal("add_constraint"),
    title: z.string().min(1).max(500),
    description: z.string().max(4000).nullable(),
    category: z.string().max(100),
    ...operationMetadata
  }).strict(),
  z.object({ type: z.literal("remove_constraint"), constraintId: uuid, reason: z.string().min(1).max(1000), ...operationMetadata }).strict(),
  z.object({ type: z.literal("add_dependency"), taskId: uuid, dependsOnTaskId: uuid, ...operationMetadata }).strict(),
  z.object({ type: z.literal("remove_dependency"), taskId: uuid, dependsOnTaskId: uuid, ...operationMetadata }).strict(),
  z.object({
    type: z.literal("add_project_participant"),
    participantName: z.string().min(1).max(160),
    participantUserId: nullableUuid,
    role: z.string().min(1).max(100),
    ...operationMetadata
  }).strict()
]);

export const projectProposalSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    baseGraphVersion: z.number().int().min(0),
    operations: z.array(projectChangeOperationSchema).max(100)
  })
  .strict();

export const projectBrainResponseSchema = z
  .object({
    responseType: z.enum(["answer", "clarification", "proposal"]),
    message: z.string().min(1).max(8000),
    proposal: projectProposalSchema.nullable(),
    references: z.array(projectBrainReferenceSchema).max(50),
    warnings: z.array(z.string().max(1000)).max(30)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.responseType === "proposal" && !value.proposal) {
      context.addIssue({
        code: "custom",
        message: "Proposal responses require a proposal."
      });
    }
    if (value.responseType !== "proposal" && value.proposal) {
      context.addIssue({
        code: "custom",
        message: "Only proposal responses may include a proposal."
      });
    }
  });

export const projectProposalReviewSchema = z
  .object({
    operations: z.array(projectChangeOperationSchema).max(100)
  })
  .strict();

export type ProjectChangeOperation = z.infer<typeof projectChangeOperationSchema>;
export type ProjectBrainResponse = z.infer<typeof projectBrainResponseSchema>;
