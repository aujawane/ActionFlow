import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

import { matchExecutionGraphRows } from "./matching";
import type { ExecutionGraph } from "./schemas";

export type PersistExecutionGraphResult =
  | {
      ok: true;
      commitments: MeetingCommitment[];
      tasks: MeetingTask[];
    }
  | { ok: false; error: string; details?: string; stale?: boolean };

export async function claimExecutionAnalysis(meetingId: string): Promise<
  | { ok: true; generation: number }
  | { ok: false; error: string; details?: string }
> {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_meeting_execution_analysis",
    { p_meeting_id: meetingId }
  );
  if (error || typeof data !== "number") {
    return {
      ok: false,
      error: "Failed to claim an execution analysis generation.",
      details: error?.message ?? "The generation RPC returned an invalid value."
    };
  }
  return { ok: true, generation: data };
}

export async function persistExecutionGraph(input: {
  meetingId: string;
  generation: number;
  graph: ExecutionGraph;
}): Promise<PersistExecutionGraphResult> {
  const [
    { data: existingCommitments, error: commitmentsLoadError },
    { data: existingTasks, error: tasksLoadError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meeting_commitments")
      .select("*")
      .eq("meeting_id", input.meetingId),
    supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("meeting_id", input.meetingId)
  ]);
  if (commitmentsLoadError || tasksLoadError) {
    return {
      ok: false,
      error: "Failed to load the existing execution graph for a safe merge.",
      details: commitmentsLoadError?.message ?? tasksLoadError?.message
    };
  }

  const matches = matchExecutionGraphRows({
    graph: input.graph,
    commitments: (existingCommitments ?? []) as MeetingCommitment[],
    tasks: (existingTasks ?? []) as MeetingTask[]
  });
  const commitmentsPayload = input.graph.commitments.map((commitment, index) => ({
    ...commitment,
    existing_id: matches.commitments.get(index) ?? null
  }));
  const tasksPayload = input.graph.tasks.map((task, index) => ({
    ...task,
    existing_id: matches.tasks.get(index) ?? null
  }));

  const { error: rpcError } = await supabaseAdmin.rpc(
    "replace_meeting_execution_graph",
    {
      p_meeting_id: input.meetingId,
      p_generation: input.generation,
      p_commitments: commitmentsPayload,
      p_tasks: tasksPayload
    }
  );

  if (rpcError) {
    const stale = rpcError.message.toLowerCase().includes("stale_analysis_run");
    return {
      ok: false,
      error: stale
        ? "A newer meeting analysis superseded this result."
        : "Failed to atomically persist the execution graph.",
      details: rpcError.message,
      stale
    };
  }

  const [
    { data: commitments, error: commitmentsError },
    { data: tasks, error: tasksError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meeting_commitments")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("created_at", { ascending: true })
  ]);

  if (commitmentsError || tasksError) {
    return {
      ok: false,
      error: "Execution graph was stored but could not be reloaded.",
      details: commitmentsError?.message ?? tasksError?.message
    };
  }

  return {
    ok: true,
    commitments: (commitments ?? []) as MeetingCommitment[],
    tasks: (tasks ?? []) as MeetingTask[]
  };
}
