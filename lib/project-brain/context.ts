import { isCommitmentCurrentGeneration, isTaskCurrentGeneration } from "@/lib/execution-generation";
import { getOwnedProject } from "@/lib/project-access";
import { computeProjectProgress } from "@/lib/project-execution";
import { collectProjectPersonReferences } from "@/lib/project-brain/operations";
import type { ProjectPersonReference } from "@/lib/project-brain/schemas";
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
  personReferences?: ProjectPersonReference[];
  milestones: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  recentChanges: Array<Record<string, unknown>>;
  progress: { completed: number; total: number; percent: number };
  /** Commitment/task ids that exist in this project but were excluded from `milestones`/`tasks`
   * specifically because they belong to an older, superseded analysis generation -- never sent to
   * the model, only used by the proposal-apply route to tell "references a stale generated row"
   * (stale_execution_target) apart from "references something outside this project entirely." */
  staleMilestoneIds: Set<string>;
  staleTaskIds: Set<string>;
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
        "id,title,description,owner,owners,lead_owner_name,due_date,priority,status,completion_state,manual_override_fields,preserve_on_reanalysis,meeting_id,metadata,created_at"
      )
      .eq("project_id", projectId)
      .is("converted_to_task_id", null)
      .neq("status", "dismissed")
      .order("created_at", { ascending: true })
      .limit(50),
    supabaseAdmin
      .from("meeting_tasks")
      .select(
        "id,commitment_id,task,workspace_summary,owner,owners,due_date,priority,status,position,inferred,manual_override_fields,preserve_on_reanalysis,meeting_id,extraction_metadata,created_at"
      )
      .eq("project_id", projectId)
      .neq("status", "dismissed")
      .order("position", { ascending: true })
      .limit(200),
    supabaseAdmin
      .from("meetings")
      .select("id,title,created_at,status,execution_graph_generation")
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

  // Project Brain must reason over (and only be allowed to mutate -- see proposal-apply's
  // stale_execution_target guard) the meeting's current execution-graph generation, exactly like
  // the meeting UI (lib/execution-display.ts's partitionExecutionGraph) and project execution
  // aggregation (lib/project-execution.ts's buildProjectExecutionModel). Each commitment/task
  // belongs to a specific meeting, and each meeting has its own current generation, so the
  // comparison is per-row against its own meeting -- not a single project-wide number. Unstamped
  // rows (no analysis_generation at all -- manual records, or a prior Project Brain
  // create_milestone) are legacy/compatible and stay visible, per isCommitmentCurrentGeneration's
  // existing semantics.
  const currentGenerationByMeetingId = new Map(
    safeMeetings.map((meeting) => [meeting.id, meeting.execution_graph_generation ?? null])
  );
  const allCommitments = (commitments ?? []) as MeetingCommitment[];
  const allTasks = (tasks ?? []) as MeetingTask[];
  const safeCommitments = allCommitments.filter((commitment) =>
    isCommitmentCurrentGeneration(commitment, currentGenerationByMeetingId.get(commitment.meeting_id) ?? null)
  );
  const safeTasks = allTasks.filter((task) =>
    isTaskCurrentGeneration(task, currentGenerationByMeetingId.get(task.meeting_id) ?? null)
  );
  // The conversational graph remains bounded above, but a project-wide identity correction must
  // audit every People source used by Project Workspace, not just the first 50/200 graph rows.
  const [
    { data: identityMeetings },
    { data: identityCommitments },
    { data: identityTasks },
    { data: identityProjectParticipants }
  ] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("id,execution_graph_generation")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .is("deleted_at", null),
    supabaseAdmin
      .from("meeting_commitments")
      .select("id,meeting_id,title,owner,owners,lead_owner_name,metadata")
      .eq("project_id", projectId)
      .is("converted_to_task_id", null)
      .neq("status", "dismissed"),
    supabaseAdmin
      .from("meeting_tasks")
      .select("id,meeting_id,task,owner,owners,extraction_metadata")
      .eq("project_id", projectId)
      .neq("status", "dismissed"),
    supabaseAdmin
      .from("project_participants")
      .select("id,participant_name")
      .eq("project_id", projectId)
  ]);
  const identityGenerationByMeetingId = new Map(
    (identityMeetings ?? []).map((meeting) => [
      meeting.id,
      meeting.execution_graph_generation ?? null
    ])
  );
  const currentIdentityCommitments = ((identityCommitments ?? []) as MeetingCommitment[]).filter(
    (commitment) => isCommitmentCurrentGeneration(
      commitment,
      identityGenerationByMeetingId.get(commitment.meeting_id) ?? null
    )
  );
  const currentIdentityTasks = ((identityTasks ?? []) as MeetingTask[]).filter(
    (task) => isTaskCurrentGeneration(
      task,
      identityGenerationByMeetingId.get(task.meeting_id) ?? null
    )
  );
  const safeCommitmentIds = currentIdentityCommitments.map((commitment) => commitment.id);
  const identityMeetingIds = (identityMeetings ?? []).map((meeting) => meeting.id);
  const [{ data: commitmentParticipants }, { data: speakerAliases }] =
    await Promise.all([
      safeCommitmentIds.length
        ? supabaseAdmin
            .from("commitment_participants")
            .select("id,commitment_id,participant_name")
            .in("commitment_id", safeCommitmentIds)
        : Promise.resolve({ data: [] }),
      identityMeetingIds.length
        ? supabaseAdmin
            .from("meeting_speaker_aliases")
            .select("id,meeting_id,raw_speaker_label,display_name")
            .in("meeting_id", identityMeetingIds)
        : Promise.resolve({ data: [] })
    ]);
  const commitmentTitleById = new Map(
    currentIdentityCommitments.map((commitment) => [commitment.id, commitment.title])
  );
  const personReferences = collectProjectPersonReferences({
    tasks: currentIdentityTasks as unknown as Array<Record<string, unknown>>,
    commitments: currentIdentityCommitments as unknown as Array<Record<string, unknown>>,
    projectParticipants: (identityProjectParticipants ?? []) as Array<Record<string, unknown>>,
    commitmentParticipants: ((commitmentParticipants ?? []) as Array<Record<string, unknown>>).map(
      (participant) => ({
        ...participant,
        label: commitmentTitleById.get(String(participant.commitment_id)) ??
          String(participant.participant_name)
      })
    ),
    speakerAliases: (speakerAliases ?? []) as Array<Record<string, unknown>>
  });
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
    personReferences,
    // metadata/extraction_metadata were only fetched to compute generation currency above --
    // strip them back out so the raw internal JSONB blob never enters the model's context.
    milestones: safeCommitments.map((commitment) => {
      const { metadata, ...rest } = commitment;
      void metadata;
      return rest;
    }) as Array<Record<string, unknown>>,
    tasks: safeTasks.map((task) => {
      const { extraction_metadata, ...rest } = task;
      void extraction_metadata;
      return rest;
    }) as Array<Record<string, unknown>>,
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
    }),
    staleMilestoneIds: new Set(
      allCommitments
        .filter((commitment) => !safeCommitments.some((current) => current.id === commitment.id))
        .map((commitment) => commitment.id)
    ),
    staleTaskIds: new Set(
      allTasks
        .filter((task) => !safeTasks.some((current) => current.id === task.id))
        .map((task) => task.id)
    )
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
