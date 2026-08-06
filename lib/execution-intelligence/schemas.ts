import { z } from "zod";

const nullableDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

export const executionClassificationSchema = z.enum([
  "committed",
  "proposed",
  "requirement",
  "future_consideration"
]);

export const actionClassificationSchema = z.enum([
  "open_task",
  "completed_work",
  "in_progress",
  "request",
  "accepted_request",
  "assignment",
  "promise",
  "decision",
  "proposal",
  "idea",
  "question",
  "blocker",
  "reminder",
  "scheduling"
]);

export type ExecutionClassification = z.infer<typeof executionClassificationSchema>;

export const commitmentCandidateSchema = z
  .object({
    client_ref: z.string().min(1),
    topic_id: z.string().uuid().nullable(),
    title: z.string().min(1),
    description: z.string().nullable(),
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    due_date: nullableDate,
    due_date_text: z.string().nullable(),
    priority: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    evidence_source: z.enum([
      "transcript",
      "topic_summary",
      "insight",
      "conversation_event"
    ]),
    conversation_event_ids: z.array(z.string()).optional(),
    type: z.enum([
      "personal",
      "assignment",
      "implicit",
      "unassigned",
      "reminder",
      "conditional",
      "recurring",
      "group",
      "team",
      "company"
    ]),
    completion_state: z.enum([
      "open",
      "in_progress",
      "blocked",
      "completed",
      "cancelled"
    ]),
    execution_classification: executionClassificationSchema.optional(),
    consolidated_from_refs: z.array(z.string()).optional(),
    supporting_action_refs: z.array(z.string()).optional(),
    commitment_reason: z.string().nullable().optional()
  })
  .strict();

export const taskCandidateSchema = z
  .object({
    client_ref: z.string().min(1),
    commitment_ref: z.string().nullable(),
    topic_id: z.string().uuid().nullable(),
    title: z.string().min(1),
    description: z.string().nullable(),
    owner: z.string().nullable(),
    owners: z.array(z.string()),
    due_date: nullableDate,
    due_date_text: z.string().nullable(),
    priority: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    source_quote: z.string().min(1),
    source_segment_ids: z.array(z.string().uuid()),
    evidence_source: z.enum([
      "transcript",
      "topic_summary",
      "insight",
      "conversation_event",
      "inferred"
    ]),
    conversation_event_ids: z.array(z.string()).optional(),
    inferred: z.boolean(),
    task_type: z.enum(["commitment", "implicit_commitment", "unassigned_work"]),
    workspace_type: z.enum([
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
    ]),
    suggested_steps: z.array(z.string()),
    execution_classification: executionClassificationSchema.optional(),
    consolidated_from_refs: z.array(z.string()).optional(),
    action_classification: actionClassificationSchema.optional(),
    action_status: z.enum([
      "open",
      "in_progress",
      "blocked",
      "completed",
      "non_execution"
    ]).optional(),
    requester: z.string().nullable().optional(),
    recipient: z.string().nullable().optional(),
    extraction_reason: z.string().nullable().optional(),
    relationship_confidence: z.number().min(0).max(1).nullable().optional(),
    relationship_reason: z.string().nullable().optional(),
    relationship_evidence: z.array(z.string()).optional()
  })
  .strict();

export const executionGraphSchema = z
  .object({
    commitments: z.array(commitmentCandidateSchema),
    tasks: z.array(taskCandidateSchema)
  })
  .strict();

export type CommitmentCandidate = z.infer<typeof commitmentCandidateSchema>;
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;
export type ExecutionGraph = z.infer<typeof executionGraphSchema>;

const classificationEnum = [
  "committed",
  "proposed",
  "requirement",
  "future_consideration"
];

export const executionGraphJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    commitments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          client_ref: { type: "string" },
          topic_id: { type: ["string", "null"] },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          owner: { type: ["string", "null"] },
          owners: { type: "array", items: { type: "string" } },
          due_date: { type: ["string", "null"] },
          due_date_text: { type: ["string", "null"] },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source_quote: { type: "string" },
          source_segment_ids: {
            type: "array",
            items: { type: "string" }
          },
          evidence_source: {
            type: "string",
            enum: ["transcript", "topic_summary", "insight", "conversation_event"]
          },
          conversation_event_ids: {
            type: "array",
            items: { type: "string" }
          },
          type: {
            type: "string",
            enum: [
              "personal",
              "assignment",
              "implicit",
              "unassigned",
              "reminder",
              "conditional",
              "recurring",
              "group",
              "team",
              "company"
            ]
          },
          completion_state: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "completed", "cancelled"]
          },
          execution_classification: {
            type: "string",
            enum: classificationEnum
          },
          consolidated_from_refs: {
            type: "array",
            items: { type: "string" }
          },
          supporting_action_refs: {
            type: "array",
            items: { type: "string" }
          },
          commitment_reason: {
            type: ["string", "null"]
          }
        },
        required: [
          "client_ref",
          "topic_id",
          "title",
          "description",
          "owner",
          "owners",
          "due_date",
          "due_date_text",
          "priority",
          "confidence",
          "source_quote",
          "source_segment_ids",
          "evidence_source",
          "conversation_event_ids",
          "type",
          "completion_state",
          "execution_classification",
          "consolidated_from_refs",
          "supporting_action_refs",
          "commitment_reason"
        ]
      }
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          client_ref: { type: "string" },
          commitment_ref: { type: ["string", "null"] },
          topic_id: { type: ["string", "null"] },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          owner: { type: ["string", "null"] },
          owners: { type: "array", items: { type: "string" } },
          due_date: { type: ["string", "null"] },
          due_date_text: { type: ["string", "null"] },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source_quote: { type: "string" },
          source_segment_ids: {
            type: "array",
            items: { type: "string" }
          },
          evidence_source: {
            type: "string",
            enum: [
              "transcript",
              "topic_summary",
              "insight",
              "conversation_event",
              "inferred"
            ]
          },
          conversation_event_ids: {
            type: "array",
            items: { type: "string" }
          },
          inferred: { type: "boolean" },
          task_type: {
            type: "string",
            enum: ["commitment", "implicit_commitment", "unassigned_work"]
          },
          workspace_type: {
            type: "string",
            enum: [
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
            ]
          },
          suggested_steps: { type: "array", items: { type: "string" } },
          execution_classification: {
            type: "string",
            enum: classificationEnum
          },
          consolidated_from_refs: {
            type: "array",
            items: { type: "string" }
          },
          action_classification: {
            type: "string",
            enum: actionClassificationSchema.options
          },
          action_status: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "completed", "non_execution"]
          },
          requester: { type: ["string", "null"] },
          recipient: { type: ["string", "null"] },
          extraction_reason: { type: ["string", "null"] },
          relationship_confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
          relationship_reason: { type: ["string", "null"] },
          relationship_evidence: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: [
          "client_ref",
          "commitment_ref",
          "topic_id",
          "title",
          "description",
          "owner",
          "owners",
          "due_date",
          "due_date_text",
          "priority",
          "confidence",
          "source_quote",
          "source_segment_ids",
          "evidence_source",
          "conversation_event_ids",
          "inferred",
          "task_type",
          "workspace_type",
          "suggested_steps",
          "execution_classification",
          "consolidated_from_refs",
          "action_classification",
          "action_status",
          "requester",
          "recipient",
          "extraction_reason",
          "relationship_confidence",
          "relationship_reason",
          "relationship_evidence"
        ]
      }
    }
  },
  required: ["commitments", "tasks"]
};
