import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth";
import {
  ProjectBrainLauncher,
  ProjectBrainPanel
} from "@/components/project-brain-panel";
import {
  buildProjectExecutionModel,
  computeCommitmentProgress
} from "@/lib/project-execution";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  Meeting,
  MeetingArtifact,
  MeetingCommitment,
  MeetingTask,
  Project,
  ProjectChangeProposal,
  ProjectChatMessage,
  ProjectMemory,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

export const dynamic = "force-dynamic";

function bar(percent: number) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div
        className="h-full rounded-full bg-brand-600"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export default async function ProjectPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [{ data: project }, { data: profile }] = await Promise.all([
    supabaseAdmin
      .from("projects")
      .select("*")
      .eq("id", id)
      .eq("owner_id", user.id)
      .maybeSingle(),
    supabaseAdmin.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
  ]);
  if (!project) notFound();

  const [{ data: meetings }, { data: commitments }, { data: tasks }] =
    await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("*")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("meeting_commitments")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("meeting_tasks")
        .select("*")
        .eq("project_id", id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true })
    ]);

  const safeMeetings = (meetings ?? []) as Meeting[];
  const safeCommitments = (commitments ?? []) as MeetingCommitment[];
  const safeTasks = (tasks ?? []) as MeetingTask[];
  const taskIds = safeTasks.map((task) => task.id);
  const meetingIds = safeMeetings.map((meeting) => meeting.id);
  const [
    { data: taskArtifacts },
    { data: meetingArtifacts },
    { data: dependencies },
    { data: memory },
    { data: brainThread },
    { data: recentChanges },
    { data: projectParticipants },
    { data: projectDecisions },
    { data: projectConstraints }
  ] = await Promise.all([
    taskIds.length
      ? supabaseAdmin
          .from("task_artifacts")
          .select("*")
          .in("task_id", taskIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    meetingIds.length
      ? supabaseAdmin
          .from("meeting_artifacts")
          .select("*")
          .in("meeting_id", meetingIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? supabaseAdmin
          .from("task_dependencies")
          .select("*")
          .in("task_id", taskIds)
      : Promise.resolve({ data: [] }),
    supabaseAdmin
      .from("project_memory")
      .select("*")
      .eq("project_id", id)
      .maybeSingle(),
    supabaseAdmin
      .from("project_chat_threads")
      .select("*")
      .eq("project_id", id)
      .eq("created_by", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("project_change_events")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(8),
    supabaseAdmin
      .from("project_participants")
      .select("participant_name")
      .eq("project_id", id)
      .order("participant_name", { ascending: true }),
    supabaseAdmin
      .from("project_decisions")
      .select("id,title,description,status")
      .eq("project_id", id)
      .neq("status", "archived")
      .order("updated_at", { ascending: false }),
    supabaseAdmin
      .from("project_constraints")
      .select("id,title,description,status")
      .eq("project_id", id)
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
  ]);
  const [{ data: brainMessages }, { data: brainProposals }] = brainThread
    ? await Promise.all([
        supabaseAdmin
          .from("project_chat_messages")
          .select("*")
          .eq("thread_id", brainThread.id)
          .order("created_at", { ascending: true })
          .limit(200),
        supabaseAdmin
          .from("project_change_proposals")
          .select("*")
          .eq("thread_id", brainThread.id)
          .order("created_at", { ascending: true })
      ])
    : [{ data: [] }, { data: [] }];

  const model = buildProjectExecutionModel({
    project: project as Project,
    meetings: safeMeetings,
    commitments: safeCommitments,
    tasks: safeTasks,
    dependencies: (dependencies ?? []) as TaskDependency[],
    currentUserName: profile?.full_name ?? null
  });
  const files = [
    ...((taskArtifacts ?? []) as TaskArtifact[]).map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.deliverable_type || artifact.artifact_type,
      href: `/tasks/${safeTasks.find((task) => task.id === artifact.task_id)?.id ?? ""}`
    })),
    ...((meetingArtifacts ?? []) as MeetingArtifact[]).map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.artifact_type,
      href: `/meetings/${artifact.meeting_id}`
    }))
  ];
  const people = Array.from(
    new Set([
      ...model.people,
      ...(projectParticipants ?? []).map(
        (participant) => participant.participant_name
      )
    ])
  );

  return (
    <div className="flex items-start gap-6">
      <section className="min-w-0 flex-1 space-y-6">
      <header className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Project
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
              {model.project.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {model.project.goal || model.project.description || "No goal set yet."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ProjectBrainLauncher starterPrompt="Here is important project context: " />
            <span className="rounded-full bg-brand-50 px-3 py-1.5 text-sm font-semibold capitalize text-brand-800">
              {model.project.status.replace("_", " ")}
            </span>
          </div>
        </div>
        <div className="mt-5">
          <div className="mb-2 flex justify-between text-sm text-slate-600">
            <span>Overall progress</span>
            <span>
              {model.progress.completed} of {model.progress.total} complete
            </span>
          </div>
          {bar(model.progress.percent)}
        </div>
      </header>

      <section className="premium-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Next Best Task
        </p>
        {model.nextBestTask ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-slate-950">
                {model.nextBestTask.task.task}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {model.nextBestTask.reasons.join(" • ") || "Ready to execute"}
              </p>
            </div>
            <Link
              href={`/tasks/${model.nextBestTask.task.id}` as Route}
              className="premium-button"
            >
              Execute Task
            </Link>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            No unblocked committed task is ready.
          </p>
        )}
      </section>

      <section className="premium-card p-5">
        <h2 className="text-lg font-semibold text-slate-950">Commitments</h2>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {model.commitments.map((commitment) => {
            const progress = computeCommitmentProgress(commitment, model.tasks);
            return (
              <article key={commitment.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-slate-950">{commitment.title}</h3>
                  <span className="text-xs capitalize text-slate-500">
                    {commitment.status.replace("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {progress.completed} of {progress.total} complete
                </p>
                <div className="mt-2">{bar(progress.percent)}</div>
                <Link
                  href={`/commitments/${commitment.id}` as Route}
                  className="secondary-button mt-4 w-full"
                >
                  Open Commitment
                </Link>
              </article>
            );
          })}
          {model.commitments.length === 0 ? (
            <p className="text-sm text-slate-500">
              Assign and analyze a meeting to populate project commitments.
            </p>
          ) : null}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="premium-card p-5">
          <h2 className="font-semibold text-slate-950">People</h2>
          <div className="mt-3 space-y-2">
            {people.map((person) => (
              <p key={person} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                {person}
              </p>
            ))}
            {people.length === 0 ? (
              <p className="text-sm text-slate-500">No owners assigned.</p>
            ) : null}
          </div>
        </section>

        <section className="premium-card p-5">
          <h2 className="font-semibold text-slate-950">Meetings</h2>
          <div className="mt-3 space-y-2">
            {model.meetings.map((meeting) => (
              <Link
                key={meeting.id}
                href={`/meetings/${meeting.id}` as Route}
                className="block rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium hover:bg-brand-50"
              >
                {meeting.title || "Untitled meeting"}
              </Link>
            ))}
            {model.meetings.length === 0 ? (
              <p className="text-sm text-slate-500">No meetings linked.</p>
            ) : null}
          </div>
        </section>

        <section className="premium-card p-5">
          <h2 className="font-semibold text-slate-950">Files & Deliverables</h2>
          <div className="mt-3 space-y-2">
            {files.map((file) => (
              <Link
                key={`${file.kind}-${file.id}`}
                href={file.href as Route}
                className="block rounded-xl bg-slate-50 px-3 py-2 hover:bg-brand-50"
              >
                <p className="text-sm font-medium text-slate-900">{file.title}</p>
                <p className="mt-0.5 text-xs capitalize text-slate-500">
                  {file.kind.replaceAll("_", " ")}
                </p>
              </Link>
            ))}
            {files.length === 0 ? (
              <p className="text-sm text-slate-500">No deliverables yet.</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="premium-card p-5">
        <h2 className="font-semibold text-slate-950">Recent changes</h2>
        <div className="mt-3 space-y-2">
          {(recentChanges ?? []).map((event) => (
            <article key={event.id} className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-sm font-medium capitalize text-slate-800">
                {event.event_type.replaceAll("_", " ")}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {event.entity_type.replaceAll("_", " ")} ·{" "}
                {new Date(event.created_at).toLocaleString()}
              </p>
            </article>
          ))}
          {(recentChanges ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No reviewed Project Brain changes yet.</p>
          ) : null}
        </div>
      </section>
      </section>

      <ProjectBrainPanel
        project={model.project}
        initialThread={brainThread ? { id: brainThread.id } : null}
        initialMessages={(brainMessages ?? []) as ProjectChatMessage[]}
        initialProposals={(brainProposals ?? []) as ProjectChangeProposal[]}
        memory={(memory as ProjectMemory | null) ?? null}
        decisions={projectDecisions ?? []}
        constraints={projectConstraints ?? []}
        milestones={safeCommitments}
        tasks={safeTasks}
      />
    </div>
  );
}
