import { inferAndApplyDependenciesForCommitment } from "@/lib/task-dependency-inference";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask, TaskDependency } from "@/lib/types";

/** Post-analysis, best-effort dependency inference for every commitment in a just-persisted
 * meeting graph -- mirrors lib/task-categorization-batch.ts's pattern (called once, right after
 * persistence, from the meeting analysis worker; never throws, never blocks the analysis job on
 * an OpenAI failure). v1 scope: tasks with a commitment_id only -- standalone tasks are not
 * considered (see final report: conservative v1, avoids cross-scope graph complexity). */
export async function runDependencyInferenceBestEffort(input: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  meetingContextByTopicId: Map<string, string>;
  currentGeneration?: number | null;
}) {
  const tasksByCommitmentId = new Map<string, MeetingTask[]>();
  for (const task of input.tasks) {
    if (!task.commitment_id) continue;
    const list = tasksByCommitmentId.get(task.commitment_id) ?? [];
    list.push(task);
    tasksByCommitmentId.set(task.commitment_id, list);
  }

  for (const commitment of input.commitments) {
    const commitmentTasks = tasksByCommitmentId.get(commitment.id) ?? [];
    if (commitmentTasks.length < 2) continue;

    try {
      const taskIds = commitmentTasks.map((task) => task.id);
      const { data: existingDependencies, error } = await supabaseAdmin
        .from("task_dependencies")
        .select("*")
        .in("task_id", taskIds);
      if (error) {
        console.warn("[runDependencyInferenceBestEffort] Failed to load existing dependencies", {
          commitment_id: commitment.id,
          error: error.message
        });
        continue;
      }

      const result = await inferAndApplyDependenciesForCommitment({
        commitment,
        tasks: commitmentTasks,
        existingDependencies: (existingDependencies ?? []) as TaskDependency[],
        meetingContextByTopicId: input.meetingContextByTopicId,
        currentGeneration: input.currentGeneration
      });
      if (!result.ok) {
        console.warn("[runDependencyInferenceBestEffort] Inference failed for commitment", {
          commitment_id: commitment.id,
          error: result.error,
          details: result.details
        });
      }
    } catch (error) {
      console.warn("[runDependencyInferenceBestEffort] Unexpected error for commitment", {
        commitment_id: commitment.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
