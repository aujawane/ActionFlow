import type { MeetingGroundTruth } from "../../../../../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { meetingId, meetingTitle } from "./transcript";

/**
 * FROZEN ground truth for synthetic benchmark Meeting 2 ("Engineering / Debugging"). Describes
 * scenario.md's intended semantic reality, independent of transcript.ts's literal wording and of
 * any extraction system's output.
 */
const meeting2GroundTruth: MeetingGroundTruth = {
  meeting_id: meetingId,
  meeting_title: meetingTitle,
  notes:
    "Synthetic, hand-authored benchmark meeting. Live incident/debugging call: two things get " +
    "fixed or diagnosed during the call itself, and the real follow-up commitments land in the " +
    "back half. See scenario.md for full design intent.",
  ground_truth: [
    {
      id: "SYN-M2-GT1",
      expected_state: "active",
      owners: ["Ravi"],
      semantic_outcome: "Add a timeout and retry around the S3 upload call in the export job.",
      source_segment_ids: ["SYN-M2-0028", "SYN-M2-0029"],
      notes: "The actual fix, distinct from the live worker restart (which only unblocked the current queue)."
    },
    {
      id: "SYN-M2-GT2",
      expected_state: "active",
      owners: ["Tom"],
      semantic_outcome: "Verify large-account exports succeed end to end in staging after the S3 timeout fix ships.",
      source_segment_ids: ["SYN-M2-0035", "SYN-M2-0037"],
      notes:
        "Sequencing/dependency precision test: this is explicitly a SEPARATE, LATER action from " +
        "SYN-M2-GT1 (the fix itself) -- deliberately done by a different person than the one who " +
        "wrote the fix. Must not collapse into GT1, and must not be scored as already satisfied by it."
    },
    {
      id: "SYN-M2-GT3",
      expected_state: "active",
      owners: ["Nadia"],
      semantic_outcome: "Add logging and an alert around export duration to catch timeouts before customers report them.",
      source_segment_ids: ["SYN-M2-0040", "SYN-M2-0042"]
    },
    {
      id: "SYN-M2-GT4",
      expected_state: "active",
      owners: ["Tom"],
      semantic_outcome: "Message the customer (Jensen) who reported the issue to let him know a fix is coming.",
      source_segment_ids: ["SYN-M2-0043", "SYN-M2-0044"]
    },
    {
      id: "SYN-M2-GT5",
      expected_state: "active",
      owners: ["Nadia"],
      semantic_outcome: "Finish checking whether the small-account export path has the same timeout risk.",
      source_segment_ids: ["SYN-M2-0050", "SYN-M2-0052", "SYN-M2-0053"],
      notes:
        "STARTED BUT STILL OPEN: she begins this investigation during the call itself but " +
        "explicitly does not finish ('I didn't get all the way through checking it, I'll pick that " +
        "up after this call'). This is continuing work, not a brand-new ask, and not a completed " +
        "action -- a correct extraction must leave this active, not completed, and not missed as " +
        "'already done because it was discussed in the meeting.'"
    },
    {
      id: "SYN-M2-COMPLETED1",
      expected_state: "completed_during_meeting",
      owners: ["Nadia"],
      semantic_outcome: "Diagnose the root cause of the export timeouts (unbounded S3 upload call on large files).",
      source_segment_ids: ["SYN-M2-0009", "SYN-M2-0012", "SYN-M2-0014", "SYN-M2-0016"],
      notes: "Genuine troubleshooting performed live on the call -- must not be left as open/future work."
    },
    {
      id: "SYN-M2-COMPLETED2",
      expected_state: "completed_during_meeting",
      owners: ["Ravi"],
      semantic_outcome: "Restart the stuck export worker to unblock the current queue.",
      source_segment_ids: ["SYN-M2-0022", "SYN-M2-0023", "SYN-M2-0024"],
      notes:
        "A real, completed mitigation action, distinct from SYN-M2-GT1 (the actual code fix). The " +
        "active follow-up fix (GT1) is the 'active follow-up created after an in-meeting fix' " +
        "lifecycle case for this meeting -- the restart unblocks things NOW, the timeout/retry " +
        "change prevents recurrence LATER; both must be represented, as different things."
    },
    {
      id: "SYN-M2-NEG1",
      expected_state: "negative",
      owners: ["Tom", "Ravi"],
      semantic_outcome: "Bump the export worker's memory limit as a fix for the timeout.",
      source_segment_ids: ["SYN-M2-0030", "SYN-M2-0032"],
      notes:
        "Explicitly discussed and explicitly REJECTED in the same breath ('that's just papering " +
        "over it, let's not do that'). Must not appear as a commitment for either Tom or Ravi."
    },
    {
      id: "SYN-M2-NEG2",
      expected_state: "negative",
      owners: ["Nadia", "Tom"],
      semantic_outcome: "Investigate the old exporter's timeout issue from six months ago.",
      source_segment_ids: ["SYN-M2-0046", "SYN-M2-0049"],
      notes:
        "Retrospective statement for color/context only ('didn't the old exporter have basically " +
        "this exact issue'), explicitly closed out with 'no action needed there, just funny " +
        "timing.' Must not be read as new work."
    }
  ]
};

export default meeting2GroundTruth;
