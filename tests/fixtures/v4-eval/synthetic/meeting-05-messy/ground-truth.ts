import type { MeetingGroundTruth } from "../../../../../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { meetingId, meetingTitle } from "./transcript";

/**
 * FROZEN ground truth for synthetic benchmark Meeting 5 ("Messy / ASR-Noisy"). Describes
 * scenario.md's intended semantic reality -- the GT wording is clean even though the transcript it
 * is grounded in is deliberately noisy (misheard terms, stutters, truncated sentences).
 */
const meeting5GroundTruth: MeetingGroundTruth = {
  meeting_id: meetingId,
  meeting_title: meetingTitle,
  notes:
    "Synthetic, hand-authored benchmark meeting. The hardest transcript in the suite on purpose: " +
    "realistic ASR-style noise ('Supabase' heard as 'super base', 'Vercel' as 'versel', 'Chatter' " +
    "as 'chapter', the internal 'Beacon' service as 'bacon') layered over a coherent set of real " +
    "commitments. See scenario.md for full design intent.",
  ground_truth: [
    {
      id: "SYN-M5-GT1",
      expected_state: "active",
      owners: ["Theo"],
      semantic_outcome: "Fix the database connection-pooling issue (pool exhaustion under load) on the Supabase-backed service.",
      source_segment_ids: ["SYN-M5-0006", "SYN-M5-0011", "SYN-M5-0012"],
      notes: "Grounded in a segment where 'Supabase' is transcribed as 'super base' -- GT wording uses the real term regardless."
    },
    {
      id: "SYN-M5-GT2",
      expected_state: "active",
      owners: ["Pavan"],
      semantic_outcome: "Fix the duplicate-message bug in the Chatter agent caused by the webhook retry logic double-firing.",
      source_segment_ids: ["SYN-M5-0017", "SYN-M5-0019", "SYN-M5-0021"],
      notes:
        "INDIRECT ACCEPTANCE: Pavan's acceptance is 'guess that one's on me,' not an explicit 'I " +
        "will fix this' -- ownership is implied, not stated outright. Also grounded in a segment " +
        "where 'Chatter' is transcribed as 'chapter.'"
    },
    {
      id: "SYN-M5-GT3",
      expected_state: "active",
      owners: ["Bex"],
      semantic_outcome: "Update the status page to reflect the known issue and separately message the affected customer directly.",
      compound_outcomes: [
        "Update the status page to reflect the issue",
        "Message the customer directly to let them know it was seen"
      ],
      source_segment_ids: ["SYN-M5-0037", "SYN-M5-0039"],
      notes: "COMPOUND: the customer explicitly wants both -- public status-page reflection AND a direct message."
    },
    {
      id: "SYN-M5-GT4",
      expected_state: "active",
      owners: ["Theo"],
      semantic_outcome: "Add a monitoring alert for when the Beacon feature-flag service restarts or gets stuck.",
      source_segment_ids: ["SYN-M5-0032", "SYN-M5-0034"],
      notes:
        "ACTIVE FOLLOW-UP AFTER AN IN-MEETING FIX: created directly because of the live restart " +
        "(SYN-M5-COMPLETED1) that just happened in this same meeting -- must be scored as a " +
        "distinct, new active item, not folded into or satisfied by the already-completed restart. " +
        "Grounded near a segment where 'Beacon' is transcribed as 'bacon.'"
    },
    {
      id: "SYN-M5-GT5",
      expected_state: "active",
      owners: ["Nina"],
      semantic_outcome: "Verify the Vercel deploy preview still loads correctly after Theo's connection-pooling fix ships.",
      source_segment_ids: ["SYN-M5-0014", "SYN-M5-0055"],
      notes:
        "VERIFICATION action, explicitly sequenced after SYN-M5-GT1 ('once that's in I can just " +
        "double check...'). Grounded in a segment where 'Vercel' is transcribed as 'versel.' Must " +
        "not be collapsed into the fix itself."
    },
    {
      id: "SYN-M5-COMPLETED1",
      expected_state: "completed_during_meeting",
      owners: ["Nina"],
      semantic_outcome: "Restart the Beacon feature-flag service to clear a stuck flag state.",
      source_segment_ids: ["SYN-M5-0027", "SYN-M5-0028", "SYN-M5-0029"],
      notes: "Done live on the call, confirmed working before moving on. Distinct from SYN-M5-GT4, the new monitoring alert created as a result."
    },
    {
      id: "SYN-M5-NEG1",
      expected_state: "negative",
      owners: ["Bex"],
      semantic_outcome: "Rebuild the entire notification system from scratch.",
      source_segment_ids: ["SYN-M5-0046", "SYN-M5-0048"],
      notes:
        "Phrased like a real, scoped task ('what if we just rebuilt the whole notification system " +
        "from scratch') but explicitly left as a someday-maybe with no owner and no decision " +
        "('that's not a this-week thing... let's not open that can of worms right now')."
    }
  ]
};

export default meeting5GroundTruth;
