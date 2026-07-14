import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseTaskCommentMetadata } from "@/lib/task-comment-metadata";
import type { Meeting, MeetingTask, TaskComment } from "@/lib/types";

export async function getAccessibleTask(taskId: string, userId: string) {
  const { data: task, error: taskError } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", taskId)
    .single();
  if (taskError || !task) {
    return { task: null, meeting: null, error: taskError };
  }

  const typedTask = task as MeetingTask;
  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", typedTask.meeting_id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();

  return {
    task: meeting ? typedTask : null,
    meeting: meeting ? (meeting as Meeting) : null,
    error: meetingError
  };
}

export async function getTaskComments(taskId: string) {
  const { data, error } = await supabaseAdmin
    .from("task_comments")
    .select("id, task_id, user_id, role, message, metadata, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });
  return {
    comments: (data ?? []).map((comment) => ({
      ...comment,
      metadata: parseTaskCommentMetadata(comment.metadata)
    })) as TaskComment[],
    error
  };
}

export async function getTaskTranscriptSnippets(task: MeetingTask) {
  const { data: topic } = await supabaseAdmin
    .from("meeting_topics")
    .select("segment_ids")
    .eq("id", task.topic_id)
    .eq("meeting_id", task.meeting_id)
    .maybeSingle();
  const segmentIds = Array.isArray(topic?.segment_ids)
    ? topic.segment_ids.filter((value): value is string => typeof value === "string")
    : [];

  let query = supabaseAdmin
    .from("transcript_segments")
    .select("speaker, text, timestamp")
    .eq("meeting_id", task.meeting_id)
    .order("timestamp", { ascending: true })
    .limit(12);
  if (segmentIds.length > 0) {
    query = query.in("id", segmentIds);
  }

  const { data, error } = await query;
  if (error) return { snippets: [], error };
  return {
    snippets: (data ?? []).map((segment) => {
      const speaker = segment.speaker?.trim() || "Unknown Speaker";
      const text = segment.text?.trim().replace(/\s+/g, " ") || "";
      return `${speaker}: ${text.slice(0, 600)}`;
    }),
    error: null
  };
}
