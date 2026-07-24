import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingAnalysisJob, MeetingAnalysisJobStatus } from "@/lib/types";

export const ANALYSIS_STAGES = {
  queued: { stage: "queued", progress: 0 },
  topic_extraction: { stage: "topic_extraction", progress: 10 },
  candidates: { stage: "candidates", progress: 30 },
  verification: { stage: "verification", progress: 50 },
  completeness: { stage: "completeness", progress: 65 },
  final_verification: { stage: "final_verification", progress: 80 },
  persistence: { stage: "persistence", progress: 90 },
  categorization: { stage: "categorization", progress: 95 },
  completed: { stage: "completed", progress: 100 }
} as const;

export type AnalysisStageKey = keyof typeof ANALYSIS_STAGES;

export const ANALYSIS_STAGE_ORDER = [
  "topic_extraction",
  "candidates",
  "verification",
  "completeness",
  "final_verification",
  "persistence"
] as const satisfies ReadonlyArray<AnalysisStageKey>;

export type WorkerAnalysisStage = (typeof ANALYSIS_STAGE_ORDER)[number];

export class StaleAnalysisError extends Error {
  constructor(message = "A newer meeting analysis superseded this result.") {
    super(message);
    this.name = "StaleAnalysisError";
  }
}

export async function claimMeetingAnalysisJob(meetingId: string): Promise<
  | { ok: true; jobId: string; generation: number }
  | { ok: false; error: string; details?: string }
> {
  const { data, error } = await supabaseAdmin.rpc("claim_meeting_analysis_job", {
    p_meeting_id: meetingId
  });
  if (error || !data || typeof data !== "object") {
    return {
      ok: false,
      error: "Failed to claim an analysis job.",
      details: error?.message ?? "The claim RPC returned an invalid value."
    };
  }

  const payload = data as { job_id?: string; generation?: number };
  if (typeof payload.job_id !== "string" || typeof payload.generation !== "number") {
    return {
      ok: false,
      error: "Failed to claim an analysis job.",
      details: "The claim RPC returned an incomplete payload."
    };
  }

  return {
    ok: true,
    jobId: payload.job_id,
    generation: payload.generation
  };
}

export async function getLatestMeetingAnalysisJob(
  meetingId: string
): Promise<MeetingAnalysisJob | null> {
  const { data, error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .select("*")
    .eq("meeting_id", meetingId)
    .order("generation", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return (data as MeetingAnalysisJob | null) ?? null;
}

export async function getMeetingAnalysisJob(
  jobId: string
): Promise<(MeetingAnalysisJob & { checkpoint?: Record<string, unknown> }) | null> {
  const { data, error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as (MeetingAnalysisJob & { checkpoint?: Record<string, unknown> }) | null) ?? null;
}

export async function assertAnalysisJobStillCurrent(input: {
  meetingId: string;
  jobId: string;
  generation: number;
}): Promise<void> {
  const [{ data: meeting, error: meetingError }, { data: job, error: jobError }] =
    await Promise.all([
      supabaseAdmin
        .from("meetings")
        .select("execution_graph_generation")
        .eq("id", input.meetingId)
        .is("deleted_at", null)
        .single(),
      supabaseAdmin
        .from("meeting_analysis_jobs")
        .select("id, status, generation")
        .eq("id", input.jobId)
        .single()
    ]);

  if (meetingError || !meeting) {
    throw new Error(meetingError?.message ?? "Meeting not found.");
  }
  if (jobError || !job) {
    throw new Error(jobError?.message ?? "Analysis job not found.");
  }

  const currentGeneration = Number(meeting.execution_graph_generation ?? 0);
  if (
    job.generation !== input.generation ||
    currentGeneration !== input.generation ||
    job.status === "stale"
  ) {
    await markAnalysisJobTerminal({
      jobId: input.jobId,
      status: "stale",
      stage: "stale",
      progress: 100,
      error: "Superseded by a newer analysis generation."
    });
    throw new StaleAnalysisError();
  }
}

export async function markAnalysisJobRunning(input: {
  jobId: string;
  stage: AnalysisStageKey;
  retryCount?: number;
  checkpoint?: Record<string, unknown>;
}) {
  const stageMeta = ANALYSIS_STAGES[input.stage];
  const patch: Record<string, unknown> = {
    status: "running" satisfies MeetingAnalysisJobStatus,
    current_stage: stageMeta.stage,
    progress: stageMeta.progress,
    error: null
  };
  if (typeof input.retryCount === "number") {
    patch.retry_count = input.retryCount;
  }
  if (input.checkpoint) {
    patch.checkpoint = input.checkpoint;
  }

  const { data: existing } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .select("started_at")
    .eq("id", input.jobId)
    .maybeSingle();
  if (!existing?.started_at) {
    patch.started_at = new Date().toISOString();
  }

  const { error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .update(patch)
    .eq("id", input.jobId)
    .in("status", ["queued", "running"]);
  if (error) throw new Error(error.message);
}

export async function saveAnalysisJobCheckpoint(input: {
  jobId: string;
  checkpoint: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .update({ checkpoint: input.checkpoint })
    .eq("id", input.jobId);
  if (error) throw new Error(error.message);
}

export async function markAnalysisJobTerminal(input: {
  jobId: string;
  status: Extract<MeetingAnalysisJobStatus, "completed" | "failed" | "stale">;
  stage?: string;
  progress?: number;
  error?: string | null;
}) {
  const { error } = await supabaseAdmin
    .from("meeting_analysis_jobs")
    .update({
      status: input.status,
      current_stage: input.stage ?? input.status,
      progress: input.progress ?? 100,
      error: input.error ?? null,
      completed_at: new Date().toISOString()
    })
    .eq("id", input.jobId)
    .neq("status", "completed");
  if (error) throw new Error(error.message);
}

export async function markAnalysisJobDispatchFailed(input: {
  jobId: string;
  error: string;
}) {
  await markAnalysisJobTerminal({
    jobId: input.jobId,
    status: "failed",
    stage: "failed",
    progress: 0,
    error: input.error
  });
}

export function nextWorkerStage(
  stage: WorkerAnalysisStage
): WorkerAnalysisStage | null {
  const index = ANALYSIS_STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= ANALYSIS_STAGE_ORDER.length - 1) return null;
  return ANALYSIS_STAGE_ORDER[index + 1] ?? null;
}
