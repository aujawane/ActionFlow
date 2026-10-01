import type { MeetingGroundTruth } from "../../../../../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { meetingId, meetingTitle } from "./transcript";

/**
 * FROZEN ground truth for synthetic benchmark Meeting 3 ("Product Brainstorm"). Describes
 * scenario.md's intended semantic reality. This meeting is deliberately negative-heavy (3 real
 * commitments against a flood of speculation) -- it exists specifically to test precision.
 */
const meeting3GroundTruth: MeetingGroundTruth = {
  meeting_id: meetingId,
  meeting_title: meetingTitle,
  notes:
    "Synthetic, hand-authored benchmark meeting. Idea-heavy brainstorm with far more speculation " +
    "than real commitment -- the precision stress test of the suite. See scenario.md.",
  ground_truth: [
    {
      id: "SYN-M3-GT1",
      expected_state: "active",
      owners: ["Sana"],
      semantic_outcome: "Build a rough prototype of an activity-trend graph view to test feasibility.",
      source_segment_ids: ["SYN-M3-0037", "SYN-M3-0038"],
      notes:
        "Deliberately a SMALLER, simpler idea than the earlier AI-summary-dashboard speculation " +
        "(SYN-M3-NEG1) -- a rough graph, explicitly 'not production ready,' just to check "+
        "feasibility. Must not be conflated with or inflated into the dashboard idea."
    },
    {
      id: "SYN-M3-GT2",
      expected_state: "active",
      owners: ["Riley"],
      semantic_outcome: "Mock up two layout direction options for the digest email for the next design review.",
      source_segment_ids: ["SYN-M3-0031", "SYN-M3-0032"]
    },
    {
      id: "SYN-M3-GT3",
      expected_state: "active",
      owners: ["Felix"],
      semantic_outcome: "Informally turn on Slack-style digest delivery for his own team for a week as a test, to see if it gets more engagement than the email version.",
      source_segment_ids: ["SYN-M3-0054", "SYN-M3-0056"],
      notes:
        "A genuine, scoped experiment/test action embedded in a lot of surrounding speculation -- " +
        "must be recognized as real, agreed work ('yeah I'll just set that up for my team this " +
        "week'), distinct from the Slack-integration idea itself being tabled (SYN-M3-NEG3)."
    },
    {
      id: "SYN-M3-NEG1",
      expected_state: "negative",
      owners: ["Sana"],
      semantic_outcome: "Build an AI-generated activity-summary dashboard for the digest.",
      source_segment_ids: ["SYN-M3-0017", "SYN-M3-0019", "SYN-M3-0024"],
      notes:
        "Gets unusually serious, multi-turn engagement before fizzling with no owner ('I don't " +
        "think any of us are saying we should actually build that'). Depth of discussion alone " +
        "must not be mistaken for commitment."
    },
    {
      id: "SYN-M3-NEG2",
      expected_state: "negative",
      owners: ["Jordan"],
      semantic_outcome: "Build a Monday-morning project-sorted activity view exactly as vividly described.",
      source_segment_ids: ["SYN-M3-0048", "SYN-M3-0050"],
      notes:
        "A detailed, vivid hypothetical used purely to illustrate a long-term vision ('that's not " +
        "like, a today thing though') -- task-shaped language, zero real work behind it."
    },
    {
      id: "SYN-M3-NEG3",
      expected_state: "negative",
      owners: ["Felix"],
      semantic_outcome: "Build a real Slack-integration delivery channel for the digest.",
      source_segment_ids: ["SYN-M3-0011", "SYN-M3-0013"],
      notes:
        "Future feature explicitly deferred ('let's shelve that for now, next quarter at the " +
        "earliest, if we even do it') -- not started, not assigned, not scheduled. Must be kept " +
        "distinct from SYN-M3-GT3, which is a small, immediate, already-agreed TEST of interest in " +
        "the same general direction, not the integration itself."
    }
  ]
};

export default meeting3GroundTruth;
