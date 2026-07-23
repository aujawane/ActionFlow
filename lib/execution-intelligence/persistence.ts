import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

import type { ExecutionGraph } from "./schemas";

export type PersistExecutionGraphResult =
  | {
      ok: true;
      commitments: MeetingCommitment[];
      tasks: MeetingTask[];
    }
  | { ok: false; error: string; details?: string };

export async function persistExecutionGraph(input: {
  meetingId: string;
  graph: ExecutionGraph;
}): Promise<PersistExecutionGraphResult> {
  const { error: rpcError } = await supabaseAdmin.rpc(
    "replace_meeting_execution_graph",
    {
      p_meeting_id: input.meetingId,
      p_commitments: input.graph.commitments,
      p_tasks: input.graph.tasks
    }
  );

  if (rpcError) {
    return {
      ok: false,
      error: "Failed to atomically persist the execution graph.",
      details: rpcError.message
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
