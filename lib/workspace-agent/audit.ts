import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Generalized audit writer for AI-executed workspace operations -- reuses project_change_events
 * (see supabase/migrations/20261009090000_generalize_project_change_events_scope.sql, which made
 * project_id nullable and added meeting_id so a meeting-scoped execution on a project-less
 * meeting still gets a row) rather than a parallel table. actor_type is always "assistant" here
 * -- the user asked for the change, but the execution actor performing the write is the
 * assistant, never "user" (contrast lib/execution-corrections.ts's logCorrectionEvent, which is
 * for direct human UI actions and correctly uses actor_type "user").
 *
 * entity_type here uses the real product vocabulary ("commitment", not Project Brain's legacy
 * "milestone" jargon) -- a harmless naming difference from older apply_project_change_proposal-
 * authored rows in this same table, not a functional inconsistency, since nothing reads this
 * table with an exact entity_type match today.
 *
 * Best-effort: a failed audit insert must never cause an already-successful mutation to be
 * reported as failed, so this never throws -- it logs and swallows.
 */
export type WorkspaceAuditSourceType = "meeting" | "project_chat" | "manual" | "integration";
export type WorkspaceAuditEntityType = "commitment" | "task" | "project";

export type WorkspaceAuditEvent = {
  actorId: string;
  projectId: string | null;
  meetingId: string | null;
  entityType: WorkspaceAuditEntityType;
  entityId: string;
  eventType: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  sourceType: WorkspaceAuditSourceType;
  sourceId: string | null;
};

export async function recordWorkspaceAuditEvent(event: WorkspaceAuditEvent): Promise<void> {
  const { error } = await supabaseAdmin.from("project_change_events").insert({
    project_id: event.projectId,
    meeting_id: event.meetingId,
    proposal_id: null,
    actor_type: "assistant",
    actor_id: event.actorId,
    event_type: event.eventType,
    entity_type: event.entityType,
    entity_id: event.entityId,
    before_state: event.beforeState,
    after_state: event.afterState,
    source_type: event.sourceType,
    source_id: event.sourceId
  });
  if (error) {
    console.error("[workspace-agent] failed to record audit event", {
      entity_type: event.entityType,
      entity_id: event.entityId,
      event_type: event.eventType,
      error: error.message
    });
  }
}
