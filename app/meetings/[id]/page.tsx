import { notFound } from "next/navigation";

import { ExecutionDashboard } from "@/components/execution-dashboard";
import { InsightsPanel } from "@/components/insights-panel";
import { LiveTranscript } from "@/components/live-transcript";
import { MeetingActions } from "@/components/meeting-actions";
import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import { PromptsPanel } from "@/components/prompts-panel";
import { SpeakerMappingPanel } from "@/components/speaker-mapping-panel";
import { TopicResults } from "@/components/topic-results";
import { requireUser } from "@/lib/auth";
import { applySpeakerAliases, getMappableSpeakerLabels } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  MeetingSpeakerAlias,
  MeetingTask,
  MeetingTopic,
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

  const [
    { data: segments, error: segmentsError },
    { data: insights, error: insightsError },
    { data: prompts, error: promptsError },
    { data: topics, error: topicsError },
    { data: tasks, error: tasksError },
    { data: aliases, error: aliasesError }
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
      supabaseAdmin
        .from("meeting_tasks")
        .select(
          "id, meeting_id, topic_id, task, owner, task_type, priority, suggested_steps, source_quote, confidence, status, workspace_type, workspace_summary, created_at"
        )
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("meeting_speaker_aliases")
        .select("*")
        .eq("meeting_id", id)
        .order("raw_speaker_label", { ascending: true })
    ]);

  const topicsMissingTable = isMissingRelationError(topicsError, "meeting_topics");
  const tasksMissingTable = isMissingRelationError(tasksError, "meeting_tasks");
  const safeTopics = topicsMissingTable ? [] : (topics ?? []);
  const safeTasks = (tasksMissingTable ? [] : (tasks ?? [])) as MeetingTask[];
  const typedTopics = safeTopics as MeetingTopic[];
  const safeAliases = (aliases ?? []) as MeetingSpeakerAlias[];
  const rawSegments = (segments ?? []) as TranscriptSegment[];
  const safeSegments = applySpeakerAliases(rawSegments, safeAliases);
  const mappableSpeakerLabels = getMappableSpeakerLabels(rawSegments);
  const participants = Array.from(
    new Set(
      safeSegments
        .map((segment) => segment.speaker?.trim())
        .filter((speaker): speaker is string => Boolean(speaker))
    )
  ).sort((a, b) => a.localeCompare(b));

  if (process.env.NODE_ENV !== "production") {
    console.info("[meeting-detail] fetched tasks:", {
      meetingId: id,
      count: safeTasks.length,
      tasks: safeTasks.map((task) => ({
        id: task.id,
        task: task.task,
        topic_id: task.topic_id
      }))
    });
    console.info("[meeting-detail] fetched topics:", {
      meetingId: id,
      count: typedTopics.length,
      topics: typedTopics.map((topic) => ({
        id: topic.id,
        title: topic.title
      }))
    });

    if (tasksError && !tasksMissingTable) {
      console.error("[meeting-detail] meeting_tasks fetch error:", tasksError);
    }
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

  return (
    <section className="space-y-6">
      <div className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Meeting Detail
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {meeting.title ?? "Untitled meeting"}
            </h1>
            <p className="text-xs text-slate-500">{meeting.meeting_url}</p>
            {meeting.recall_bot_id ? (
              <p className="text-xs text-slate-500">
                Recall Bot ID: <span className="font-mono">{meeting.recall_bot_id}</span>
              </p>
            ) : null}
          </div>
          <MeetingStatusBadge status={meeting.status} />
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
        (tasksError && !tasksMissingTable)) && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Some data sections could not be loaded. Try refreshing this page.
          {tasksError && !tasksMissingTable ? (
            <span className="mt-1 block text-xs">
              Action items failed to load: {tasksError.message}
            </span>
          ) : null}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="premium-card premium-card-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Transcript Segments
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {(segments ?? []).length}
          </p>
        </div>
        <div className="premium-card premium-card-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Topics
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {typedTopics.length}
          </p>
        </div>
        <div className="premium-card premium-card-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Insights
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {(insights ?? []).length}
          </p>
        </div>
        <div className="premium-card premium-card-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Generated Prompts
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {(prompts ?? []).length}
          </p>
        </div>
        <div className="premium-card premium-card-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Action Items
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {safeTasks.length}
          </p>
        </div>
      </div>

      <MeetingActions
        meetingId={meeting.id}
        showDevReimport={process.env.NODE_ENV === "development"}
      />

      <SpeakerMappingPanel
        meetingId={meeting.id}
        speakerLabels={mappableSpeakerLabels}
        initialAliases={safeAliases}
      />

      <ExecutionDashboard participants={participants} tasks={safeTasks} />

      <TopicResults
        topics={typedTopics}
        insights={insights ?? []}
        prompts={prompts ?? []}
        tasks={safeTasks}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveTranscript meetingId={meeting.id} initialSegments={safeSegments} />
        {typedTopics.length === 0 ? (
          <InsightsPanel insights={(insights ?? []).filter((item) => item.topic_id == null)} />
        ) : null}
      </div>

      {typedTopics.length === 0 ? (
        <PromptsPanel prompts={(prompts ?? []).filter((item) => item.topic_id == null)} />
      ) : null}
    </section>
  );
}
