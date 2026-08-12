import type { SupabaseClient } from "@supabase/supabase-js";

import { isCommittedWork, isTaskCountedForProgress } from "@/lib/execution-display";
import { isCommitmentCurrentGeneration } from "@/lib/execution-generation";
import type { Meeting, MeetingCommitment, MeetingTask } from "@/lib/types";

/**
 * Manual reclassification target. Deliberately narrower than the full
 * ExecutionClassification enum ("committed" | "proposed" | "requirement" |
 * "future_consideration") -- a user correction is a binary decision ("this is active work" vs
 * "this is future scope"), not a nuanced pick between the AI's three non-committed shades. The
 * extraction pipeline itself may still produce any of the four values; this module only ever
 * writes "committed" or "future_consideration".
 */
export type ManualClassificationTarget = "committed" | "future_consideration";

/**
 * Whether `destination` is a safe place to move `task` under the existing data model:
 * - a real, current-generation, non-dismissed, committed-classification commitment
 * - in the same project as the task (if the task is project-linked), otherwise the same meeting
 *   (the only shared context available for a meeting not yet assigned to a project)
 *
 * This intentionally does not check ownership -- callers must already have verified the caller
 * owns both the task and the destination commitment (see getOwnedTask/getOwnedCommitment).
 */
export function isEligibleMoveDestination(input: {
  task: Pick<MeetingTask, "meeting_id" | "project_id">;
  destination: Pick<
    MeetingCommitment,
    "id" | "title" | "meeting_id" | "project_id" | "status" | "execution_classification" | "metadata"
  >;
  destinationMeetingGeneration: number | null;
}): boolean {
  const { task, destination, destinationMeetingGeneration } = input;
  if (destination.status === "dismissed") return false;
  if (!isCommittedWork(destination)) return false;
  if (!isCommitmentCurrentGeneration(destination, destinationMeetingGeneration)) return false;

  if (task.project_id) {
    return destination.project_id === task.project_id;
  }
  return destination.meeting_id === task.meeting_id;
}

export function filterEligibleMoveDestinations(input: {
  task: Pick<MeetingTask, "meeting_id" | "project_id">;
  candidates: Array<
    Pick<
      MeetingCommitment,
      | "id"
      | "title"
      | "meeting_id"
      | "project_id"
      | "status"
      | "execution_classification"
      | "metadata"
    >
  >;
  meetingGenerationById: Map<string, number | null>;
}): typeof input.candidates {
  return input.candidates.filter((destination) =>
    isEligibleMoveDestination({
      task: input.task,
      destination,
      destinationMeetingGeneration: input.meetingGenerationById.get(destination.meeting_id) ?? null
    })
  );
}

/**
 * A commitment's "real" children for demotion purposes: current, committed, counted-for-progress
 * tasks -- the exact same filter computeCommitmentProgress uses to decide what belongs to a
 * commitment. If this is non-empty, moving the commitment to Future Scope would strand active
 * child work under a no-longer-active parent (see Phase 6 item 4's orphaning concern), so the
 * transition is not offered.
 */
export function getActiveChildTasks(
  commitment: Pick<MeetingCommitment, "id">,
  tasks: MeetingTask[]
): MeetingTask[] {
  return tasks.filter(
    (task) =>
      task.commitment_id === commitment.id &&
      isCommittedWork(task) &&
      isTaskCountedForProgress(task)
  );
}

export function canDemoteCommitmentToFutureScope(
  commitment: Pick<MeetingCommitment, "id">,
  tasks: MeetingTask[]
): boolean {
  return getActiveChildTasks(commitment, tasks).length === 0;
}

export type CorrectionEntityType = "task" | "commitment";

export type CorrectionEventType =
  | "task_moved_commitment"
  | "task_made_standalone"
  | "task_moved_future_scope"
  | "task_promoted_active"
  | "commitment_moved_future_scope"
  | "commitment_promoted_active"
  | "extraction_reported";

/**
 * Best-effort audit trail using the existing project_change_events table (see
 * 20260727130000_project_brain_phase1.sql) -- the same table Project Brain already writes to,
 * rather than a new correction-specific table. Scoped to project_id because that table requires
 * one; a task/commitment with no project assigned yet simply has no event logged (the
 * correction itself still succeeds -- this is telemetry, not the source of truth). Logging
 * failures must never block the correction itself.
 */
export async function logCorrectionEvent(
  supabaseAdmin: SupabaseClient,
  input: {
    projectId: string | null | undefined;
    actorId: string;
    eventType: CorrectionEventType;
    entityType: CorrectionEntityType;
    entityId: string;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
  }
): Promise<void> {
  if (!input.projectId) return;
  try {
    await supabaseAdmin.from("project_change_events").insert({
      project_id: input.projectId,
      actor_type: "user",
      actor_id: input.actorId,
      event_type: input.eventType,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before_state: input.beforeState ?? null,
      after_state: input.afterState ?? null,
      source_type: "manual"
    });
  } catch {
    // Telemetry only -- never fail the correction because the audit trail couldn't be written.
  }
}

export type MeetingGenerationLookup = Pick<Meeting, "id" | "execution_graph_generation">;

export function buildMeetingGenerationMap(meetings: MeetingGenerationLookup[]): Map<string, number | null> {
  return new Map(meetings.map((meeting) => [meeting.id, meeting.execution_graph_generation ?? null]));
}
