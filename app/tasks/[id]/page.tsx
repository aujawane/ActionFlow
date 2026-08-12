import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import { TaskClarifications } from "@/components/task-clarifications";
import { TaskExecutionPanel } from "@/components/task-execution-panel";
import {
  TaskWorkspaceClassificationEvidence,
  TaskWorkspaceHeader,
  TaskWorkspaceSuggestedSteps,
  TaskWorkspaceTaskProvider
} from "@/components/task-workspace-task-state";
import { requireUser } from "@/lib/auth";
import { computeCommitmentProgress } from "@/lib/project-execution";
import {
  resolveTaskOwner
} from "@/lib/speaker-aliases";
import {
  getSegmentIdsFromTopic,
  loadResolvedMeetingTranscriptSegments
} from "@/lib/transcript-segments";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  MeetingCommitment,
  MeetingTask,
  MeetingTopic,
  Project,
  TaskArtifact
} from "@/lib/types";

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

  const { data: commitment } = typedTask.commitment_id
    ? await supabaseAdmin
        .from("meeting_commitments")
        .select("*")
        .eq("id", typedTask.commitment_id)
        .eq("meeting_id", typedTask.meeting_id)
        .maybeSingle()
    : { data: null };
  const typedCommitment = commitment as MeetingCommitment | null;
  const { data: commitmentTasks } = typedCommitment
    ? await supabaseAdmin
        .from("meeting_tasks")
        .select("*")
        .eq("commitment_id", typedCommitment.id)
    : { data: [] };
  const parentCommitment = typedCommitment
    ? {
        id: typedCommitment.id,
        title: typedCommitment.title,
        progress: computeCommitmentProgress(
          typedCommitment,
          (commitmentTasks ?? []) as MeetingTask[]
        )
      }
    : null;
  const { data: project } = typedTask.project_id
    ? await supabaseAdmin
        .from("projects")
        .select("*")
        .eq("id", typedTask.project_id)
        .eq("owner_id", user.id)
        .maybeSingle()
    : { data: null };
  const typedProject = project as Project | null;

  const { data: topic } = typedTask.topic_id
    ? await supabaseAdmin
        .from("meeting_topics")
        .select("*")
        .eq("id", typedTask.topic_id)
        .eq("meeting_id", typedTask.meeting_id)
        .maybeSingle()
    : { data: null };

  const typedTopic = topic as MeetingTopic | null;
  const {
    segments,
    aliases,
    segmentsError
  } = await loadResolvedMeetingTranscriptSegments({
    meetingId: typedTask.meeting_id,
    segmentIds: getSegmentIdsFromTopic(typedTopic?.segment_ids),
    limit: 8
  });

  if (segmentsError) {
    console.warn("[task workspace] Failed to load transcript context", {
      task_id: typedTask.id,
      meeting_id: typedTask.meeting_id,
      details: segmentsError.message
    });
  }

  const typedAliases = aliases;
  const resolvedTask = {
    ...typedTask,
    owner: resolveTaskOwner(typedTask.owner, typedAliases)
  };
  const { data: artifacts } = await supabaseAdmin
    .from("task_artifacts")
    .select("*")
    .eq("task_id", typedTask.id)
    .order("created_at", { ascending: false });
  const initialArtifacts = (artifacts ?? []) as TaskArtifact[];

  const hasEvidence =
    Boolean(resolvedTask.source_quote) || segments.length > 0 || Boolean(typedTopic);

  return (
    <TaskWorkspaceTaskProvider initialTask={resolvedTask}>
      <section className="space-y-6">
        <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <Link href={"/projects" as Route} className="hover:text-brand-700">
            Projects
          </Link>
          {typedProject ? (
            <>
              <span>/</span>
              <Link
                href={`/projects/${typedProject.id}` as Route}
                className="hover:text-brand-700"
              >
                {typedProject.name}
              </Link>
            </>
          ) : null}
          {typedCommitment ? (
            <>
              <span>/</span>
              <Link
                href={`/commitments/${typedCommitment.id}` as Route}
                className="hover:text-brand-700"
              >
                {typedCommitment.title}
              </Link>
            </>
          ) : null}
          <span>/</span>
          <span className="text-slate-900">{resolvedTask.task}</span>
        </nav>

        {/* A. Task Header -- what the task is, who owns it, when it's due, where it fits. */}
        <TaskWorkspaceHeader parentCommitment={parentCommitment} />

        {/* lg:items-start keeps each column's height driven by its own content -- previously
            the grid stretched both columns to match the taller one, which could leave a large
            empty block in whichever column was shorter (see Phase 4 layout fix). The right rail
            now only holds bounded content (Ask Parfait's fixed-height panel + a compact source
            meeting card), so it should rarely be the taller column at all. */}
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
          <div className="min-w-0 space-y-6">
            {/* B/C. Task Actions + Deliverables, promoted ahead of any rationale/evidence. */}
            <TaskWorkspaceSuggestedSteps />
            <TaskExecutionPanel
              taskId={resolvedTask.id}
              workspaceType={resolvedTask.workspace_type}
              initialArtifacts={initialArtifacts}
            />

            {/* E. Context & Evidence -- trust/debug layer: why this task exists and what
                supports it. Collapsed by default so it never competes with the actions above
                it; still fully accessible. */}
            <section className="premium-card p-5 sm:p-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Context & Evidence
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-950">
                  Why this task exists
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Supporting evidence and classification behind Parfait&apos;s interpretation.
                </p>
              </div>

              <div className="mt-5 space-y-3">
                {resolvedTask.source_quote ? (
                  <details className="disclosure">
                    <summary>Source quote</summary>
                    <blockquote className="mt-2 border-l-2 border-brand-200 pl-3 text-sm italic leading-6 text-slate-600">
                      &ldquo;{resolvedTask.source_quote}&rdquo;
                    </blockquote>
                  </details>
                ) : null}

                {segments.length > 0 ? (
                  <details className="disclosure">
                    <summary>Meeting context ({segments.length})</summary>
                    <div className="mt-2 max-h-[24rem] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3">
                      {segments.map((segment) => (
                        <div key={segment.id} className="rounded-xl bg-white p-3 shadow-sm">
                          <p className="text-xs font-semibold text-slate-500">
                            {segment.speaker || "Unknown speaker"} • {formatTime(segment.timestamp)}
                          </p>
                          <p className="mt-1 text-sm leading-6 text-slate-700">{segment.text}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {typedTopic ? (
                  <details className="disclosure">
                    <summary>Topic context — {typedTopic.title}</summary>
                    <div className="mt-2 space-y-2">
                      {typedTopic.summary ? (
                        <p className="text-sm leading-6 text-slate-600">{typedTopic.summary}</p>
                      ) : null}
                      {typedTopic.separation_reason ? (
                        <p className="text-xs text-slate-500">
                          Why separated: {typedTopic.separation_reason}
                        </p>
                      ) : null}
                    </div>
                  </details>
                ) : null}

                <details className="disclosure">
                  <summary>Classification &amp; rationale</summary>
                  <div className="mt-2">
                    <TaskWorkspaceClassificationEvidence />
                  </div>
                </details>

                {!hasEvidence ? (
                  <p className="text-sm text-slate-500">
                    No additional evidence was captured for this task.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          {/* D. Ask Parfait -- the contextual assistant for this task -- plus compact source
              meeting access. Kept sticky on desktop; both cards are bounded/content-driven so
              they don't produce runaway sidebar height. */}
          <aside className="space-y-6 lg:sticky lg:top-6">
            <TaskClarifications taskId={resolvedTask.id} variant="panel" />

            <section className="premium-card p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Source
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-950">
                  {meeting.title || "Untitled meeting"}
                </p>
                <MeetingStatusBadge status={meeting.status} />
              </div>
              <Link
                href={`/meetings/${meeting.id}` as Route}
                className="secondary-button mt-4 w-full"
              >
                Open meeting →
              </Link>
            </section>
          </aside>
        </div>
      </section>
    </TaskWorkspaceTaskProvider>
  );
}
