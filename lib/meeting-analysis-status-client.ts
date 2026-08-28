import type { MeetingAnalysisJobStatus } from "@/lib/types";

/**
 * Pure client-side decision logic for components/meeting-analysis-status.tsx, extracted so the
 * polling/refresh transitions are unit-testable without a React rendering harness.
 */

export const ACTIVE_ANALYSIS_JOB_STATUSES: MeetingAnalysisJobStatus[] = ["queued", "running"];

/** Whether the status panel should keep polling, given the latest known job status and the
 * meeting's own status. A terminal job status (completed/failed/stale) always stops polling. */
export function shouldPollAnalysisStatus(input: {
  jobStatus: MeetingAnalysisJobStatus | null;
  meetingStatus: string;
}): boolean {
  return (
    ACTIVE_ANALYSIS_JOB_STATUSES.includes(input.jobStatus ?? "queued") ||
    (input.meetingStatus === "transcript_ready" && !input.jobStatus)
  );
}

export type AnalysisCompletionRefreshDecision =
  | { shouldRefresh: true; nextRefreshedJobId: string }
  | { shouldRefresh: false; nextRefreshedJobId: string | null };

/**
 * Decides whether a poll response should trigger exactly one router.refresh(): only the first
 * time a given job id is observed as "completed". The caller stores `nextRefreshedJobId` in a
 * ref (see refreshedForJobId in MeetingAnalysisStatusPanel) so repeated poll ticks for the same
 * already-refreshed job -- or a page that loads with an already-completed job -- never refresh
 * again. Any status other than "completed" (failed, stale, running, queued) never refreshes.
 */
export function decideAnalysisCompletionRefresh(input: {
  jobId: string | null | undefined;
  jobStatus: string | null | undefined;
  lastRefreshedJobId: string | null;
}): AnalysisCompletionRefreshDecision {
  if (input.jobStatus === "completed" && input.jobId && input.lastRefreshedJobId !== input.jobId) {
    return { shouldRefresh: true, nextRefreshedJobId: input.jobId };
  }
  return { shouldRefresh: false, nextRefreshedJobId: input.lastRefreshedJobId };
}
