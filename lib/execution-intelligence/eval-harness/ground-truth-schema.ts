import { z } from "zod";

/**
 * Human-editable, semantic ground truth for the V4 multi-meeting evaluation harness.
 *
 * Deliberately does NOT store expected internal work-item refs (`wi_g7`, `wi_12`, etc.) -- those
 * are assigned fresh every generation and are never stable across reruns. Ground truth instead
 * describes WHAT should exist (owner, semantic outcome, optional evidence segments) and lets the
 * evaluator (see matcher.ts/stage-tracer.ts) find whatever ref currently represents it, however the
 * pipeline happened to number it this run.
 */

export const GROUND_TRUTH_EXPECTED_STATES = ["active", "completed_during_meeting", "negative"] as const;
export type GroundTruthExpectedState = (typeof GROUND_TRUTH_EXPECTED_STATES)[number];

/**
 * A single ground-truth item. For a COMPOUND commitment (multiple independently-checkable
 * sub-outcomes bundled into one real-world ask, e.g. "finish the Chatter work AND confirm the
 * drops flow works"), set `compound_outcomes` -- each entry is matched independently, and the item
 * is only scored `correct` when every sub-outcome is independently represented in the final ledger
 * (see stage-tracer.ts's compound-scoring rule). Leave `compound_outcomes` unset for a single,
 * atomic outcome.
 */
export const groundTruthItemSchema = z
  .object({
    id: z.string().min(1),
    expected_state: z.enum(GROUND_TRUTH_EXPECTED_STATES),
    /** One or more owners. A multi-owner commitment (e.g. "Craig/Laura/Jay use the prototype")
     * matches when the resolved WorkItem's owner/owners overlaps this list at all -- it does not
     * require every named owner to individually appear as `owner`, since only one of them is
     * usually recorded as primary owner. */
    owners: z.array(z.string().min(1)).min(1),
    /** Plain-language description of the real-world outcome -- never a copy of an expected
     * work-item title, since titles are model-paraphrased and vary generation to generation.
     * Matched via semantic-token similarity against candidate titles/quotes (see matcher.ts). */
    semantic_outcome: z.string().min(1),
    /** Optional independently-checkable sub-outcomes for a compound commitment. When present,
     * `semantic_outcome` above is the human-readable summary of the whole commitment, and scoring
     * is driven entirely by whether each sub-outcome is independently found. */
    compound_outcomes: z.array(z.string().min(1)).optional(),
    /** Best-effort evidence hint -- the real transcript segment UUID(s) this outcome is grounded
     * in, when known. Strengthens matching confidence (segment overlap is the strongest signal the
     * matcher uses) but is not required: an empty array falls back to owner+semantic-outcome
     * matching alone, so a fixture author who hasn't pinned exact segment IDs yet can still write a
     * usable ground-truth item. */
    source_segment_ids: z.array(z.string().min(1)).default([]),
    notes: z.string().optional()
  })
  .strict();
export type GroundTruthItem = z.infer<typeof groundTruthItemSchema>;

export const meetingGroundTruthSchema = z
  .object({
    meeting_id: z.string().min(1),
    meeting_title: z.string().min(1),
    notes: z.string().optional(),
    ground_truth: z.array(groundTruthItemSchema).min(1)
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const seen = new Set<string>();
    fixture.ground_truth.forEach((item, index) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate ground_truth id "${item.id}" -- ids must be unique within a fixture.`,
          path: ["ground_truth", index, "id"]
        });
      }
      seen.add(item.id);
    });
  });
export type MeetingGroundTruth = z.infer<typeof meetingGroundTruthSchema>;

export function parseMeetingGroundTruth(value: unknown): MeetingGroundTruth {
  return meetingGroundTruthSchema.parse(value);
}
