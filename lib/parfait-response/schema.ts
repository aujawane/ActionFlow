import { z } from "zod";

import type { ParfaitResponse, ParfaitResponseSection } from "@/lib/types";

/**
 * Shared structured-response contract for Parfait chat surfaces. The model decides WHAT
 * information matters (answer / evidence / blocker / next action / decision / list / warning);
 * this schema is what keeps HOW it looks entirely a frontend concern -- see
 * components/parfait-response-renderer.tsx, the one place that turns this data into UI.
 *
 * Two schemas exist for one reason: OpenAI's strict structured-output mode requires every object
 * key to be present in `required` (nullable, not merely absent) and does not accept a real Zod
 * discriminated union shape cleanly. `rawSectionSchema`/`rawResponseSchema` below mirror exactly
 * what we ask the model for (flat, nullable fields) and are validated first; `normalize()` then
 * converts that into the clean, optional-field `ParfaitResponse` shape (lib/types.ts) that every
 * consumer -- the renderer, persisted metadata, tests -- actually works with. Nothing downstream
 * of `normalize()` ever sees a `null` where "absent" was meant.
 */

const SECTION_TYPES = ["evidence", "blocker", "next_action", "decision", "list", "warning"] as const;

const rawSectionSchema = z
  .object({
    type: z.enum(SECTION_TYPES),
    title: z.string().max(120).nullable(),
    content: z.string().min(1).max(1200).nullable(),
    items: z.array(z.string().min(1).max(300)).max(12).nullable(),
    source: z
      .object({
        meetingId: z.string().nullable(),
        segmentId: z.string().nullable(),
        speaker: z.string().nullable(),
        timestamp: z.string().nullable()
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((section, ctx) => {
    if (section.type === "list") {
      if (!section.items || section.items.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "list sections require at least one item",
          path: ["items"]
        });
      }
    } else if (!section.content || section.content.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${section.type} sections require non-empty content`,
        path: ["content"]
      });
    }
    // Source metadata is only meaningful for evidence -- never carried by any other section type,
    // so it can never be mistaken for a citation on a blocker/decision/etc.
    if (section.type !== "evidence" && section.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only evidence sections may carry source metadata",
        path: ["source"]
      });
    }
  });

const rawResponseSchema = z
  .object({
    answer: z.string().min(1).max(2000),
    sections: z.array(rawSectionSchema).max(6),
    followUps: z.array(z.string().min(1).max(80)).max(3)
  })
  .strict();

type RawSection = z.infer<typeof rawSectionSchema>;
type RawResponse = z.infer<typeof rawResponseSchema>;

function normalizeSection(section: RawSection): ParfaitResponseSection {
  const title = section.title?.trim() || undefined;
  if (section.type === "list") {
    return { type: "list", title, items: (section.items ?? []).map((item) => item.trim()) };
  }
  const content = (section.content ?? "").trim();
  if (section.type === "evidence") {
    const source = section.source
      ? {
          meetingId: section.source.meetingId?.trim() || undefined,
          segmentId: section.source.segmentId?.trim() || undefined,
          speaker: section.source.speaker?.trim() || undefined,
          timestamp: section.source.timestamp?.trim() || undefined
        }
      : undefined;
    const hasSource = source && Object.values(source).some((value) => value !== undefined);
    return { type: "evidence", title, content, source: hasSource ? source : undefined };
  }
  return { type: section.type, title, content };
}

function normalize(raw: RawResponse): ParfaitResponse {
  const sections = raw.sections.map(normalizeSection);
  const followUps = raw.followUps.map((item) => item.trim()).filter(Boolean);
  return {
    answer: raw.answer.trim(),
    ...(sections.length > 0 ? { sections } : {}),
    ...(followUps.length > 0 ? { followUps } : {})
  };
}

/** Parses raw (untrusted) JSON -- typically `JSON.parse(response.output_text)` from an OpenAI
 * structured-output call -- into the clean ParfaitResponse shape. Returns a discriminated result
 * rather than throwing, matching every other agent module's `{ok, ...}` convention in this repo. */
export function parseParfaitResponse(
  data: unknown
): { ok: true; response: ParfaitResponse } | { ok: false; error: string } {
  const parsed = rawResponseSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, response: normalize(parsed.data) };
}

const sectionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: [...SECTION_TYPES] },
    title: { type: ["string", "null"] },
    content: { type: ["string", "null"] },
    items: { type: ["array", "null"], items: { type: "string" } },
    source: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        meetingId: { type: ["string", "null"] },
        segmentId: { type: ["string", "null"] },
        speaker: { type: ["string", "null"] },
        timestamp: { type: ["string", "null"] }
      },
      required: ["meetingId", "segmentId", "speaker", "timestamp"]
    }
  },
  required: ["type", "title", "content", "items", "source"]
};

/** OpenAI `text.format.schema` for any agent that adopts the shared response contract. Deliberately
 * a single flat section shape (not a true JSON Schema union) -- see the module doc comment above
 * for why, and rawSectionSchema's superRefine for where the real per-type constraints are actually
 * enforced (after parsing, server-side, never trusted from the model alone). */
export const parfaitResponseJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    sections: { type: "array", items: sectionJsonSchema },
    followUps: { type: "array", items: { type: "string" } }
  },
  required: ["answer", "sections", "followUps"]
};
