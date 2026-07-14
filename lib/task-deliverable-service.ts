import {
  buildTaskCategorizationUpdate,
  categorizeTaskWithOpenAI
} from "@/lib/task-categorization";
import {
  getArtifactTypeLabel,
  getDeliverableTypeForCategory,
  getTaskCategorization,
  parseCategorizationMetadata,
  shouldReturnExistingDeliverable
} from "@/lib/task-deliverables";
import {
  generateTaskDeliverableDraft,
  getTaskWorkspaceContext,
  type TaskWorkspaceContext
} from "@/lib/task-workspace";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask, TaskArtifact, TaskCategorizationMetadata } from "@/lib/types";

export async function loadLatestDeliverableArtifact(taskId: string) {
  const { data, error } = await supabaseAdmin
    .from("task_artifacts")
    .select("*")
    .eq("task_id", taskId)
    .neq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { artifact: (data as TaskArtifact | null) ?? null, error };
}

export async function ensureTaskIsCategorized(
  taskId: string,
  userId: string,
  context?: TaskWorkspaceContext
) {
  let workspaceContext = context;
  if (!workspaceContext) {
    const result = await getTaskWorkspaceContext(taskId, userId);
    if (!result.ok) {
      return { ok: false as const, status: result.status, error: result.error };
    }
    workspaceContext = result.context;
  }

  const existing = parseCategorizationMetadata(
    workspaceContext.task.categorization_metadata
  );
  if (existing) {
    return {
      ok: true as const,
      task: workspaceContext.task,
      metadata: existing
    };
  }

  const meetingContext = workspaceContext.segments
    .slice(0, 12)
    .map((segment) => {
      const speaker = segment.speaker?.trim() || "Unknown speaker";
      return `${speaker}: ${segment.text.trim()}`;
    })
    .join("\n");

  const categorization = await categorizeTaskWithOpenAI({
    task: workspaceContext.task,
    meetingContext
  });

  const metadata = categorization.ok
    ? categorization.result
    : categorization.fallback;

  const { data: updatedTask, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update(buildTaskCategorizationUpdate(metadata))
    .eq("id", taskId)
    .select("*")
    .single();

  if (error || !updatedTask) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to save task categorization.",
      details: error?.message
    };
  }

  return {
    ok: true as const,
    task: updatedTask as MeetingTask,
    metadata
  };
}

export async function generateTaskDeliverable(input: {
  taskId: string;
  userId: string;
  regenerate?: boolean;
}) {
  const contextResult = await getTaskWorkspaceContext(input.taskId, input.userId);
  if (!contextResult.ok) {
    return {
      ok: false as const,
      status: contextResult.status,
      error: contextResult.error,
      details: contextResult.details
    };
  }

  const categorized = await ensureTaskIsCategorized(
    input.taskId,
    input.userId,
    contextResult.context
  );
  if (!categorized.ok) {
    return categorized;
  }

  const task = categorized.task;
  const metadata = getTaskCategorization(task);
  const deliverableType = metadata.deliverable_type;

  const { artifact: existingArtifact } = await loadLatestDeliverableArtifact(input.taskId);
  if (
    shouldReturnExistingDeliverable({
      regenerate: Boolean(input.regenerate),
      artifact: existingArtifact
    })
  ) {
    return {
      ok: true as const,
      task,
      artifact: existingArtifact!,
      metadata,
      reused: true
    };
  }

  const generation = await generateTaskDeliverableDraft({
    ...contextResult.context,
    task
  });

  if (!generation.ok) {
    const { data: failedArtifact } = await supabaseAdmin
      .from("task_artifacts")
      .insert({
        task_id: input.taskId,
        artifact_type: getArtifactTypeLabel(deliverableType),
        deliverable_type: deliverableType,
        title: getArtifactTypeLabel(deliverableType),
        content: generation.error,
        version: 1,
        status: "failed",
        metadata: {
          error: generation.error,
          details: generation.details ?? null
        }
      })
      .select("*")
      .single();

    return {
      ok: false as const,
      status: 502,
      error: generation.error,
      details: generation.details,
      task,
      artifact: (failedArtifact as TaskArtifact | null) ?? null,
      metadata
    };
  }

  const { data: latestArtifact } = await supabaseAdmin
    .from("task_artifacts")
    .select("version")
    .eq("task_id", input.taskId)
    .eq("deliverable_type", deliverableType)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const version =
    typeof latestArtifact?.version === "number" ? latestArtifact.version + 1 : 1;

  const { data: artifact, error: insertError } = await supabaseAdmin
    .from("task_artifacts")
    .insert({
      task_id: input.taskId,
      artifact_type: getArtifactTypeLabel(deliverableType),
      deliverable_type: deliverableType,
      title: generation.artifact.title,
      content: generation.artifact.content,
      version,
      status: "generated",
      metadata: {
        category: metadata.category,
        deliverable_type: deliverableType,
        generated_at: new Date().toISOString()
      }
    })
    .select("*")
    .single();

  if (insertError || !artifact) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to save generated deliverable.",
      details: insertError?.message,
      task,
      metadata
    };
  }

  return {
    ok: true as const,
    task,
    artifact: artifact as TaskArtifact,
    metadata,
    reused: false
  };
}

export function getDeliverableMetadataFromTask(
  task: MeetingTask
): TaskCategorizationMetadata {
  const parsed = parseCategorizationMetadata(task.categorization_metadata);
  if (parsed) return parsed;

  const category = getTaskCategorization(task).category;
  return {
    category,
    deliverable_type: getDeliverableTypeForCategory(category),
    confidence: task.confidence ?? 0,
    reason: "Derived from workspace type.",
    missing_info: [],
    suggested_button_label: getTaskCategorization(task).suggested_button_label
  };
}
