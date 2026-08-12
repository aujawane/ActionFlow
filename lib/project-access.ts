import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask, Project, TaskArtifact } from "@/lib/types";

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

/** Same ownership chain as getOwnedTask (artifact -> task -> meeting -> user), one hop further --
 * reused by every Phase 7 deliverable write path so accept/reopen/edit/restore can never act on
 * another user's task_artifacts row, matching the existing RLS policy's own chain. */
export async function getOwnedArtifact(artifactId: string, userId: string) {
  const { data: artifact } = await supabaseAdmin
    .from("task_artifacts")
    .select("*")
    .eq("id", artifactId)
    .maybeSingle();
  if (!artifact) return null;
  const task = await getOwnedTask(artifact.task_id, userId);
  return task ? { artifact: artifact as TaskArtifact, task } : null;
}
