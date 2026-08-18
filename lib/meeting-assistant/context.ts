import { partitionExecutionGraph, commitmentProgress } from "@/lib/execution-display";
import { buildMeetingParticipantOptions } from "@/lib/meeting-participants";
import { getSuggestedSteps } from "@/lib/task-workspace";
import { getDeliverableLifecycleState, groupDeliverablesByType } from "@/lib/task-deliverable-lifecycle";
import type {
  ExtractedInsight,
  Meeting,
  MeetingCommitment,
  MeetingTask,
  MeetingTopic,
  Project,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

/** Grounded, structured meeting context for "Ask Parfait" -- built once per message, server-side
 * only (see lib/meeting-assistant/agent.ts). Reuses the same canonical helpers every other
 * execution surface uses (partitionExecutionGraph, commitmentProgress, groupDeliverablesByType,
 * buildMeetingParticipantOptions) so this never becomes a second, drifting source of truth for
 * "what is current" -- current-generation filtering, Future Scope classification, and progress
 * math are identical to Commitment Workspace / the Meeting Detail page. This module never calls
 * OpenAI and never touches transcript_segments (see transcript-selection.ts for that, invoked
 * conditionally by the routing layer) -- it is pure, deterministic, and independently testable. */

const MAX_TOPICS = 15;
const MAX_INSIGHTS = 20;
const MAX_TEXT_LENGTH = 500;
const MAX_QUOTE_LENGTH = 300;

function truncate(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type AcceptanceCriterion = { title: string };

/** V4 stores acceptance criteria in commitment.metadata (see execution-graph-v4.ts); mirrors the
 * identical small extraction already duplicated in commitments-panel.tsx and
 * task-dependency-inference.ts rather than introducing a shared import across UI/lib layers. */
function extractAcceptanceCriteria(commitment: MeetingCommitment): string[] {
  const metadata = commitment.metadata as { acceptance_criteria?: unknown } | null;
  const raw = metadata?.acceptance_criteria;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is AcceptanceCriterion =>
        Boolean(item) && typeof item === "object" && typeof (item as { title?: unknown }).title === "string"
    )
    .map((item) => item.title);
}

export type MeetingAssistantContextInput = {
  meeting: Meeting;
  project: Pick<Project, "id" | "name"> | null;
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  dependencies: TaskDependency[];
  artifacts: TaskArtifact[];
  transcriptParticipants: Array<{ participant_name: string | null; speaker: string | null }>;
  topics: MeetingTopic[];
  insights: ExtractedInsight[];
};

export type MeetingAssistantExecutionContext = {
  meeting: {
    id: string;
    title: string | null;
    date: string;
    platform: string;
    status: string;
    project: string | null;
    participants: string[];
  };
  commitments: Array<{
    id: string;
    title: string;
    description: string | null;
    owner: string | null;
    supporting_people: string[];
    status: string;
    due_date: string | null;
    priority: string;
    acceptance_criteria: string[];
    progress: { completed: number; total: number; percent: number };
  }>;
  tasks: Array<{
    id: string;
    title: string;
    commitment_id: string | null;
    commitment_title: string | null;
    scope: "linked" | "standalone";
    owner: string | null;
    status: string;
    due_date: string | null;
    priority: string;
    suggested_next_steps: string[];
    is_blocked: boolean;
    blocked_by: string | null;
    source_quote: string | null;
  }>;
  future_scope: Array<{
    type: "commitment" | "task";
    title: string;
    description: string | null;
    owner: string | null;
  }>;
  topics: Array<{ title: string; summary: string | null }>;
  decisions: string[];
  insights: Array<{ category: string; content: string }>;
  deliverables: Array<{
    task_id: string;
    task_title: string;
    deliverable_type: string;
    title: string;
    state: "draft" | "accepted" | "failed";
  }>;
};

export function buildMeetingAssistantExecutionContext(
  input: MeetingAssistantContextInput
): MeetingAssistantExecutionContext {
  const currentGeneration = input.meeting.execution_graph_generation ?? null;
  const partitioned = partitionExecutionGraph({
    commitments: input.commitments,
    tasks: input.tasks,
    currentGeneration
  });

  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const commitmentById = new Map(input.commitments.map((commitment) => [commitment.id, commitment]));

  function blockerFor(taskId: string) {
    const dependency = input.dependencies.find((item) => item.task_id === taskId);
    if (!dependency) return null;
    const prerequisite = taskById.get(dependency.depends_on_task_id);
    if (!prerequisite || prerequisite.status === "completed") return null;
    return prerequisite;
  }

  const participants = buildMeetingParticipantOptions({
    transcriptSegments: input.transcriptParticipants,
    tasks: input.tasks,
    commitments: input.commitments
  });

  const commitments = partitioned.activeCommitments.map((commitment) => {
    const progress = commitmentProgress(commitment, input.tasks);
    return {
      id: commitment.id,
      title: commitment.title,
      description: truncate(commitment.description, MAX_TEXT_LENGTH),
      owner: commitment.lead_owner_name ?? commitment.owner,
      supporting_people: stringArray(commitment.owners),
      status: commitment.status,
      due_date: commitment.due_date,
      priority: commitment.priority,
      acceptance_criteria: extractAcceptanceCriteria(commitment),
      progress
    };
  });

  const linkedAndStandalone = [...partitioned.linkedExecutionTasks, ...partitioned.standaloneTasks];
  const tasks = linkedAndStandalone.map((task) => {
    const blocker = blockerFor(task.id);
    const commitment = task.commitment_id ? commitmentById.get(task.commitment_id) : null;
    return {
      id: task.id,
      title: task.task,
      commitment_id: task.commitment_id ?? null,
      commitment_title: commitment?.title ?? null,
      scope: task.commitment_id ? ("linked" as const) : ("standalone" as const),
      owner: task.owner,
      status: task.status,
      due_date: task.due_date ?? null,
      priority: task.priority,
      suggested_next_steps: getSuggestedSteps(task.suggested_steps),
      is_blocked: Boolean(blocker),
      blocked_by: blocker?.task ?? null,
      source_quote: truncate(task.source_quote, MAX_QUOTE_LENGTH)
    };
  });

  const future_scope: MeetingAssistantExecutionContext["future_scope"] = [
    ...partitioned.ideaCommitments.map((commitment) => ({
      type: "commitment" as const,
      title: commitment.title,
      description: truncate(commitment.description, MAX_TEXT_LENGTH),
      owner: commitment.lead_owner_name ?? commitment.owner
    })),
    ...partitioned.ideaTasks.map((task) => ({
      type: "task" as const,
      title: task.task,
      description: truncate(task.workspace_summary, MAX_TEXT_LENGTH),
      owner: task.owner
    }))
  ];

  const topics = input.topics.slice(0, MAX_TOPICS).map((topic) => ({
    title: topic.title,
    summary: truncate(topic.summary, MAX_TEXT_LENGTH)
  }));

  const decisions = input.insights
    .filter((insight) => insight.category === "decisions")
    .slice(0, MAX_INSIGHTS)
    .map((insight) => truncate(insight.content, MAX_TEXT_LENGTH) ?? "");

  const insights = input.insights
    .filter((insight) => insight.category !== "decisions")
    .slice(0, MAX_INSIGHTS)
    .map((insight) => ({
      category: insight.category,
      content: truncate(insight.content, MAX_TEXT_LENGTH) ?? ""
    }));

  // Current deliverable only per (task, deliverable_type) -- never historical versions, matching
  // Phase 7's own "current" definition (see groupDeliverablesByType).
  const artifactsByTaskId = new Map<string, TaskArtifact[]>();
  for (const artifact of input.artifacts) {
    const list = artifactsByTaskId.get(artifact.task_id) ?? [];
    list.push(artifact);
    artifactsByTaskId.set(artifact.task_id, list);
  }
  const deliverables: MeetingAssistantExecutionContext["deliverables"] = [];
  for (const [taskId, taskArtifacts] of artifactsByTaskId.entries()) {
    const task = taskById.get(taskId);
    if (!task) continue;
    for (const group of groupDeliverablesByType(taskArtifacts)) {
      if (!group.current) continue;
      deliverables.push({
        task_id: taskId,
        task_title: task.task,
        deliverable_type: group.deliverableType,
        title: group.current.title,
        state: getDeliverableLifecycleState(group.current)
      });
    }
  }

  return {
    meeting: {
      id: input.meeting.id,
      title: input.meeting.title,
      date: input.meeting.created_at,
      platform: input.meeting.platform,
      status: input.meeting.status,
      project: input.project?.name ?? null,
      participants
    },
    commitments,
    tasks,
    future_scope,
    topics,
    decisions,
    insights,
    deliverables
  };
}
