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
    evidence_source: z.enum(["transcript", "topic_summary", "insight"]),
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
    consolidated_from_refs: z.array(z.string()).optional()
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
    evidence_source: z.enum(["transcript", "topic_summary", "insight", "inferred"]),
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
    consolidated_from_refs: z.array(z.string()).optional()
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
            enum: ["transcript", "topic_summary", "insight"]
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
          "type",
          "completion_state",
          "execution_classification",
          "consolidated_from_refs"
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
            enum: ["transcript", "topic_summary", "insight", "inferred"]
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
          "inferred",
          "task_type",
          "workspace_type",
          "suggested_steps",
          "execution_classification",
          "consolidated_from_refs"
        ]
      }
    }
  },
  required: ["commitments", "tasks"]
};
