import { getOwnedProject } from "@/lib/project-access";
import { computeProjectProgress } from "@/lib/project-execution";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  Meeting,
  MeetingCommitment,
  MeetingTask,
  Project
} from "@/lib/types";

export type ProjectBrainContext = {
  project: Project & { execution_graph_version?: number };
  memory: Record<string, unknown> | null;
  requirements: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  participants: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  recentChanges: Array<Record<string, unknown>>;
  progress: { completed: number; total: number; percent: number };
};

export async function buildProjectBrainContext(
  projectId: string,
  userId: string
): Promise<ProjectBrainContext | null> {
  const project = await getOwnedProject(projectId, userId);
  if (!project) return null;

  const [
    { data: memory },
    { data: requirements },
    { data: decisions },
    { data: constraints },
    { data: participants },
    { data: commitments },
    { data: tasks },
    { data: meetings },
    { data: recentChanges }
  ] = await Promise.all([
    supabaseAdmin
      .from("project_memory")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle(),
    supabaseAdmin
      .from("project_requirements")
      .select("*")
      .eq("project_id", projectId)
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("project_decisions")
      .select("*")
      .eq("project_id", projectId)
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("project_constraints")
      .select("*")
      .eq("project_id", projectId)
      .in("status", ["active", "resolved"])
      .order("updated_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("project_participants")
      .select("*")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("meeting_commitments")
      .select(
        "id,title,description,owner,owners,due_date,priority,status,completion_state,manual_override_fields,preserve_on_reanalysis,meeting_id,created_at"
      )
      .eq("project_id", projectId)
      .is("converted_to_task_id", null)
      .neq("status", "dismissed")
      .order("created_at", { ascending: true })
      .limit(50),
    supabaseAdmin
      .from("meeting_tasks")
      .select(
        "id,commitment_id,task,workspace_summary,owner,owners,due_date,priority,status,position,inferred,manual_override_fields,preserve_on_reanalysis,meeting_id,created_at"
      )
      .eq("project_id", projectId)
      .neq("status", "dismissed")
      .order("position", { ascending: true })
      .limit(200),
    supabaseAdmin
      .from("meetings")
      .select("id,title,created_at,status")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
    supabaseAdmin
      .from("project_change_events")
      .select(
        "id,event_type,entity_type,entity_id,source_type,source_id,created_at,after_state"
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20)
  ]);

  const safeMeetings = (meetings ?? []) as Meeting[];
  const meetingIds = safeMeetings.map((meeting) => meeting.id);
  const { data: summaries } = meetingIds.length
    ? await supabaseAdmin
        .from("extracted_insights")
        .select("meeting_id,content,created_at")
        .in("meeting_id", meetingIds)
        .eq("category", "product_summary")
        .order("created_at", { ascending: false })
        .limit(40)
    : { data: [] };
  const summaryByMeeting = new Map<string, string>();
  for (const summary of summaries ?? []) {
    if (!summaryByMeeting.has(summary.meeting_id)) {
      summaryByMeeting.set(summary.meeting_id, summary.content);
    }
  }

  const safeCommitments = (commitments ?? []) as MeetingCommitment[];
  const safeTasks = (tasks ?? []) as MeetingTask[];
  const people = new Map<string, string>();
  for (const item of [...safeCommitments, ...safeTasks]) {
    for (const owner of [
      item.owner,
      ...(Array.isArray(item.owners) ? item.owners : [])
    ]) {
      if (typeof owner === "string" && owner.trim()) {
        people.set(owner.trim().toLowerCase(), owner.trim());
      }
    }
  }

  return {
    project: project as Project & { execution_graph_version?: number },
    memory: (memory as Record<string, unknown> | null) ?? null,
    requirements: (requirements ?? []) as Array<Record<string, unknown>>,
    decisions: (decisions ?? []) as Array<Record<string, unknown>>,
    constraints: (constraints ?? []) as Array<Record<string, unknown>>,
    participants: [
      ...((participants ?? []) as Array<Record<string, unknown>>),
      ...Array.from(people.values()).map((participant_name) => ({
        participant_name,
        source_type: "execution_owner"
      }))
    ],
    milestones: (commitments ?? []) as Array<Record<string, unknown>>,
    tasks: (tasks ?? []) as Array<Record<string, unknown>>,
    meetings: safeMeetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      date: meeting.created_at,
      status: meeting.status,
      summary: summaryByMeeting.get(meeting.id) ?? null
    })),
    recentChanges: (recentChanges ?? []) as Array<Record<string, unknown>>,
    progress: computeProjectProgress({
      commitments: safeCommitments,
      tasks: safeTasks
    })
  };
}

export function buildMeetingProjectMemoryContext(
  context: ProjectBrainContext | null
) {
  if (!context) return null;
  return {
    project_id: context.project.id,
    name: context.project.name,
    goal: context.memory?.goal ?? context.project.goal,
    summary: context.memory?.summary ?? context.project.description,
    current_scope: context.memory?.current_scope ?? [],
    future_scope: context.memory?.future_scope ?? [],
    technical_context: context.memory?.technical_context ?? {},
    constraints: context.constraints
      .filter((constraint) => constraint.status === "active")
      .map(({ id, title, description, category, manually_confirmed }) => ({
        id,
        title,
        description,
        category,
        manually_confirmed
      })),
    active_decisions: context.decisions
      .filter((decision) => decision.status === "active")
      .map(({ id, title, description, manually_confirmed }) => ({
        id,
        title,
        description,
        manually_confirmed
      })),
    confirmed_fields: context.memory?.confirmed_fields ?? {}
  };
}
