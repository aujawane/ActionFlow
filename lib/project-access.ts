import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask, Project } from "@/lib/types";

export async function getOwnedProject(projectId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("owner_id", userId)
    .maybeSingle();
  return data as Project | null;
}

export async function getOwnedCommitment(commitmentId: string, userId: string) {
  const { data: commitment } = await supabaseAdmin
    .from("meeting_commitments")
    .select("*")
    .eq("id", commitmentId)
    .maybeSingle();
  if (!commitment) return null;
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", commitment.meeting_id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return meeting ? (commitment as MeetingCommitment) : null;
}

export async function getOwnedTask(taskId: string, userId: string) {
  const { data: task } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return null;
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", task.meeting_id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return meeting ? (task as MeetingTask) : null;
}
