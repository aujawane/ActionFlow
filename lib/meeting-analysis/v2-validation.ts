import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import type { MeetingAnalysisJob } from "@/lib/types";

export function validateV2AnalysisJob(
  job: MeetingAnalysisJob | null,
  input: { jobId: string; meetingId: string; generation: number },
  currentGeneration: number | null
): asserts job is MeetingAnalysisJob {
  if (!job || job.id !== input.jobId || job.meeting_id !== input.meetingId) {
    throw new AnalysisUnitValidationError("Analysis job/meeting identity mismatch.");
  }
  if (job.pipeline_version !== 2 || job.checkpoint?.checkpointVersion !== 2) {
    throw new AnalysisUnitValidationError("V2 unit step requires pipeline/checkpoint version 2.");
  }
  if (job.generation !== input.generation || currentGeneration !== input.generation || job.status === "stale") {
    throw new AnalysisUnitValidationError("Stale analysis generation.");
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new AnalysisUnitValidationError("Analysis job is terminal.");
  }
}

/** Must run before model/platform side effects. SQL revalidates under locks at every write. */
export async function assertV2AnalysisJob(input: { jobId: string; meetingId: string; generation: number }) {
  const [job, { data: meeting, error }] = await Promise.all([
    getMeetingAnalysisJob(input.jobId),
    supabaseAdmin.from("meetings").select("execution_graph_generation")
      .eq("id", input.meetingId).is("deleted_at", null).maybeSingle()
  ]);
  if (error) throw new Error(error.message);
  validateV2AnalysisJob(job, input, meeting?.execution_graph_generation ?? null);
  return job;
}
