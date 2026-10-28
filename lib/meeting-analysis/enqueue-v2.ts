import { start } from "workflow/api";

import { getSupabaseEnvironment } from "@/lib/env";
import { enqueueMeetingAnalysis } from "@/lib/meeting-analysis/enqueue";
import { claimMeetingAnalysisJobV2 } from "@/lib/meeting-analysis/job-units";
import { meetingAnalysisV2Workflow } from "@/lib/meeting-analysis/workflow-v2";

export const ANALYSIS_PIPELINE_V2_STAGING_FLAG = "ANALYSIS_PIPELINE_V2_STAGING_ENABLED";

/** Pipeline v2 is opt-in per request and only against the staging Supabase project. Normal
 * enqueueMeetingAnalysis (every product/webhook path) still claims v1. */
export function isAnalysisPipelineV2StagingEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env[ANALYSIS_PIPELINE_V2_STAGING_FLAG]?.trim() !== "true") return false;
  try {
    return getSupabaseEnvironment() === "staging";
  } catch {
    return false;
  }
}

export async function enqueueMeetingAnalysisV2(meetingId: string) {
  if (!isAnalysisPipelineV2StagingEnabled()) {
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
