import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import { TaskClarifications } from "@/components/task-clarifications";
import { TaskExecutionPanel } from "@/components/task-execution-panel";
import {
  TaskWorkspaceEditableDetails,
  TaskWorkspaceHeader,
  TaskWorkspaceTaskProvider
} from "@/components/task-workspace-task-state";
import { requireUser } from "@/lib/auth";
import {
  applySpeakerAliases,
  resolveTaskOwner
} from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  MeetingSpeakerAlias,
  MeetingTask,
  MeetingTopic,
  TaskArtifact,
  TranscriptSegment
} from "@/lib/types";

function getSegmentIds(value: MeetingTopic["segment_ids"]) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

export default async function TaskWorkspacePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const { data: task } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    notFound();
  }

  const typedTask = task as MeetingTask;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", typedTask.meeting_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  if (!meeting) {
    notFound();
  }

  const { data: topic } = await supabaseAdmin
    .from("meeting_topics")
    .select("*")
    .eq("id", typedTask.topic_id)
    .eq("meeting_id", typedTask.meeting_id)
    .maybeSingle();

  const typedTopic = topic as MeetingTopic | null;
  const segmentIds = typedTopic ? getSegmentIds(typedTopic.segment_ids) : [];
  const [{ data: contextSegments }, { data: aliases }] =
    segmentIds.length > 0
      ? await Promise.all([
          supabaseAdmin
            .from("transcript_segments")
            .select("*")
            .eq("meeting_id", typedTask.meeting_id)
            .in("id", segmentIds)
            .order("timestamp", { ascending: true }),
          supabaseAdmin
            .from("meeting_speaker_aliases")
            .select("*")
            .eq("meeting_id", typedTask.meeting_id)
        ])
      : await Promise.all([
          supabaseAdmin
            .from("transcript_segments")
            .select("*")
            .eq("meeting_id", typedTask.meeting_id)
            .order("timestamp", { ascending: true })
            .limit(8),
          supabaseAdmin
            .from("meeting_speaker_aliases")
            .select("*")
            .eq("meeting_id", typedTask.meeting_id)
        ]);

  const typedAliases = (aliases ?? []) as MeetingSpeakerAlias[];
  const resolvedTask = {
    ...typedTask,
    owner: resolveTaskOwner(typedTask.owner, typedAliases)
  };
  const segments = applySpeakerAliases(
    (contextSegments ?? []) as TranscriptSegment[],
    typedAliases
  );
  const { data: artifacts } = await supabaseAdmin
    .from("task_artifacts")
    .select("*")
    .eq("task_id", typedTask.id)
    .order("created_at", { ascending: false });
  const initialArtifacts = (artifacts ?? []) as TaskArtifact[];

  return (
    <TaskWorkspaceTaskProvider initialTask={resolvedTask}>
      <section className="space-y-6">
        <TaskWorkspaceHeader />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <TaskWorkspaceEditableDetails />

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Source Quote</h2>
            {resolvedTask.source_quote ? (
              <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm italic leading-6 text-slate-600">
                &ldquo;{resolvedTask.source_quote}&rdquo;
              </blockquote>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No source quote was captured.</p>
            )}
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Meeting Context</h2>
            {segments.length > 0 ? (
              <div className="mt-4 max-h-[24rem] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3">
                {segments.map((segment) => (
                  <div key={segment.id} className="rounded-xl bg-white p-3 shadow-sm">
                    <p className="text-xs font-semibold text-slate-500">
                      {segment.speaker || "Unknown speaker"} • {formatTime(segment.timestamp)}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-700">{segment.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No transcript context is available.</p>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <TaskClarifications taskId={resolvedTask.id} variant="panel" />

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Related Meeting</h2>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">
                  {meeting.title || "Untitled meeting"}
                </p>
                <MeetingStatusBadge status={meeting.status} />
              </div>
              <p className="break-all text-xs text-slate-500">{meeting.meeting_url}</p>
              <Link href={`/meetings/${meeting.id}` as Route} className="secondary-button w-full">
                Open Meeting
              </Link>
            </div>
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Topic Context</h2>
            {typedTopic ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-semibold text-slate-900">{typedTopic.title}</p>
                {typedTopic.summary ? (
                  <p className="text-sm leading-6 text-slate-600">{typedTopic.summary}</p>
                ) : null}
                {typedTopic.separation_reason ? (
                  <p className="text-xs text-slate-500">
                    Why separated: {typedTopic.separation_reason}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No topic context is available.</p>
            )}
          </section>

        </aside>
      </div>

      <TaskExecutionPanel
        taskId={resolvedTask.id}
        workspaceType={resolvedTask.workspace_type}
        initialArtifacts={initialArtifacts}
      />
      </section>
    </TaskWorkspaceTaskProvider>
  );
}
