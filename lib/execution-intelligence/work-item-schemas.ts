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

/** Pass B's (completeness adjudication) disposition per harvested candidate -- a small,
 * purpose-specific taxonomy, matching the precedent set by TASK_CONSOLIDATION_DISPOSITION_VALUES
 * rather than overloading WORK_ITEM_CLASSIFICATION_VALUES, since none of these six values describe
 * a final WorkItem field -- they describe what Pass B decided to DO with a harvested candidate. */
export const COMPLETENESS_ADJUDICATION_DISPOSITION_VALUES = [
  "add",
  "already_represented",
  "speculative_or_inactive",
  "retrospective_or_completed",
  "non_execution",
  "insufficient_grounding"
] as const;

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_VALUES);
export const workItemClassificationSchema = z.enum(WORK_ITEM_CLASSIFICATION_VALUES);
export const acceptanceStateSchema = z.enum(ACCEPTANCE_STATE_VALUES);
export const executionScopeSchema = z.enum(EXECUTION_SCOPE_VALUES);
export const scopeStateSchema = z.enum(SCOPE_STATE_VALUES);
export const workItemRoleSchema = z.enum(WORK_ITEM_ROLE_VALUES);
export const groupBasisSchema = z.enum(GROUP_BASIS_VALUES);
export const completenessAdjudicationDispositionSchema = z.enum(COMPLETENESS_ADJUDICATION_DISPOSITION_VALUES);

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
 * Per-ref lifecycle review (Pass B: EXHAUSTIVE LIFECYCLE RECONCILIATION). Work items only -- never
 * groups. Sees the full transcript and can resolve current-vs-future scope, temporal completion,
 * duplicate-representation supersession, and owner attribution using later sequencing statements,
 * for every ref it is asked to review. Same shape the original single-pass global correction used
 * for its "corrections" array -- reused as-is, not a new taxonomy.
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
    superseded_item_refs: z.array(z.string()),
    /** Evidence that this SPECIFIC action was actually performed, distinct from
     * superseding_segment_ids (which is about duplicate-representation reconciliation, not
     * completion). Required (may be empty) so the model must always take a position: a review
     * proposing status=completed/classification=completed_work with an empty array here is
     * programmatically rejected -- see validateCompletionEvidence in work-item-stages.ts. Never
     * trusted on its own; only a necessary precondition for the targeted completion verifier. */
    completion_segment_ids: z.array(z.string().uuid()),
    /** Why the cited completion_segment_ids demonstrate the same action was performed; null when
     * this review does not propose completion. */
    completion_reason: z.string().nullable()
  })
  .strict();
export type GlobalWorkItemCorrection = z.infer<typeof globalWorkItemCorrectionSchema>;

/** A work item completely missing from the ledger (Pass A: COMPLETENESS RECOVERY). Same shape as
 * ordinary extraction output. */
export const globalWorkItemAdditionSchema = rawWorkItemSchema;
export type GlobalWorkItemAddition = z.infer<typeof globalWorkItemAdditionSchema>;

/**
 * Pass A (ATOMIC ACTION HARVEST) output: a per-window, ledger-blind enumeration of every plausible
 * grounded action/outcome candidate -- deliberately high recall, deliberately unaware of what the
 * ledger already contains (that judgment belongs entirely to Pass B). `candidate_id` is local to
 * this one harvest call only; application code assigns a canonical, pass-wide-unique ref
 * immediately after receiving it (see work-item-stages.ts) -- never trusted or reused downstream.
 */
export const atomicActionHarvestCandidateSchema = z
  .object({
    candidate_id: z.string().min(1),
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    outcome: z.string().min(1),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    harvest_reason: z.string().min(1)
  })
  .strict();
export type AtomicActionHarvestCandidate = z.infer<typeof atomicActionHarvestCandidateSchema>;

export const atomicActionHarvestOutputSchema = z
  .object({ candidates: z.array(atomicActionHarvestCandidateSchema) })
  .strict();
export type AtomicActionHarvestOutput = z.infer<typeof atomicActionHarvestOutputSchema>;

/**
 * Pass B (MISSING-WORK ADJUDICATION) output: exactly one decision per harvested candidate it was
 * given, exhaustively -- coverage is programmatically enforced afterward (see
 * validateCompletenessAdjudicationCoverage in work-item-stages.ts), the same pattern already used
 * for lifecycle reconciliation's exhaustive coverage, never trusted on prompt wording alone.
 * `addition` is populated (and required to be schema-valid) only when disposition="add"; every
 * other disposition must leave it null. This is the ONLY place a completeness addition's final
 * WorkItem-shaped fields (classification/acceptance_state/scope_state/execution_scope/etc.) are
 * decided -- Pass A never assigns them.
 */
export const completenessAdjudicationDecisionSchema = z
  .object({
    candidate_id: z.string().min(1),
    disposition: completenessAdjudicationDispositionSchema,
    reason: z.string().min(1),
    addition: globalWorkItemAdditionSchema.nullable()
  })
  .strict();
export type CompletenessAdjudicationDecision = z.infer<typeof completenessAdjudicationDecisionSchema>;

export const completenessAdjudicationOutputSchema = z
  .object({ decisions: z.array(completenessAdjudicationDecisionSchema) })
  .strict();
export type CompletenessAdjudicationOutput = z.infer<typeof completenessAdjudicationOutputSchema>;

/**
 * Pass B output: one review per submitted ref, exhaustively. `reviews` (not "corrections") to make
 * the exhaustive-coverage contract explicit -- every requested ref must appear, including a
 * no-op review that simply echoes an item's current values back unchanged.
 */
export const lifecycleReviewOutputSchema = z
  .object({ reviews: z.array(globalWorkItemCorrectionSchema) })
  .strict();
export type LifecycleReviewOutput = z.infer<typeof lifecycleReviewOutputSchema>;

/**
 * Targeted completion verifier (temporal-completion precision hardening). One call, one work
 * item, one question: does the cited later evidence demonstrate the SAME real-world action was
 * actually performed? No extraction, no scope repair, no owner repair, no duplicate reasoning --
 * a single object, not a batch, since this is deliberately narrow.
 */
export const completionVerificationSchema = z
  .object({
    confirmed: z.boolean(),
    reasoning: z.string().min(1),
    supporting_segment_ids: z.array(z.string().uuid())
  })
  .strict();
export type CompletionVerification = z.infer<typeof completionVerificationSchema>;

/**
 * Targeted scope-deferral verifier (later-scope-supersession precision hardening). One call, one
 * work item, one question: does the cited later evidence explicitly defer, remove, or move this
 * SAME feature/deliverable to a later phase -- not just nearby/related discussion? Mirrors
 * completionVerificationSchema's shape exactly, since it is the same kind of narrow, isolated
 * semantic check, just for the opposite direction (closing scope rather than closing completion).
 */
export const scopeDeferralVerificationSchema = z
  .object({
    confirmed: z.boolean(),
    reasoning: z.string().min(1),
    supporting_segment_ids: z.array(z.string().uuid())
  })
  .strict();
export type ScopeDeferralVerification = z.infer<typeof scopeDeferralVerificationSchema>;

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

/** A possible new project term the model noticed while normalizing -- never auto-trusted; always
 * stored as an unapproved suggestion (see lib/project-vocabulary.ts). */
export const vocabularyCandidateSchema = z
  .object({
    canonical_term: z.string().min(1),
    observed_alias: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence_segment_ids: z.array(z.string().uuid())
  })
  .strict();
export type VocabularyCandidate = z.infer<typeof vocabularyCandidateSchema>;

export const transcriptNormalizationOutputSchema = z
  .object({
    corrections: z.array(transcriptCorrectionSchema),
    vocabulary_candidates: z.array(vocabularyCandidateSchema)
  })
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
  /** Grounded, owned, genuinely-execution-like work items that are already DONE -- completed
   * during this meeting (whether in the same breath as being proposed, or via a later lifecycle
   * correction of an initially-open item). Never participates in grouping, consolidation,
   * dependency execution, or active-work recovery (see isCompletedDuringMeeting in
   * execution-tree.ts) -- it exists purely so a genuine in-meeting completion still produces a
   * persisted historical record instead of silently vanishing. Deliberately a separate bucket from
   * `standalone_tasks`/`commitments`, never merged into them, so active-work consumers of this type
   * never need to re-filter out completed items themselves. */
  completed_work?: WorkItem[];
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
  superseded_item_refs: { type: "array", items: { type: "string" } },
  completion_segment_ids: { type: "array", items: { type: "string" } },
  completion_reason: { type: ["string", "null"] }
} as const;

const atomicActionHarvestCandidateProperties = {
  candidate_id: { type: "string" },
  owner: { type: ["string", "null"] },
  owners: { type: "array", items: { type: "string" } },
  outcome: { type: "string" },
  source_quote: { type: "string" },
  source_segment_ids: { type: "array", items: { type: "string" } },
  harvest_reason: { type: "string" }
} as const;

export const atomicActionHarvestJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: atomicActionHarvestCandidateProperties,
        required: Object.keys(atomicActionHarvestCandidateProperties)
      }
    }
  },
  required: ["candidates"]
};

const completenessAdjudicationDecisionProperties = {
  candidate_id: { type: "string" },
  disposition: { type: "string", enum: COMPLETENESS_ADJUDICATION_DISPOSITION_VALUES },
  reason: { type: "string" },
  addition: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: rawWorkItemProperties,
    required: rawWorkItemRequired
  }
} as const;

export const completenessAdjudicationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: completenessAdjudicationDecisionProperties,
        required: Object.keys(completenessAdjudicationDecisionProperties)
      }
    }
  },
  required: ["decisions"]
};

export const lifecycleReviewJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: globalWorkItemCorrectionProperties,
        required: Object.keys(globalWorkItemCorrectionProperties)
      }
    }
  },
  required: ["reviews"]
};

const completionVerificationProperties = {
  confirmed: { type: "boolean" },
  reasoning: { type: "string" },
  supporting_segment_ids: { type: "array", items: { type: "string" } }
} as const;

export const completionVerificationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: completionVerificationProperties,
  required: Object.keys(completionVerificationProperties)
};

const scopeDeferralVerificationProperties = {
  confirmed: { type: "boolean" },
  reasoning: { type: "string" },
  supporting_segment_ids: { type: "array", items: { type: "string" } }
} as const;

export const scopeDeferralVerificationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: scopeDeferralVerificationProperties,
  required: Object.keys(scopeDeferralVerificationProperties)
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

const vocabularyCandidateProperties = {
  canonical_term: { type: "string" },
  observed_alias: { type: "string" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  evidence_segment_ids: { type: "array", items: { type: "string" } }
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
    },
    vocabulary_candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: vocabularyCandidateProperties,
        required: Object.keys(vocabularyCandidateProperties)
      }
    }
  },
  required: ["corrections", "vocabulary_candidates"]
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
