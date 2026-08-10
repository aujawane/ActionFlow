import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { CommitmentWorkspace } from "@/components/commitment-workspace";
import { requireUser } from "@/lib/auth";
import { buildCommitmentWorkspaceModel } from "@/lib/project-execution";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";
import type {
  CommitmentComment,
  CommitmentParticipant,
  MeetingCommitment,
  MeetingTask,
  Project,
  TaskArtifact,
  TaskDependency,
  TranscriptSegment
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CommitmentPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { data: commitment } = await supabaseAdmin
    .from("meeting_commitments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!commitment) notFound();
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", commitment.meeting_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!meeting) notFound();

  const [
    { data: tasks },
    { data: comments },
    { data: participants },
    { data: project },
    { data: profile }
  ] =
    await Promise.all([
      supabaseAdmin
        .from("meeting_tasks")
        .select("*")
        .eq("commitment_id", id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("commitment_comments")
        .select("*")
        .eq("commitment_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("commitment_participants")
        .select("*")
        .eq("commitment_id", id)
        .order("created_at", { ascending: true }),
      commitment.project_id
        ? supabaseAdmin
            .from("projects")
            .select("*")
            .eq("id", commitment.project_id)
            .eq("owner_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle()
    ]);

  const safeTasks = (tasks ?? []) as MeetingTask[];
  const taskIds = safeTasks.map((task) => task.id);
  const [{ data: dependencies }, { data: artifacts }] = await Promise.all([
    taskIds.length
      ? supabaseAdmin
          .from("task_dependencies")
          .select("*")
          .in("task_id", taskIds)
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? supabaseAdmin
          .from("task_artifacts")
          .select("*")
          .in("task_id", taskIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [] })
  ]);

  const model = buildCommitmentWorkspaceModel({
    commitment: commitment as MeetingCommitment,
    tasks: safeTasks,
    dependencies: (dependencies ?? []) as TaskDependency[],
    artifacts: (artifacts ?? []) as TaskArtifact[],
    participants: (participants ?? []) as CommitmentParticipant[]
  });
  const { data: evidenceRows } = model.evidenceSegmentIds.length
    ? await supabaseAdmin
        .from("transcript_segments")
        .select("*")
        .eq("meeting_id", meeting.id)
        .in("id", model.evidenceSegmentIds)
        .order("timestamp", { ascending: true })
    : { data: [] };
  const evidence = canonicalTranscriptOrder((evidenceRows ?? []) as TranscriptSegment[]);

  return (
    <section className="space-y-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href={"/projects" as Route} className="hover:text-brand-700">
          Projects
        </Link>
        {project ? (
          <>
            <span>/</span>
            <Link
              href={`/projects/${project.id}` as Route}
              className="hover:text-brand-700"
            >
              {(project as Project).name}
            </Link>
          </>
        ) : null}
        <span>/</span>
        <span className="text-slate-900">{commitment.title}</span>
      </nav>

      <CommitmentWorkspace
        initialCommitment={model.commitment}
        initialTasks={model.tasks}
        initialDependencies={model.dependencies}
        initialComments={(comments ?? []) as CommitmentComment[]}
        initialParticipants={(participants ?? []) as CommitmentParticipant[]}
        initialArtifacts={(artifacts ?? []) as TaskArtifact[]}
        sourceMeeting={{ id: meeting.id, title: meeting.title }}
        currentUserName={profile?.full_name ?? null}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="premium-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-950">Meeting Evidence</h2>
            <Link
              href={`/meetings/${meeting.id}` as Route}
              className="text-sm font-semibold text-brand-700 hover:underline"
            >
              Open Meeting
            </Link>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {meeting.title || "Untitled meeting"}
          </p>
          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
            {((evidence ?? []) as TranscriptSegment[]).map((segment) => (
              <blockquote
                key={segment.id}
                className="rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-700"
              >
                <span className="mb-1 block text-xs font-semibold text-slate-500">
                  {segment.resolved_speaker ||
                    segment.participant_name ||
                    segment.speaker ||
                    "Unknown speaker"}
                </span>
                {segment.text}
              </blockquote>
            ))}
            {(evidence ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">
                No segment-level evidence is linked.
              </p>
            ) : null}
          </div>
        </section>

        <section className="premium-card p-5">
          <h2 className="font-semibold text-slate-950">Deliverables</h2>
          <div className="mt-4 space-y-3">
            {model.artifacts.map((artifact) => (
              <Link
                key={artifact.id}
                href={`/tasks/${artifact.task_id}` as Route}
                className="block rounded-xl bg-slate-50 p-3 hover:bg-brand-50"
              >
                <p className="text-sm font-semibold text-slate-900">
                  {artifact.title}
                </p>
                <p className="mt-1 text-xs capitalize text-slate-500">
                  {(artifact.deliverable_type || artifact.artifact_type).replaceAll(
                    "_",
                    " "
                  )}
                </p>
              </Link>
            ))}
            {model.artifacts.length === 0 ? (
              <p className="text-sm text-slate-500">
                Deliverables generated from child tasks appear here.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}
