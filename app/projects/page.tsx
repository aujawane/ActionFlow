import Link from "next/link";
import type { Route } from "next";

import { ProjectLibrary } from "@/components/project-library";
import { requireUser } from "@/lib/auth";
import {
  buildActiveCommitmentsOverview,
  buildDashboardExecutionSummary,
  buildNeedsAttention,
  buildProjectCardSummary,
  buildRecentMeetingImpact,
  daysUntilDue,
  formatDaysUntilDueLabel
} from "@/lib/execution-dashboard";
import { formatReadableDate } from "@/lib/format-date";
import { buildProjectExecutionModel } from "@/lib/project-execution";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Meeting, MeetingCommitment, MeetingTask, Project } from "@/lib/types";

export const dynamic = "force-dynamic";

function groupBy<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    if (!groupKey) continue;
    map.set(groupKey, [...(map.get(groupKey) ?? []), item]);
  }
  return map;
}

export default async function ProjectsPage() {
  const user = await requireUser();
  const { data: projects } = await supabaseAdmin
    .from("projects")
    .select("*")
    .eq("owner_id", user.id)
    .order("updated_at", { ascending: false });
  const safeProjects = (projects ?? []) as Project[];
  const projectIds = safeProjects.map((project) => project.id);

  // Batched across all projects (not one query per project) to keep this page's cost flat as
  // the user's project count grows -- see Phase 5 performance constraints.
  const [
    { data: projectMeetings },
    { data: projectCommitments },
    { data: projectTasks },
    { data: recentMeetings }
  ] = await Promise.all([
    projectIds.length
      ? supabaseAdmin
          .from("meetings")
          .select("*")
          .in("project_id", projectIds)
          .eq("user_id", user.id)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] as Meeting[] }),
    projectIds.length
      ? supabaseAdmin.from("meeting_commitments").select("*").in("project_id", projectIds)
      : Promise.resolve({ data: [] as MeetingCommitment[] }),
    projectIds.length
      ? supabaseAdmin.from("meeting_tasks").select("*").in("project_id", projectIds)
      : Promise.resolve({ data: [] as MeetingTask[] }),
    supabaseAdmin
      .from("meetings")
      .select("*")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(5)
  ]);

  const safeRecentMeetings = (recentMeetings ?? []) as Meeting[];
  const recentMeetingIds = safeRecentMeetings.map((meeting) => meeting.id);
  const [{ data: recentMeetingCommitments }, { data: recentMeetingTasks }] = recentMeetingIds.length
    ? await Promise.all([
        supabaseAdmin.from("meeting_commitments").select("*").in("meeting_id", recentMeetingIds),
        supabaseAdmin.from("meeting_tasks").select("*").in("meeting_id", recentMeetingIds)
      ])
    : [{ data: [] as MeetingCommitment[] }, { data: [] as MeetingTask[] }];

  const meetingsByProject = groupBy(
    (projectMeetings ?? []) as Meeting[],
    (meeting) => meeting.project_id
  );
  const commitmentsByProject = groupBy(
    (projectCommitments ?? []) as MeetingCommitment[],
    (commitment) => commitment.project_id
  );
  const tasksByProject = groupBy((projectTasks ?? []) as MeetingTask[], (task) => task.project_id);

  // The single source of truth for "what execution work belongs to this project" -- the exact
  // same helper the Project Workspace page uses, so dashboard counts and per-project counts can
  // never disagree (see Phase 5 consistency requirement). Generation-currency and
  // committed-work filtering happen once, here, inside buildProjectExecutionModel.
  const projectsWithModels = safeProjects.map((project) => ({
    project,
    model: buildProjectExecutionModel({
      project,
      meetings: meetingsByProject.get(project.id) ?? [],
      commitments: commitmentsByProject.get(project.id) ?? [],
      tasks: tasksByProject.get(project.id) ?? []
    })
  }));

  const summary = buildDashboardExecutionSummary(projectsWithModels.map(({ model }) => model));
  const needsAttention = buildNeedsAttention({ projects: projectsWithModels });
  const activeCommitments = buildActiveCommitmentsOverview({ projects: projectsWithModels });

  const commitmentsByMeetingId = groupBy(
    (recentMeetingCommitments ?? []) as MeetingCommitment[],
    (commitment) => commitment.meeting_id
  );
  const tasksByMeetingId = groupBy(
    (recentMeetingTasks ?? []) as MeetingTask[],
    (task) => task.meeting_id
  );
  const recentMeetingImpact = buildRecentMeetingImpact({
    meetings: safeRecentMeetings,
    commitmentsByMeetingId,
    tasksByMeetingId
  });

  const projectsForLibrary = projectsWithModels.map(({ project, model }) => ({
    ...project,
    summary: buildProjectCardSummary(model)
  }));

  const today = new Date();
  const kindStyles: Record<
    "overdue" | "due_soon" | "blocked",
    { dot: string; label: string }
  > = {
    overdue: { dot: "bg-rose-500", label: "Overdue" },
    due_soon: { dot: "bg-amber-500", label: "Due soon" },
    blocked: { dot: "bg-slate-400", label: "Blocked" }
  };

  return (
    <section className="space-y-6">
      <header className="premium-card p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Primary Execution
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Projects</h1>
        <p className="mt-2 text-sm text-slate-600">
          Move initiatives forward through commitments, tasks, and deliverables. Meetings remain
          linked as evidence.
        </p>
      </header>

      {safeProjects.length === 0 ? (
        <ProjectLibrary initialProjects={[]} />
      ) : (
        <>
          {/* Execution summary -- only reliable, execution-oriented counts. No transcript/topic/
              insight metrics belong here (see Phase 5 noise policy). */}
          <div className="premium-card grid grid-cols-2 divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0 sm:divide-x">
            {[
              ["Active Commitments", summary.activeCommitments],
              ["Open Tasks", summary.openTasks],
              ["Due Soon", summary.dueSoon],
              ["Blocked", summary.blocked]
            ].map(([label, value]) => (
              <div key={label as string} className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {label}
                </p>
                <p className="mt-1.5 text-xl font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>

          {needsAttention.length > 0 ? (
            <section className="premium-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-950">Needs Attention</h2>
              <div className="mt-4 space-y-2">
                {needsAttention.map((item) => {
                  const style = kindStyles[item.kind];
                  const days = item.task.due_date ? daysUntilDue(item.task.due_date, today) : null;
                  return (
                    <Link
                      key={item.task.id}
                      href={`/tasks/${item.task.id}` as Route}
                      className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50/40"
                    >
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <span className="font-semibold text-slate-700">{style.label}</span>
                          {days !== null ? (
                            <span className="text-slate-500">{formatDaysUntilDueLabel(days)}</span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-sm font-medium text-slate-900">
                          {item.task.task}
                        </span>
                        <span className="text-xs text-slate-500">{item.projectName}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}

          <ProjectLibrary initialProjects={projectsForLibrary} />

          {activeCommitments.length > 0 ? (
            <section className="premium-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-950">Active Commitments</h2>
              <div className="mt-4 space-y-2">
                {activeCommitments.map((item) => (
                  <Link
                    key={item.commitment.id}
                    href={`/commitments/${item.commitment.id}` as Route}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 transition hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-950">
                        {item.commitment.title}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        <span>{item.commitment.owner || "Unassigned"}</span>
                        {item.commitment.due_date ? (
                          <span>Due {formatReadableDate(item.commitment.due_date)}</span>
                        ) : null}
                        <span>
                          {item.progress.completed}/{item.progress.total} tasks
                        </span>
                        <span>{item.projectName}</span>
                      </span>
                    </span>
                    <span className="tertiary-button px-3 py-1.5 text-xs">Open</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {recentMeetingImpact.length > 0 ? (
            <section className="premium-card p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-950">Recent Meetings</h2>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {recentMeetingImpact.map((item) => (
                  <Link
                    key={item.meeting.id}
                    href={`/meetings/${item.meeting.id}` as Route}
                    className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <p className="text-sm font-semibold text-slate-950">
                      {item.meeting.title || "Untitled meeting"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatReadableDate(item.meeting.created_at)}
                    </p>
                    <p className="mt-2 text-xs text-slate-600">
                      {item.commitments} commitment{item.commitments === 1 ? "" : "s"} ·{" "}
                      {item.tasks} task{item.tasks === 1 ? "" : "s"}
                      {item.futureScope > 0
                        ? ` · ${item.futureScope} future item${item.futureScope === 1 ? "" : "s"}`
                        : ""}
                    </p>
                    <p className="mt-2 text-xs font-semibold text-brand-700">Open meeting →</p>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
