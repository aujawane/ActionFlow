import type { MeetingGroundTruth } from "../../../../../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { meetingId, meetingTitle } from "./transcript";

/**
 * FROZEN ground truth for synthetic benchmark Meeting 4 ("Planning / Handoff"). Describes
 * scenario.md's intended semantic reality -- the suite's dependency / multi-owner /
 * ownership-transfer-heavy meeting.
 */
const meeting4GroundTruth: MeetingGroundTruth = {
  meeting_id: meetingId,
  meeting_title: meetingTitle,
  notes:
    "Synthetic, hand-authored benchmark meeting. Rollout planning across four people with a real " +
    "dependency, a mid-meeting ownership transfer, a delayed acceptance, and a compound ask. See " +
    "scenario.md for full design intent.",
  ground_truth: [
    {
      id: "SYN-M4-GT1",
      expected_state: "active",
      owners: ["Owen"],
      semantic_outcome: "Build the backend API for team permissions (role assignment and access checks).",
      source_segment_ids: ["SYN-M4-0004", "SYN-M4-0006"],
      notes: "Duplication risk: same owner and same general feature area as SYN-M4-GT3 (the migration script pairing) -- these are two distinct deliverables."
    },
    {
      id: "SYN-M4-GT2",
      expected_state: "active",
      owners: ["Mia"],
      semantic_outcome: "Build the permissions UI, with full integration blocked until Owen's backend API exists.",
      source_segment_ids: ["SYN-M4-0009", "SYN-M4-0010", "SYN-M4-0013"],
      notes:
        "DEPENDENCY case: Mia can start the UI shell now, but explicitly cannot do the real " +
        "integration work until SYN-M4-GT1 exists. Must be scored as one active commitment (not " +
        "'already blocked = missed', and not two separate items for 'shell' vs 'integration')."
    },
    {
      id: "SYN-M4-GT3",
      expected_state: "active",
      owners: ["Owen", "Mia"],
      semantic_outcome: "Pair together on the data-migration script that remaps existing access into the new permission model, flagging anything ambiguous for human review.",
      source_segment_ids: ["SYN-M4-0018", "SYN-M4-0019", "SYN-M4-0020"],
      notes:
        "MULTI-OWNER: both Owen and Mia are genuinely doing this together, not one delegating to " +
        "the other. Discussed three separate times across the meeting (proposed here, scope " +
        "clarified around segment 61-64, timeline re-confirmed around segment 66-68) -- all the " +
        "SAME commitment; must not produce duplicates."
    },
    {
      id: "SYN-M4-GT4",
      expected_state: "active",
      owners: ["Mia"],
      semantic_outcome: "Write the migration documentation once the migration script is done.",
      source_segment_ids: ["SYN-M4-0025", "SYN-M4-0026", "SYN-M4-0027"],
      notes:
        "OWNERSHIP TRANSFER: Derek offers first ('I can write that up', segment 24) but Grace " +
        "redirects it to Mia because she'll have more context, and Mia accepts ('yeah sure, I can " +
        "do that'). The real, final owner is Mia -- NOT Derek. Derek must not be credited with "+
        "this commitment just because he spoke first."
    },
    {
      id: "SYN-M4-GT5",
      expected_state: "active",
      owners: ["Derek"],
      semantic_outcome: "Own customer communications for the live permissions rollout (the real launch, not the earlier beta announcement).",
      source_segment_ids: ["SYN-M4-0039", "SYN-M4-0051", "SYN-M4-0053"],
      notes:
        "DELAYED ACCEPTANCE: Grace's request (segment 39) gets no immediate taker -- Owen and Mia " +
        "both pass -- and the conversation moves on to timeline/scheduling entirely. Derek circles " +
        "back and accepts several turns later (segment 51), after that unrelated exchange. Must be " +
        "recognized as accepted despite the gap, and must be kept distinct from SYN-M4-NEG2 (the " +
        "earlier, already-completed beta announcement)."
    },
    {
      id: "SYN-M4-GT6",
      expected_state: "active",
      owners: ["Grace"],
      semantic_outcome: "Schedule the go/no-go review meeting for next Friday, before launch.",
      source_segment_ids: ["SYN-M4-0047", "SYN-M4-0048"]
    },
    {
      id: "SYN-M4-GT7",
      expected_state: "active",
      owners: ["Derek"],
      semantic_outcome: "Update the external API docs and separately notify the partner-integrations team about the upcoming permissions change.",
      compound_outcomes: [
        "Update the external API docs for the permissions change",
        "Notify the partner integrations team about the upcoming change"
      ],
      source_segment_ids: ["SYN-M4-0032", "SYN-M4-0034"],
      notes: "COMPOUND: two independently-checkable outcomes under one ask -- Grace explicitly calls out that both need to happen ('that's two separate things, make sure both happen')."
    },
    {
      id: "SYN-M4-NEG1",
      expected_state: "negative",
      owners: ["Owen", "Derek"],
      semantic_outcome: "Write a rollback plan for the permissions rollout this sprint.",
      source_segment_ids: ["SYN-M4-0055", "SYN-M4-0057", "SYN-M4-0058"],
      notes: "Raised, agreed to be a good idea in the abstract, explicitly NOT accepted by anyone ('nobody's jumping at it... whenever, no rush'). Unanswered/declined request."
    },
    {
      id: "SYN-M4-NEG2",
      expected_state: "negative",
      owners: ["Derek"],
      semantic_outcome: "Send the beta-customer announcement email about the upcoming permissions change.",
      source_segment_ids: ["SYN-M4-0036", "SYN-M4-0037"],
      notes:
        "COMPLETED ACTION MENTIONED RETROSPECTIVELY: this was already done last week, before this " +
        "meeting even started ('I sent that last week actually, that one's done'). Must NOT be " +
        "scored as an active item, and must NOT be scored as `completed_during_meeting` either -- " +
        "it is neither; it simply predates this meeting entirely and is not this meeting's work."
      }
  ]
};

export default meeting4GroundTruth;
