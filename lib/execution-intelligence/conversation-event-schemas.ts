import { z } from "zod";

export const conversationEventTypeSchema = z.enum([
  "promise",
  "request",
  "acceptance",
  "assignment",
  "decision",
  "progress_update",
  "proposal",
  "future_idea",
  "question",
  "reminder",
  "scheduling_agreement",
  "blocker",
  "completed_work",
  "requirement"
]);

export const conversationEventSchema = z.object({
  client_ref: z.string().min(1),
  type: conversationEventTypeSchema,
  actors: z.array(z.string()),
  action: z.string().nullable(),
  object: z.string().nullable(),
  temporal_state: z.enum([
    "past",
    "present",
    "future",
    "conditional",
    "recurring",
    "unspecified"
  ]),
  commitment_signal: z.enum([
    "none",
    "proposed",
    "requested",
    "accepted",
    "explicit"
  ]),
  source_quote: z.string().min(1),
  source_segment_ids: z.array(z.string().uuid()),
  linked_event_refs: z.array(z.string()),
  confidence: z.number().min(0).max(1)
}).strict();

export const conversationEventsSchema = z.object({
  events: z.array(conversationEventSchema)
}).strict();

export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const conversationEventsJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          client_ref: { type: "string" },
          type: {
            type: "string",
            enum: conversationEventTypeSchema.options
          },
          actors: { type: "array", items: { type: "string" } },
          action: { type: ["string", "null"] },
          object: { type: ["string", "null"] },
          temporal_state: {
            type: "string",
            enum: ["past", "present", "future", "conditional", "recurring", "unspecified"]
          },
          commitment_signal: {
            type: "string",
            enum: ["none", "proposed", "requested", "accepted", "explicit"]
          },
          source_quote: { type: "string" },
          source_segment_ids: { type: "array", items: { type: "string" } },
          linked_event_refs: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: [
          "client_ref", "type", "actors", "action", "object", "temporal_state",
          "commitment_signal", "source_quote", "source_segment_ids",
          "linked_event_refs", "confidence"
        ]
      }
    }
  },
  required: ["events"]
};
