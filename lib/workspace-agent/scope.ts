import { getOwnedCommitment, getOwnedMeeting, getOwnedProject, getOwnedTask } from "@/lib/project-access";

/**
 * Where a Parfait chat surface is "standing" -- which entity the user opened the chat from.
 * ALWAYS server-derived (see resolveWorkspaceScope below); a chat request body's own
 * projectId/meetingId/commitmentId/taskId fields, if a client ever sent any, must never be used
 * to construct one of these directly. Every field beyond the entity the surface is scoped to is
 * nullable context used only to decide which entities an operation may legitimately target (see
 * lib/workspace-agent/authorize.ts) -- not to re-derive ownership, which is always re-checked
 * fresh against the authenticated user at authorization time.
 */
export type WorkspaceScope =
  | { type: "project"; projectId: string }
  | { type: "meeting"; meetingId: string; projectId: string | null }
  | { type: "commitment"; commitmentId: string; meetingId: string; projectId: string | null }
  | { type: "task"; taskId: string; commitmentId: string | null; meetingId: string; projectId: string | null };

export type ResolveWorkspaceScopeResult =
  | { ok: true; scope: WorkspaceScope }
  | { ok: false; reason: "not_found" };

/**
 * The ONLY supported way to construct a WorkspaceScope. Takes the entity id a route already
 * trusts (the URL's own `[id]`, never a request-body field) and the authenticated user, and
 * walks the exact same ownership chains getOwnedCommitment/getOwnedTask/getOwnedMeeting/
 * getOwnedProject already use elsewhere in the app. A caller that doesn't own `id` gets
 * {ok:false, reason:"not_found"} -- the same response whether the id doesn't exist at all or
 * belongs to someone else, so this never leaks which case it was.
 */
export async function resolveWorkspaceScope(input: {
  type: WorkspaceScope["type"];
  id: string;
  userId: string;
}): Promise<ResolveWorkspaceScopeResult> {
  switch (input.type) {
    case "project": {
      const project = await getOwnedProject(input.id, input.userId);
      if (!project) return { ok: false, reason: "not_found" };
      return { ok: true, scope: { type: "project", projectId: project.id } };
    }
    case "meeting": {
      const meeting = await getOwnedMeeting(input.id, input.userId);
      if (!meeting) return { ok: false, reason: "not_found" };
      return {
        ok: true,
        scope: { type: "meeting", meetingId: meeting.id, projectId: meeting.project_id ?? null }
      };
    }
    case "commitment": {
      const commitment = await getOwnedCommitment(input.id, input.userId);
      if (!commitment) return { ok: false, reason: "not_found" };
      return {
        ok: true,
        scope: {
          type: "commitment",
          commitmentId: commitment.id,
          meetingId: commitment.meeting_id,
          projectId: commitment.project_id ?? null
        }
      };
    }
    case "task": {
      const task = await getOwnedTask(input.id, input.userId);
      if (!task) return { ok: false, reason: "not_found" };
      return {
        ok: true,
        scope: {
          type: "task",
          taskId: task.id,
          commitmentId: task.commitment_id ?? null,
          meetingId: task.meeting_id,
          projectId: task.project_id ?? null
        }
      };
    }
  }
}
