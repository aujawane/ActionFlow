import { z } from "zod";

/** The complete, server-enforced allowlist of fields the AI correction assistant may ever
 * propose a change to. The model literally cannot express any other field -- `field` is a
 * strict zod enum, not a free string -- and every request/response that crosses the network
 * (model output AND whatever a client echoes back to the apply endpoint) is re-parsed through
 * this same schema. Deliberately excludes classification/Future Scope state and acceptance
 * criteria: those already have dedicated, differently-shaped safe pathways (see
 * CommitmentCorrectionMenu's classification dialogs and /api/commitments/[id]/classification,
 * which run extra hasActiveChildren-style safety checks this generic field-level corrector does
 * not replicate) -- mixing them into this allowlist would let a freeform message bypass those
 * checks. */
export const CORRECTABLE_COMMITMENT_FIELDS = [
  "title",
  "description",
  "owner",
  "supporting_person",
  "due_date",
  "priority",
  "status"
] as const;

export type CorrectableCommitmentField = (typeof CORRECTABLE_COMMITMENT_FIELDS)[number];

export const commitmentCorrectionChangeSchema = z
  .object({
    field: z.enum(CORRECTABLE_COMMITMENT_FIELDS),
    current_value: z.string().nullable(),
    proposed_value: z.string().min(1).max(2000),
    /** Only meaningful when field === "supporting_person": which existing supporting person this
     * change replaces. Must be null for every other field. */
    supporting_person_from: z.string().nullable(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export const commitmentCorrectionResponseSchema = z
  .object({
    responseType: z.enum(["proposal", "clarification", "answer"]),
    message: z.string().min(1),
    changes: z.array(commitmentCorrectionChangeSchema).max(10)
  })
  .strict();

export type CommitmentCorrectionChange = z.infer<typeof commitmentCorrectionChangeSchema>;
export type CommitmentCorrectionResponse = z.infer<typeof commitmentCorrectionResponseSchema>;

const changeJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    field: { type: "string", enum: [...CORRECTABLE_COMMITMENT_FIELDS] },
    current_value: { type: ["string", "null"] },
    proposed_value: { type: "string" },
    supporting_person_from: { type: ["string", "null"] },
    confidence: { type: "number" }
  },
  required: ["field", "current_value", "proposed_value", "supporting_person_from", "confidence"]
};

export const commitmentCorrectionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    responseType: { type: "string", enum: ["proposal", "clarification", "answer"] },
    message: { type: "string" },
    changes: { type: "array", items: changeJsonSchema }
  },
  required: ["responseType", "message", "changes"]
};
