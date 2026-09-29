import type { MeetingGroundTruth } from "../../../lib/execution-intelligence/eval-harness/ground-truth-schema";

/**
 * FROZEN ground truth for the "Meeting with Craig Aug 19" fixture, established after Generation-13
 * tuning/evaluation of the V4 two-step completeness architecture (see
 * docs/V4_BENCHMARK_CRAIG_AUG19_GEN13_FINAL.md for the full derivation).
 *
 * DO NOT ALTER without an explicit, separate instruction to update this fixture -- this file exists
 * specifically so future generations can be scored against a stable target, and a moving target
 * defeats the entire point of a regression fixture.
 *
 * `source_segment_ids` are real transcript_segments UUIDs, confirmed stable across generations 11,
 * 12, and 13 (the transcript itself never changes; only the model's extraction of it does).
 */
const craigAug19GroundTruth: MeetingGroundTruth = {
  meeting_id: "e9dcc8fe-0c79-47e6-a265-ae171b3478d5",
  meeting_title: "Meeting with Craig Aug 19",
  notes:
    "Long-running V4 tuning target across generations 6-13. Frozen after generation 13's Pass-A " +
    "verification/experiment harvesting improvements and the introduction of persisted Pass-A/Pass-B " +
    "trace observability. See docs/V4_BENCHMARK_CRAIG_AUG19_GEN13_FINAL.md.",
  ground_truth: [
    {
      id: "GT1",
      expected_state: "active",
      owners: ["Aditya Ujawane"],
      semantic_outcome:
        "Finish remaining Parfait security/account-isolation work, launch Parfait, and send the team a usable link.",
      source_segment_ids: ["b2de202c-47b5-4e84-a31f-7fa53216df1f"],
      notes:
        "Consistently healthy across generations 11-13. Final output sometimes splits into 2-3 " +
        "overlapping tasks/commitments about security/launch -- content is correct, some redundancy " +
        "is a task-consolidation-level observation outside completeness-recovery's scope."
    },
    {
      id: "GT2",
      expected_state: "active",
      owners: ["craiglauer", "Laura Wetherhold", "Jay"],
      semantic_outcome: "Use/test the Parfait prototype and provide feedback.",
      source_segment_ids: ["13877d33-8754-4925-bdbd-d8efb5ce465a"],
      notes:
        "\"...so we are going to play around with this on vercel laura and i and jay.\" Regressed once " +
        "(generation 11, lifecycle-repair miss) then recovered (generations 12-13). Usually resolved " +
        "via initial topic-scoped extraction, not completeness recovery."
    },
    {
      id: "GT3",
      expected_state: "active",
      owners: ["Laura Wetherhold"],
      semantic_outcome: "Finish current Chatter work, get Chatter back up, and confirm the drops flow works.",
      compound_outcomes: [
        "Finish current Chatter work and get Chatter back up",
        "Confirm the drops flow works"
      ],
      source_segment_ids: ["4a8ef80f-6525-4faf-817b-5d80401c57e1"],
      notes:
        "\"...i'll just kind of finish up what i was working on and then confirm that the drops " +
        "works...\" The GT3-B case across this whole tuning arc: Pass A has never independently split " +
        "\"confirm the drops flow works\" from the \"finish up what I was working on\" lead-in, in any " +
        "generation observed (9-13), including after the generation-12/13 verification-outcome prompt " +
        "strengthening. Generation 13 additionally showed a false Pass-B `already_represented` " +
        "judgment against an unrelated Chatter item (wi_6), so the drops-confirmation half currently " +
        "has ZERO representation. Only fully correct if BOTH sub-outcomes are independently found."
    },
    {
      id: "GT4",
      expected_state: "active",
      owners: ["Laura Wetherhold"],
      semantic_outcome: "Try the materiality/reversibility concept with her agent and observe how it works in practice.",
      source_segment_ids: [
        "57d601ff-97a1-4255-8a8e-3e78c688a338",
        "7b1828c2-5dc5-4e18-bb3f-77f420c1c006"
      ],
      notes:
        "\"yeah i can definitely talk to my agent about it ... i want to see how it's used in " +
        "practice...\" Missed entirely through generation 12 (zero Pass-A candidates despite the " +
        "evidence appearing in two overlapping harvest windows). Generation 13's verification/" +
        "experiment prompt strengthening produced two Pass-A candidates and two Pass-B adds, but only " +
        "one (the more tangential \"plan ordering tasks\" framing) reached eligibility -- the more " +
        "canonical candidate was written with work_item_role=idea, which is outside " +
        "isLifecycleReviewCandidate's classification set and so never gets a chance at repair."
    },
    {
      id: "GT5",
      expected_state: "active",
      // "iPhone" is a genuine alias, not a typo: this transcript's diarization sometimes labels
      // Craig by a device-based fallback instead of his name (confirmed via generation 12's
      // wi_g18.owner="craiglauer" vs generation 13's wi_g19.owner="iPhone" for the identical
      // real-world commitment). Listing both is an honest description of the data, not a hack to
      // force a match.
      owners: ["craiglauer", "iPhone"],
      semantic_outcome: "Send Laura the AI-engineer article.",
      source_segment_ids: ["cd402afd-2494-4c06-a17d-77ab1711992f"],
      notes:
        "\"i'll send you a link of an article that basically is like so what is an ai engineer what " +
        "skills do you need...\" Clean success in generation 12 (work_item_role=action, eligible, " +
        "persisted). Regressed in generation 13 -- harvested and added correctly, but Pass B wrote " +
        "work_item_role=idea this run, blocking eligibility. Ordinary Pass-B write variance, not a " +
        "Pass-A harvesting defect."
    },
    {
      id: "GT6",
      expected_state: "active",
      // See GT5's note -- same "iPhone" diarization alias applies to this speaker turn too.
      owners: ["craiglauer", "iPhone"],
      semantic_outcome: "Walk the incoming entrepreneurship cohort through product-founder fit.",
      source_segment_ids: ["2ef51ede-d89f-4dbb-81bc-64b2dbe74b92"],
      notes:
        "Consistently healthy across generations 12-13 -- the clearest atomicity win in this tuning " +
        "arc: a single dense compound turn (product-founder-fit walkthrough, sorting into houses, " +
        "leading/chaperoning) correctly split into 3 independent Pass-A candidates, all added, all " +
        "eligible."
    },
    {
      id: "NEG1",
      expected_state: "completed_during_meeting",
      owners: ["Aditya Ujawane"],
      semantic_outcome: "Demo the Parfait meeting-productivity tool for Craig.",
      source_segment_ids: [
        "72679006-db15-4b48-8cee-d78e1ce50455",
        "4ea116f4-3080-4262-adff-85e937ec2a74"
      ],
      notes:
        "Craig: \"...let's do a latest demo here.\" Aditya: \"yeah i'll share my screen.\" Verified as a " +
        "genuine, correct temporal completion in generation 13 (completionVerified=1, audited " +
        "directly against transcript text -- see docs/V4_BENCHMARK_CRAIG_AUG19_GEN13_FINAL.md CASE 9)."
    },
    {
      id: "NEG2",
      expected_state: "completed_during_meeting",
      owners: ["Aditya Ujawane"],
      semantic_outcome: "Restart/close Google Chrome to fix a memory issue during the meeting.",
      source_segment_ids: [
        "ec87e095-04f8-4b3f-81b6-56d4bae8ff9d",
        "6f8455f5-5722-45cb-8fd5-30df88c21714"
      ],
      notes:
        "Craig describes his own habit (\"i usually close google and restart it\"); Aditya accepts and " +
        "performs it in-meeting (\"yeah i'll do that actually start\"). Evidence-only fixture entry -- " +
        "exact completion segment not independently re-verified for every generation."
    },
    {
      id: "NEG3",
      expected_state: "completed_during_meeting",
      owners: ["Aditya Ujawane"],
      semantic_outcome: "Take a screenshot of the Parfait commitment-record interface.",
      source_segment_ids: ["3635293a-66fd-4f7b-924a-31102ab68090"],
      notes: "Aditya: \"yeah i'll take a screenshot ... of this actually.\""
    }
  ]
};

export default craigAug19GroundTruth;
