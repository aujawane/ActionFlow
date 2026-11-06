import { start } from "workflow/api";

import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import { claimMeetingAnalysisJobV2 } from "@/lib/meeting-analysis/job-units";
import { isAnalysisPipelineV2EnabledForMeeting } from "@/lib/meeting-analysis/v2-activation";
import { meetingAnalysisV2Workflow } from "@/lib/meeting-analysis/workflow-v2";

export {
  ANALYSIS_PIPELINE_V2_STAGING_FLAG,
  isAnalysisPipelineV2EnabledForMeeting,
  isAnalysisPipelineV2StagingEnabled
} from "@/lib/meeting-analysis/v2-activation";

/** Pipeline v2 is opt-in per request, per allowlisted meeting (see v2-activation.ts). Normal
 * enqueueMeetingAnalysis (every product/webhook path) still claims v1. */
export async function enqueueMeetingAnalysisV2(meetingId: string) {
  if (!isAnalysisPipelineV2EnabledForMeeting(meetingId)) {
    return { ok: false as const, error: "Analysis pipeline v2 is not enabled." };
  }
  return enqueueMeetingAnalysis(meetingId, {
    claimJob: async (id) => {
      try {
        return { ok: true as const, ...(await claimMeetingAnalysisJobV2(id)) };
      } catch (error) {
        return {
          ok: false as const,
          error: "Failed to claim an analysis job.",
          details: error instanceof Error ? error.message : "The v2 claim RPC failed."
        };
      }
    },
    startWorker: async (id, jobId, generation) => {
      await start(meetingAnalysisV2Workflow, [{ meetingId: id, jobId, generation }]);
    }
  });
}
