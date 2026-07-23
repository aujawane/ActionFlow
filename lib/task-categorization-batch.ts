import {
  buildTaskCategorizationUpdate,
  categorizeTasksBatchWithOpenAI
} from "@/lib/task-categorization";
import { buildFallbackCategorization } from "@/lib/task-deliverables";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask } from "@/lib/types";

export async function categorizeMeetingTasksBestEffort(input: {
  tasks: MeetingTask[];
  meetingContextByTopicId: Map<string, string>;
}) {
  if (input.tasks.length === 0) return;

  const batchInput = input.tasks.map((task) => ({
    task,
    meetingContext: task.topic_id
      ? input.meetingContextByTopicId.get(task.topic_id) ?? ""
      : ""
  }));

  const batch = await categorizeTasksBatchWithOpenAI({ tasks: batchInput });
  const resultsByTaskId = new Map(
    batch.ok
      ? batch.results.map((result) => [result.taskId, result.metadata])
      : []
  );

  for (const task of input.tasks) {
    const metadata =
      resultsByTaskId.get(task.id) ??
      buildFallbackCategorization(
        batch.ok
          ? "Task was not returned in batch categorization."
          : batch.error
      );

    const { error } = await supabaseAdmin
      .from("meeting_tasks")
      .update(buildTaskCategorizationUpdate(metadata))
      .eq("id", task.id);

    if (error) {
      console.warn("[categorizeMeetingTasksBestEffort] Failed to save categorization", {
        task_id: task.id,
        error: error.message
      });
    }
  }
}
