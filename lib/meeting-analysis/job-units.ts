import { supabaseAdmin } from "@/lib/supabase/admin";

export type UnitResult = null | boolean | number | string | UnitResult[] | { [key: string]: UnitResult };
export interface AnalysisJobUnit {
  job_id: string;
  stage: string;
  unit_key: string;
  status: "pending" | "running" | "completed" | "failed";
  result: UnitResult;
  error: string | null;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface AnalysisUnitIdentity {
  jobId: string;
  generation: number;
  stage: string;
  unitKey: string;
}
export class AnalysisUnitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisUnitValidationError";
  }
}

/** Explicit opt-in only. Callers must dispatch a v2 workflow, never the v1 worker. */
export async function claimMeetingAnalysisJobV2(meetingId: string): Promise<{ jobId: string; generation: number }> {
  const { data, error } = await supabaseAdmin.rpc("claim_meeting_analysis_job_v2", { p_meeting_id: meetingId });
  if (error) throw new Error(error.message);
  if (!data || typeof data.job_id !== "string" || typeof data.generation !== "number") {
    throw new Error("Invalid v2 claim RPC response.");
  }
  return { jobId: data.job_id, generation: data.generation };
}

/** Canonical server-only persistence boundary. Never writes the job checkpoint. */
export async function loadAnalysisJobUnit(input: AnalysisUnitIdentity): Promise<AnalysisJobUnit | null> {
  const { data, error } = await supabaseAdmin.from("meeting_analysis_job_units")
    .select("*").eq("job_id", input.jobId).eq("stage", input.stage)
    .eq("unit_key", input.unitKey).maybeSingle();
  if (error) throw new Error(error.message);
  return data as AnalysisJobUnit | null;
}
export async function listAnalysisStageUnits(jobId: string, stage: string): Promise<AnalysisJobUnit[]> {
  const { data, error } = await supabaseAdmin.from("meeting_analysis_job_units")
    .select("*").eq("job_id", jobId).eq("stage", stage).order("unit_key", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnalysisJobUnit[];
}
/** Returns a discriminated row, so an accepted JSON null is distinguishable from absence. */
export async function loadCompletedAnalysisUnit(input: AnalysisUnitIdentity) {
  const unit = await loadAnalysisJobUnit(input);
  return unit?.status === "completed" ? unit : null;
}
async function mutateUnit(
  rpc: string, input: AnalysisUnitIdentity & { attempt: number }, extra: Record<string, unknown> = {}
): Promise<AnalysisJobUnit> {
  const { data, error } = await supabaseAdmin.rpc(rpc, {
    p_job_id: input.jobId, p_generation: input.generation, p_pipeline_version: 2,
    p_stage: input.stage, p_unit_key: input.unitKey, p_attempt: input.attempt, ...extra
  });
  if (error) {
    if (["22023", "55000", "P0002"].includes(error.code)) {
      throw new AnalysisUnitValidationError(error.message);
    }
    throw new Error(error.message);
  }
  if (!data || typeof data !== "object") throw new Error("Invalid unit RPC response.");
  return data as AnalysisJobUnit;
}
export function markAnalysisUnitRunning(input: AnalysisUnitIdentity & { attempt: number }) {
  return mutateUnit("mark_meeting_analysis_job_unit_running", input);
}
export function completeAnalysisUnit(input: AnalysisUnitIdentity & { attempt: number; result: UnitResult }) {
  return mutateUnit("complete_meeting_analysis_job_unit", input, { p_result: input.result });
}
export function failAnalysisUnit(input: AnalysisUnitIdentity & { attempt: number; error: string }) {
  return mutateUnit("fail_meeting_analysis_job_unit", input, { p_error: input.error });
}
