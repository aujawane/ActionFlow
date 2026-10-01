import type { MeetingGroundTruth } from "../../../../../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { meetingId, meetingTitle } from "./transcript";

/**
 * FROZEN ground truth for synthetic benchmark Meeting 1 ("Normal Team Status"). Describes
 * scenario.md's intended semantic reality -- written independently of transcript.ts's literal
 * wording, and independently of any extraction system's output. Do not alter based on how any
 * pipeline scores against it.
 */
const meeting1GroundTruth: MeetingGroundTruth = {
  meeting_id: meetingId,
  meeting_title: meetingTitle,
  notes:
    "Synthetic, hand-authored benchmark meeting. Routine weekly status call with a realistic mix " +
    "of real commitments, a tangent, an informational announcement, and one thing fixed live on " +
    "the call. See scenario.md for full design intent.",
  ground_truth: [
    {
      id: "SYN-M1-GT1",
      expected_state: "active",
      owners: ["Devon"],
      semantic_outcome: "Fix the admin table pagination bug (blank screen when returning to page one).",
      source_segment_ids: ["SYN-M1-0006", "SYN-M1-0010"],
      notes: "Explicit-ish acceptance ('yeah yeah I'll fix that'), but phrased casually mid-conversation."
    },
    {
      id: "SYN-M1-GT2",
      expected_state: "active",
      owners: ["Priya"],
      semantic_outcome: "Investigate why the dashboard overview page queries are slow.",
      source_segment_ids: ["SYN-M1-0021", "SYN-M1-0023", "SYN-M1-0024"],
      notes:
        "Indirect commitment -- she's mid-sentence about triage work when the real commitment " +
        "('yeah I can probably poke at that this week') slips in almost as an aside."
    },
    {
      id: "SYN-M1-GT3",
      expected_state: "active",
      owners: ["Sam"],
      semantic_outcome: "Finish reworking the onboarding flow mockups based on Jamie's feedback.",
      source_segment_ids: ["SYN-M1-0034", "SYN-M1-0035", "SYN-M1-0036"],
      notes:
        "Discussed TWICE in this meeting -- raised at segment 34-36, then checked in on again at " +
        "segment 63-64 ('how's the onboarding stuff coming'). This is ONE commitment; the second " +
        "mention is a status check on the same work, not a new ask. A correct extraction must not " +
        "produce two separate onboarding-mockup items."
    },
    {
      id: "SYN-M1-GT4",
      expected_state: "active",
      owners: ["Devon"],
      semantic_outcome: "Add a CSV export option to the admin table, per the support request.",
      source_segment_ids: ["SYN-M1-0013", "SYN-M1-0015"],
      notes:
        "Duplication risk: owned by the SAME person as SYN-M1-GT1, discussed immediately after it, " +
        "in the same general area ('the admin dashboard'). Devon himself explicitly distinguishes " +
        "them ('separate thing from the pagination bug though, different code path'). These must " +
        "score as two distinct active items, not merge into one or bleed details into each other."
    },
    {
      id: "SYN-M1-GT5",
      expected_state: "active",
      owners: ["Maria"],
      semantic_outcome: "Put together a first draft of the Q3 roadmap doc and share it before next week's meeting.",
      source_segment_ids: ["SYN-M1-0049", "SYN-M1-0050"]
    },
    {
      id: "SYN-M1-COMPLETED1",
      expected_state: "completed_during_meeting",
      owners: ["Priya"],
      semantic_outcome: "Fix the broken internal-docs link pointing at the old wiki domain.",
      source_segment_ids: ["SYN-M1-0056", "SYN-M1-0058", "SYN-M1-0059"],
      notes: "Noticed and fixed live on the call, inside about ten seconds -- not a follow-up task."
    },
    {
      id: "SYN-M1-NEG1",
      expected_state: "negative",
      owners: ["Priya", "Sam", "Devon"],
      semantic_outcome: "Present the Lighthouse roadmap at next week's all-hands.",
      source_segment_ids: ["SYN-M1-0052", "SYN-M1-0053", "SYN-M1-0054", "SYN-M1-0055"],
      notes:
        "Unanswered request. Maria asks directly; Priya's 'hmm, maybe' and Sam's 'I could but...' " +
        "are both hedges, not acceptances, and Maria moves on without anyone committing."
    },
    {
      id: "SYN-M1-NEG2",
      expected_state: "negative",
      owners: ["Devon"],
      semantic_outcome: "Switch CI providers.",
      source_segment_ids: ["SYN-M1-0027", "SYN-M1-0029"],
      notes:
        "Passing frustration ('at some point we should really look into...'), explicitly disclaimed " +
        "in the very next turn ('I'm not actually proposing we do it right now, just saying'). Said " +
        "by the same person who owns two real commitments in this meeting, in a similar tone -- " +
        "tests that speaker/tone alone doesn't manufacture a commitment."
    },
    {
      id: "SYN-M1-NEG3",
      expected_state: "negative",
      owners: ["Maria"],
      semantic_outcome: "Office closure for the holiday on Monday.",
      source_segment_ids: ["SYN-M1-0047"],
      notes: "Pure informational announcement, not directed at anyone as an ask -- must never surface as a task."
    }
  ]
};

export default meeting1GroundTruth;
