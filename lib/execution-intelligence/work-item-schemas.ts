import { z } from "zod";

const nullableDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

export const WORK_ITEM_STATUS_VALUES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "non_execution"
] as const;

export const WORK_ITEM_CLASSIFICATION_VALUES = [
  "open_task",
  "accepted_request",
  "assignment",
  "promise",
  "reminder",
  "scheduling",
  "completed_work",
  "in_progress",
  "request",
  "decision",
  "proposal",
  "idea",
  "question",
  "blocker"
] as const;

export const ACCEPTANCE_STATE_VALUES = [
  "accepted",
  "requested",
  "proposed",
  "none"
] as const;

export const EXECUTION_SCOPE_VALUES = [
  "project_work",
  "personal_logistics",
  "informational"
] as const;

export const GROUP_BASIS_VALUES = [
  "multi_item_shared_purpose",
  "explicit_outcome"
] as const;

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_VALUES);
export const workItemClassificationSchema = z.enum(WORK_ITEM_CLASSIFICATION_VALUES);
export const acceptanceStateSchema = z.enum(ACCEPTANCE_STATE_VALUES);
export const executionScopeSchema = z.enum(EXECUTION_SCOPE_VALUES);
export const groupBasisSchema = z.enum(GROUP_BASIS_VALUES);

/** What the model returns per topic. `ref` and `topic_id` are assigned by application code. */
export const rawWorkItemSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable(),
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    requester: z.string().nullable(),
    recipient: z.string().nullable(),
    due_date: nullableDate,
    due_date_text: z.string().nullable(),
    status: workItemStatusSchema,
    classification: workItemClassificationSchema,
    acceptance_state: acceptanceStateSchema,
    execution_scope: executionScopeSchema,
    classification_reason: z.string().min(1),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    extraction_reason: z.string().min(1),
    confidence: z.number().min(0).max(1).nullable()
  })
  .strict();

export const workItemSchema = rawWorkItemSchema.extend({
  ref: z.string().min(1),
  topic_id: z.string().uuid().nullable(),
  /** Debug-only: original classifications lost when merge deduplicated across a mismatch. */
  merge_conflict_classifications: z.array(z.string()).optional()
});

export type RawWorkItem = z.infer<typeof rawWorkItemSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;

/** The lean, evidence-only view of an eligible WorkItem sent to grouping and verification. */
export type EligibleWorkItemView = {
  ref: string;
  title: string;
  description: string | null;
  owner: string | null;
  status: WorkItem["status"];
  source_quote: string;
  source_segment_ids: string[];
  context_turns: string[];
};

const outcomeEvidenceSchema = z
  .object({
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid())
  })
  .strict()
  .nullable();

/** What the grouping model returns per group. `ref` is assigned by application code. */
export const rawGroupProposalSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable(),
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    due_date: nullableDate,
    due_date_text: z.string().nullable(),
    group_basis: groupBasisSchema,
    member_refs: z.array(z.string()),
    purpose_reason: z.string().min(1),
    scope_added_beyond_members: z.string().nullable(),
    explicit_outcome_evidence: outcomeEvidenceSchema
  })
  .strict();

export const groupProposalSchema = rawGroupProposalSchema.extend({
  ref: z.string().min(1)
});

export type RawGroupProposal = z.infer<typeof rawGroupProposalSchema>;
export type GroupProposal = z.infer<typeof groupProposalSchema>;

/**
 * What the verification model returns per group: a full, revised group set. `ref` must echo a
 * draft group's ref when revising/keeping it, or be null for a group verification is newly
 * proposing (a split, or a missed group built only from existing eligible refs). There is no cap
 * on how many null-ref groups may appear -- deterministic assembly independently validates every
 * group regardless of origin.
 */
export const verifiedGroupSchema = rawGroupProposalSchema.extend({
  ref: z.string().nullable()
});
export type VerifiedGroup = z.infer<typeof verifiedGroupSchema>;

export const workItemExtractionOutputSchema = z
  .object({ items: z.array(rawWorkItemSchema) })
  .strict();

export const groupingOutputSchema = z
  .object({ groups: z.array(rawGroupProposalSchema) })
  .strict();

export const verificationOutputSchema = z
  .object({ groups: z.array(verifiedGroupSchema) })
  .strict();

export type WorkItemExtractionOutput = z.infer<typeof workItemExtractionOutputSchema>;
export type GroupingOutput = z.infer<typeof groupingOutputSchema>;
export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

/** The global, meeting-wide correction/completeness pass. Work items only -- never groups. */
export const globalWorkItemCorrectionSchema = z
  .object({
    ref: z.string().min(1),
    classification: workItemClassificationSchema,
    status: workItemStatusSchema,
    acceptance_state: acceptanceStateSchema,
    execution_scope: executionScopeSchema,
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    classification_reason: z.string().min(1)
  })
  .strict();
export type GlobalWorkItemCorrection = z.infer<typeof globalWorkItemCorrectionSchema>;

/** A work item the topic-scoped extraction pass missed entirely. Same shape as extraction output. */
export const globalWorkItemAdditionSchema = rawWorkItemSchema;
export type GlobalWorkItemAddition = z.infer<typeof globalWorkItemAdditionSchema>;

export const globalCorrectionOutputSchema = z
  .object({
    corrections: z.array(globalWorkItemCorrectionSchema),
    additions: z.array(globalWorkItemAdditionSchema)
  })
  .strict();
export type GlobalCorrectionOutput = z.infer<typeof globalCorrectionOutputSchema>;

export type ExecutionTree = {
  commitments: Array<GroupProposal & { tasks: WorkItem[] }>;
  standalone_tasks: WorkItem[];
};

// --- JSON Schemas for OpenAI structured outputs ---

const outcomeEvidenceJsonSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    source_quote: { type: "string" },
    source_segment_ids: { type: "array", items: { type: "string" } }
  },
  required: ["source_quote", "source_segment_ids"]
} as const;

const rawWorkItemProperties = {
  title: { type: "string" },
  description: { type: ["string", "null"] },
  owner: { type: ["string", "null"] },
  owners: { type: "array", items: { type: "string" } },
  requester: { type: ["string", "null"] },
  recipient: { type: ["string", "null"] },
  due_date: { type: ["string", "null"] },
  due_date_text: { type: ["string", "null"] },
  status: { type: "string", enum: WORK_ITEM_STATUS_VALUES },
  classification: { type: "string", enum: WORK_ITEM_CLASSIFICATION_VALUES },
  acceptance_state: { type: "string", enum: ACCEPTANCE_STATE_VALUES },
  execution_scope: { type: "string", enum: EXECUTION_SCOPE_VALUES },
  classification_reason: { type: "string" },
  source_quote: { type: "string" },
  source_segment_ids: { type: "array", items: { type: "string" } },
  extraction_reason: { type: "string" },
  confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }
} as const;

const rawWorkItemRequired = Object.keys(rawWorkItemProperties);

export const workItemExtractionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: rawWorkItemProperties,
        required: rawWorkItemRequired
      }
    }
  },
  required: ["items"]
};

const rawGroupProposalProperties = {
  title: { type: "string" },
  description: { type: ["string", "null"] },
  owner: { type: ["string", "null"] },
  owners: { type: "array", items: { type: "string" } },
  due_date: { type: ["string", "null"] },
  due_date_text: { type: ["string", "null"] },
  group_basis: { type: "string", enum: GROUP_BASIS_VALUES },
  member_refs: { type: "array", items: { type: "string" } },
  purpose_reason: { type: "string" },
  scope_added_beyond_members: { type: ["string", "null"] },
  explicit_outcome_evidence: outcomeEvidenceJsonSchema
} as const;

const rawGroupProposalRequired = Object.keys(rawGroupProposalProperties);

export const groupingJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: rawGroupProposalProperties,
        required: rawGroupProposalRequired
      }
    }
  },
  required: ["groups"]
};

export const verificationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: { type: ["string", "null"] },
          ...rawGroupProposalProperties
        },
        required: ["ref", ...rawGroupProposalRequired]
      }
    }
  },
  required: ["groups"]
};

const globalWorkItemCorrectionProperties = {
  ref: { type: "string" },
  classification: { type: "string", enum: WORK_ITEM_CLASSIFICATION_VALUES },
  status: { type: "string", enum: WORK_ITEM_STATUS_VALUES },
  acceptance_state: { type: "string", enum: ACCEPTANCE_STATE_VALUES },
  execution_scope: { type: "string", enum: EXECUTION_SCOPE_VALUES },
  owner: { type: ["string", "null"] },
  owners: { type: "array", items: { type: "string" } },
  source_quote: { type: "string" },
  source_segment_ids: { type: "array", items: { type: "string" } },
  classification_reason: { type: "string" }
} as const;

export const globalCorrectionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: globalWorkItemCorrectionProperties,
        required: Object.keys(globalWorkItemCorrectionProperties)
      }
    },
    additions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: rawWorkItemProperties,
        required: rawWorkItemRequired
      }
    }
  },
  required: ["corrections", "additions"]
};
