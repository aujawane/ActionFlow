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

/** When, relative to this meeting's agreed sequencing, this item is actually being worked. */
export const SCOPE_STATE_VALUES = [
  "current_scope",
  "future_scope",
  "optional",
  "superseded",
  "informational"
] as const;

/** What kind of thing this item is, independent of whether it's accepted or in scope. */
export const WORK_ITEM_ROLE_VALUES = [
  "action",
  "input_dependency",
  "acceptance_criterion",
  "scope_decision",
  "future_feature",
  "reference",
  "idea",
  "question",
  "status_update",
  "incidental_troubleshooting"
] as const;

export const GROUP_BASIS_VALUES = [
  "explicit_deliverable",
  "multi_item_shared_purpose",
  "explicit_zero_task_outcome"
] as const;

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_VALUES);
export const workItemClassificationSchema = z.enum(WORK_ITEM_CLASSIFICATION_VALUES);
export const acceptanceStateSchema = z.enum(ACCEPTANCE_STATE_VALUES);
export const executionScopeSchema = z.enum(EXECUTION_SCOPE_VALUES);
export const scopeStateSchema = z.enum(SCOPE_STATE_VALUES);
export const workItemRoleSchema = z.enum(WORK_ITEM_ROLE_VALUES);
export const groupBasisSchema = z.enum(GROUP_BASIS_VALUES);

/** What the model returns per topic. `ref` and `topic_id` are assigned by application code.
 * `scope_state`/`work_item_role` are the topic-scoped pass's first guess; the global scope/role
 * reconciliation stage has final, meeting-wide say over both (see `GlobalWorkItemCorrection`). */
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
    scope_state: scopeStateSchema,
    work_item_role: workItemRoleSchema,
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
  merge_conflict_classifications: z.array(z.string()).optional(),
  /** Set only when the global reconciliation pass changed this item's scope/role/classification. */
  reconciliation_reason: z.string().nullable().optional(),
  /** Segment IDs of the later statement that moved this item's scope_state (e.g. to superseded). */
  superseding_segment_ids: z.array(z.string().uuid()).optional(),
  /** Refs of earlier items this one supersedes, when reconciliation resolved a scope conflict. */
  superseded_item_refs: z.array(z.string()).optional()
});

export type RawWorkItem = z.infer<typeof rawWorkItemSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;

/** The lean, evidence-only view of a WorkItem sent to grouping and verification. */
export type EligibleWorkItemView = {
  ref: string;
  title: string;
  description: string | null;
  owner: string | null;
  status: WorkItem["status"];
  work_item_role: WorkItem["work_item_role"];
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

/**
 * What the grouping model returns per group. `ref` is assigned by application code.
 * `member_refs` are eligible actions/input dependencies; `acceptance_criteria_refs` are separate
 * current-scope acceptance-criterion items attached to (not merged into) the group.
 */
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
    acceptance_criteria_refs: z.array(z.string()),
    purpose_reason: z.string().min(1),
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

/**
 * The one global, meeting-wide scope/role reconciliation pass. Work items only -- never groups.
 * Sees the full transcript and can resolve current-vs-future scope using later sequencing
 * statements, in addition to everything the original correction stage already did.
 */
export const globalWorkItemCorrectionSchema = z
  .object({
    ref: z.string().min(1),
    classification: workItemClassificationSchema,
    status: workItemStatusSchema,
    acceptance_state: acceptanceStateSchema,
    execution_scope: executionScopeSchema,
    scope_state: scopeStateSchema,
    work_item_role: workItemRoleSchema,
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    classification_reason: z.string().min(1),
    reconciliation_reason: z.string().nullable(),
    superseding_segment_ids: z.array(z.string().uuid()),
    superseded_item_refs: z.array(z.string())
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

// --- Phase 0: transcript normalization ---

export const transcriptCorrectionSchema = z
  .object({
    segment_id: z.string().uuid(),
    original_text: z.string().min(1),
    normalized_text: z.string().min(1),
    original_token: z.string().min(1),
    replacement: z.string().min(1),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.string().nullable()
  })
  .strict();
export type TranscriptCorrection = z.infer<typeof transcriptCorrectionSchema>;

export const transcriptNormalizationOutputSchema = z
  .object({ corrections: z.array(transcriptCorrectionSchema) })
  .strict();
export type TranscriptNormalizationOutput = z.infer<typeof transcriptNormalizationOutputSchema>;

// --- Phase 5: background task consolidation ---

export const TASK_CONSOLIDATION_DISPOSITION_VALUES = [
  "merge",
  "keep_separate",
  "absorb_as_sequence_note"
] as const;
export const taskConsolidationDispositionSchema = z.enum(TASK_CONSOLIDATION_DISPOSITION_VALUES);

export const taskConsolidationProposalSchema = z
  .object({
    proposal_ref: z.string().min(1),
    task_refs: z.array(z.string()).min(1),
    disposition: taskConsolidationDispositionSchema,
    canonical_title: z.string().nullable(),
    canonical_description: z.string().nullable(),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    completion_equivalence: z.string().min(1),
    preserved_sequence_note: z.string().nullable()
  })
  .strict();
export type TaskConsolidationProposal = z.infer<typeof taskConsolidationProposalSchema>;

export const taskConsolidationOutputSchema = z
  .object({ proposals: z.array(taskConsolidationProposalSchema) })
  .strict();
export type TaskConsolidationOutput = z.infer<typeof taskConsolidationOutputSchema>;

export type TaskMergeProvenance = {
  merged_from_task_refs: string[];
  merge_type: "exact" | "semantic" | "standalone_absorption";
  merge_reason: string;
  merge_confidence: number;
  consolidation_generation: number;
  preserved_sequence_notes: string[];
};

export type ExecutionTree = {
  commitments: Array<
    GroupProposal & {
      tasks: WorkItem[];
      acceptance_criteria: WorkItem[];
      primary_owner_reason: string;
    }
  >;
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
  scope_state: { type: "string", enum: SCOPE_STATE_VALUES },
  work_item_role: { type: "string", enum: WORK_ITEM_ROLE_VALUES },
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
  acceptance_criteria_refs: { type: "array", items: { type: "string" } },
  purpose_reason: { type: "string" },
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
  scope_state: { type: "string", enum: SCOPE_STATE_VALUES },
  work_item_role: { type: "string", enum: WORK_ITEM_ROLE_VALUES },
  owner: { type: ["string", "null"] },
  owners: { type: "array", items: { type: "string" } },
  source_quote: { type: "string" },
  source_segment_ids: { type: "array", items: { type: "string" } },
  classification_reason: { type: "string" },
  reconciliation_reason: { type: ["string", "null"] },
  superseding_segment_ids: { type: "array", items: { type: "string" } },
  superseded_item_refs: { type: "array", items: { type: "string" } }
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

const transcriptCorrectionProperties = {
  segment_id: { type: "string" },
  original_text: { type: "string" },
  normalized_text: { type: "string" },
  original_token: { type: "string" },
  replacement: { type: "string" },
  reason: { type: "string" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  evidence: { type: ["string", "null"] }
} as const;

export const transcriptNormalizationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: transcriptCorrectionProperties,
        required: Object.keys(transcriptCorrectionProperties)
      }
    }
  },
  required: ["corrections"]
};

const taskConsolidationProposalProperties = {
  proposal_ref: { type: "string" },
  task_refs: { type: "array", items: { type: "string" } },
  disposition: { type: "string", enum: TASK_CONSOLIDATION_DISPOSITION_VALUES },
  canonical_title: { type: ["string", "null"] },
  canonical_description: { type: ["string", "null"] },
  reason: { type: "string" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  completion_equivalence: { type: "string" },
  preserved_sequence_note: { type: ["string", "null"] }
} as const;

export const taskConsolidationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: taskConsolidationProposalProperties,
        required: Object.keys(taskConsolidationProposalProperties)
      }
    }
  },
  required: ["proposals"]
};
