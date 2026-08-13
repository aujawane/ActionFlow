import { notFound } from "next/navigation";

import { CommitmentsPanel } from "@/components/commitments-panel";
import { IdeasRequirementsPanel } from "@/components/ideas-requirements-panel";
import { InsightsPanel } from "@/components/insights-panel";
import { LiveMeetingStatusBadge } from "@/components/live-meeting-status-badge";
import { LiveTranscript } from "@/components/live-transcript";
import { MeetingActions } from "@/components/meeting-actions";
import { MeetingAnalysisStatusPanel } from "@/components/meeting-analysis-status";
import { MeetingAssistantPanel } from "@/components/meeting-assistant-panel";
import { MeetingProjectAssignment } from "@/components/meeting-project-assignment";
import { SpeakerMappingPanel } from "@/components/speaker-mapping-panel";
import { StandaloneTasksPanel } from "@/components/standalone-tasks-panel";
import { TopicResults } from "@/components/topic-results";
import { requireUser } from "@/lib/auth";
import { partitionExecutionGraph } from "@/lib/execution-display";
import { formatReadableDate } from "@/lib/format-date";
import { meetingPlatformLabel } from "@/lib/meeting-platform";
import { getLatestMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import { buildMeetingParticipantOptions } from "@/lib/meeting-participants";
import {
  applySpeakerAliases,
  applySpeakerAliasesToTasks,
  buildMeetingSpeakerRoster
} from "@/lib/speaker-aliases";
import { loadMeetingTasksWithFallback } from "@/lib/meeting-task-query";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";
import type {
  MeetingAnalysisJob,
  MeetingCommitment,
  MeetingSpeakerAlias,
  MeetingTask,
  MeetingTopic,
  Project,
  TranscriptSegment
} from "@/lib/types";

export const dynamic = "force-dynamic";

function isMissingRelationError(
  error: { code?: string; message?: string } | null,
  relation: string
) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  if (error.code === "PGRST205") return true;

  const message = error.message?.toLowerCase() ?? "";
  const normalizedRelation = relation.toLowerCase();
  return (
    message.includes(`relation "${normalizedRelation}" does not exist`) ||
    message.includes(`table "${normalizedRelation}" does not exist`) ||
    message.includes(`could not find the table '${normalizedRelation}'`) ||
    message.includes(`could not find the table "${normalizedRelation}"`)
  );
}

export default async function MeetingDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  if (!meeting) notFound();

  const { data: projects } = await supabaseAdmin
    .from("projects")
    .select("*")
    .eq("owner_id", user.id)
    .order("updated_at", { ascending: false });

  const [
    { data: segments, error: segmentsError },
    { data: insights, error: insightsError },
    { error: promptsError },
    { data: topics, error: topicsError },
    { data: tasks, error: tasksError },
    { data: commitments, error: commitmentsError },
    { data: aliases, error: aliasesError },
    latestAnalysisJob
  ] =
    await Promise.all([
      supabaseAdmin
        .from("transcript_segments")
        .select("*")
        .eq("meeting_id", id)
        .order("timestamp", { ascending: true }),
      supabaseAdmin
        .from("extracted_insights")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("generated_prompts")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("meeting_topics")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      loadMeetingTasksWithFallback((columns) =>
        supabaseAdmin
          .from("meeting_tasks")
          .select(columns)
          .eq("meeting_id", id)
          .order("created_at", { ascending: true })
      ),
      supabaseAdmin
        .from("meeting_commitments")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("meeting_speaker_aliases")
        .select("*")
        .eq("meeting_id", id)
        .order("raw_speaker_label", { ascending: true }),
      getLatestMeetingAnalysisJob(id).catch(() => null as MeetingAnalysisJob | null)
    ]);

  const topicsMissingTable = isMissingRelationError(topicsError, "meeting_topics");
  const tasksMissingTable = isMissingRelationError(tasksError, "meeting_tasks");
  const commitmentsMissingTable = isMissingRelationError(
    commitmentsError,
    "meeting_commitments"
  );
  const safeTopics = topicsMissingTable ? [] : (topics ?? []);
  const rawTasks = (tasksMissingTable ? [] : (tasks ?? [])) as MeetingTask[];
  const typedTopics = safeTopics as MeetingTopic[];
  const safeAliases = (aliases ?? []) as MeetingSpeakerAlias[];
  const rawSegments = canonicalTranscriptOrder((segments ?? []) as TranscriptSegment[]);
  const safeSegments = applySpeakerAliases(rawSegments, safeAliases);
  const safeTasks = applySpeakerAliasesToTasks(rawTasks, safeAliases);
  const safeCommitments = (commitmentsMissingTable
    ? []
    : commitments ?? []) as MeetingCommitment[];
  const activeCommitments = safeCommitments.filter(
    (commitment) => !commitment.converted_to_task_id
  );
  const speakerRoster = buildMeetingSpeakerRoster({
    segments: rawSegments,
    aliases: safeAliases,
    tasks: rawTasks
  });
  // Reuses this page's own already-loaded aliases/tasks/commitments -- no additional query, and
  // one shared option list for every owner dropdown on the page (see StandaloneTasksPanel below).
  const meetingParticipantOptions = buildMeetingParticipantOptions({
    aliases: safeAliases,
    tasks: rawTasks,
    commitments: safeCommitments
  });
  const participants = Array.from(
    new Set(
      safeSegments
        .map((segment) => segment.speaker?.trim())
        .filter((speaker): speaker is string => Boolean(speaker))
    )
  ).sort((a, b) => a.localeCompare(b));

  if (tasksError && !tasksMissingTable) {
    console.error("[meeting-detail] meeting_tasks fetch error:", tasksError);
  }

  const meetingWithOptionalError = meeting as typeof meeting & {
    bot_error?: string | null;
    error_message?: string | null;
    recall_error?: string | null;
  };
  const botCreationError =
    meetingWithOptionalError.bot_error ??
    meetingWithOptionalError.error_message ??
    meetingWithOptionalError.recall_error ??
    null;

  const partitioned = partitionExecutionGraph({
    commitments: activeCommitments,
    tasks: safeTasks,
    currentGeneration: meeting.execution_graph_generation ?? null
  });

  // Cheap, bounded lookup solely to decide which "Ask Parfait" suggestion chips are relevant --
  // never triggers an OpenAI call just to render the drawer (see MeetingAssistantPanel).
  const executionTaskIds = [...partitioned.linkedExecutionTasks, ...partitioned.standaloneTasks].map(
    (task) => task.id
  );
  const { data: dependencyRows } = executionTaskIds.length
    ? await supabaseAdmin.from("task_dependencies").select("*").in("task_id", executionTaskIds)
    : { data: [] };
  const taskById = new Map(safeTasks.map((task) => [task.id, task]));
  const hasBlockedTasks = (dependencyRows ?? []).some((dependency) => {
    const prerequisite = taskById.get(dependency.depends_on_task_id);
    return prerequisite && prerequisite.status !== "completed";
  });
  const distinctOwners = new Set(
    [...partitioned.linkedExecutionTasks, ...partitioned.standaloneTasks]
      .map((task) => task.owner?.trim())
      .filter((owner): owner is string => Boolean(owner))
  );
  const hasIncompleteWork =
    partitioned.activeCommitments.some((commitment) => commitment.status !== "completed") ||
    executionTaskIds.some((taskId) => taskById.get(taskId)?.status !== "completed");
  const meetingAnalyzed =
    partitioned.activeCommitments.length > 0 || executionTaskIds.length > 0;

  const assistantSuggestions: string[] = [];
  if (meetingAnalyzed) {
    assistantSuggestions.push("Summarize this meeting", "Who owns what?");
    if (hasBlockedTasks) assistantSuggestions.push("What's blocked?");
    if (distinctOwners.size >= 2) assistantSuggestions.push("Summarize work by owner");
    if (partitioned.activeCommitments.length > 0) {
      assistantSuggestions.push("Draft team follow-up email");
    }
    if (distinctOwners.size >= 2) assistantSuggestions.push("Draft emails by owner");
    if (hasIncompleteWork) assistantSuggestions.push("Create next-meeting agenda");
  } else if ((segments ?? []).length > 0) {
    assistantSuggestions.push("Summarize this meeting", "What did we discuss?");
  }

  const meetingDateLabel = formatReadableDate(meeting.created_at);

  return (
    <section className="space-y-6">
      {/* 1. Meeting header -- title, status, human date, participants, project, technical
          details. Everything a normal user needs to orient themselves; nothing pipeline-
          oriented lives here anymore (see Meeting Intelligence at the bottom of the page). */}
      <div className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Meeting Detail
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
                {meeting.title ?? "Untitled meeting"}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                <span className="badge-meta">{meetingPlatformLabel(meeting.platform)}</span>
                {meetingDateLabel ? <span>{meetingDateLabel}</span> : null}
              </div>
            </div>

            {participants.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Participants
                </span>
                {participants.map((participant) => (
                  <span
                    key={participant}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
                  >
                    {participant}
                  </span>
                ))}
              </div>
            ) : null}

            <MeetingProjectAssignment
              meetingId={meeting.id}
              currentProjectId={
                typeof meeting.project_id === "string" ? meeting.project_id : null
              }
              projects={(projects ?? []) as Project[]}
            />

            {meeting.meeting_url || meeting.recall_bot_id ? (
              <details className="disclosure">
                <summary>Technical details</summary>
                <div className="mt-1.5 space-y-0.5 text-xs text-slate-500">
                  <p className="break-all">{meeting.meeting_url}</p>
                  {meeting.recall_bot_id ? (
                    <p>
                      Recall Bot ID: <span className="font-mono">{meeting.recall_bot_id}</span>
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
          {/* Meeting completion status only -- separate from commitment/task completion,
              which the execution summary and commitment cards below report on their own. */}
          <LiveMeetingStatusBadge meetingId={meeting.id} initialStatus={meeting.status} />
        </div>
      </div>

      {meeting.status === "failed" ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {botCreationError
            ? `Bot creation failed: ${botCreationError}`
            : "Bot creation failed. Verify the meeting URL is active and try creating the meeting again."}
        </div>
      ) : null}

      {(segmentsError ||
        insightsError ||
        promptsError ||
        aliasesError ||
        (topicsError && !topicsMissingTable) ||
        (tasksError && !tasksMissingTable) ||
        (commitmentsError && !commitmentsMissingTable)) && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Some data sections could not be loaded. Try refreshing this page.
          {tasksError && !tasksMissingTable ? (
            <span className="mt-1 block text-xs">Tasks failed to load. Please refresh.</span>
          ) : null}
        </div>
      )}

      {/* Meeting-level operational utilities (queue analysis, sync status, reimport transcript)
          and the current analysis state -- these are page-level controls, not evidence content,
          so they live near the top rather than inside Evidence & Analysis below, and stay full
          width above the two-column execution/assistant workspace. Both components are already
          self-compacting (MeetingAnalysisStatusPanel collapses to one line once analysis is
          complete), so `justify-between` keeps the row feeling intentional (actions left, status
          right) instead of controls floating loosely in empty space. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <MeetingActions
          meetingId={meeting.id}
          showDevReimport={process.env.NODE_ENV === "development"}
        />
        <MeetingAnalysisStatusPanel
          meetingId={meeting.id}
          meetingStatus={meeting.status}
          initialJob={latestAnalysisJob}
          segmentCount={(segments ?? []).length}
        />
      </div>

      {/* Two-column workspace: meeting execution content on the left, Ask Parfait on the right.
          A single `grid` (not `xl:grid`) so CSS `order` on MeetingAssistantPanel already takes
          effect below xl too -- on narrower screens this collapses to one column and the
          assistant's trigger surfaces first (see its own order-first/xl:order-none classes),
          while at xl+ the explicit two-column template seats it as a persistent right rail
          beside the main column. main column keeps `xl:min-w-0` so long content wraps instead of
          forcing the grid track wider than its 400px-ish assistant sibling. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <div className="space-y-6 xl:min-w-0">
          {/* Speaker resolution: a compact callout when identities are unresolved (affects
              ownership accuracy), collapsed by default either way -- see SpeakerMappingPanel. */}
          <SpeakerMappingPanel meetingId={meeting.id} initialSpeakers={speakerRoster} />

          {/* 2. Compact execution summary -- execution-oriented counts only. Transcript/topic/
              insight processing metrics moved to Meeting Intelligence below. */}
          <div className="premium-card grid grid-cols-2 divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0 sm:divide-x">
            {[
              ["Active Commitments", partitioned.activeCommitments.length],
              ["Linked Tasks", partitioned.linkedExecutionTasks.length],
              ["Standalone Tasks", partitioned.standaloneTasks.length],
              ["Future Scope", partitioned.ideaCommitments.length + partitioned.ideaTasks.length]
            ].map(([label, value]) => (
              <div key={label as string} className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {label}
                </p>
                <p className="mt-1.5 text-xl font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>

          {/* 3. Commitments -- the primary output of the meeting. */}
          <CommitmentsPanel
            commitments={partitioned.activeCommitments}
            tasks={partitioned.linkedExecutionTasks}
          />

          {/* 4. Standalone tasks -- actionable, but not part of a larger commitment. */}
          <StandaloneTasksPanel
            tasks={partitioned.standaloneTasks}
            meetingParticipantOptions={meetingParticipantOptions}
          />

          {/* 5. Future scope -- discussed, not committed. */}
          <IdeasRequirementsPanel
            commitments={partitioned.ideaCommitments}
            tasks={partitioned.ideaTasks}
          />

          {/* 6. Meeting Intelligence / Evidence -- supporting analysis only (topic breakdown,
              transcript, pipeline metrics), after execution results, via progressive disclosure.
              Meeting-level operational controls (Meeting Actions, analysis status) live near the
              top of the page instead -- they're utilities, not evidence content. */}
          <section className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Meeting Intelligence
              </p>
              <h2 className="mt-1 text-lg font-semibold text-slate-950">
                Evidence &amp; Analysis
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Supporting analysis behind Parfait&apos;s interpretation of this meeting.
              </p>
              <p className="badge-internal mt-2">
                {(segments ?? []).length} transcript segments · {typedTopics.length} topics ·{" "}
                {(insights ?? []).length} insights
              </p>
            </div>

            <details className="premium-card p-5">
              <summary className="cursor-pointer font-semibold text-slate-950">
                Topics and supporting analysis
              </summary>
              <div className="mt-5">
                <TopicResults topics={typedTopics} insights={insights ?? []} />
                {typedTopics.length === 0 ? (
                  <div className="mt-4">
                    <InsightsPanel
                      insights={(insights ?? []).filter((item) => item.topic_id == null)}
                    />
                  </div>
                ) : null}
              </div>
            </details>

            <details className="premium-card p-5">
              <summary className="cursor-pointer font-semibold text-slate-950">
                Transcript
              </summary>
              <div className="mt-5">
                <LiveTranscript
                  meetingId={meeting.id}
                  initialSegments={safeSegments}
                  initialStatus={meeting.status}
                />
              </div>
            </details>
          </section>
        </div>

        <MeetingAssistantPanel
          meetingId={meeting.id}
          meetingTitle={meeting.title}
          suggestions={assistantSuggestions.slice(0, 6)}
        />
      </div>
    </section>
  );
}
