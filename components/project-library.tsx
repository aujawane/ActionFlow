"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { formatReadableDate } from "@/lib/format-date";
import type { ProjectCardSummary } from "@/lib/execution-dashboard";
import type { Project } from "@/lib/types";

const EMPTY_SUMMARY: ProjectCardSummary = {
  activeCommitments: 0,
  openTasks: 0,
  blockedTasks: 0,
  progress: { completed: 0, total: 0, percent: 0 },
  nextDeadline: null
};

type ProjectWithSummary = Project & { summary?: ProjectCardSummary };

export function ProjectLibrary({
  initialProjects
}: {
  initialProjects: ProjectWithSummary[];
}) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [creating, setCreating] = useState(initialProjects.length === 0);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        goal: goal.trim() || null,
        status: "planning"
      })
    });
    const result = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok || !result.project) {
      setError(result.details || result.error || "Failed to create project.");
      return;
    }
    setProjects((current) => [result.project as Project, ...current]);
    setName("");
    setGoal("");
    setCreating(false);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {creating ? (
        <form onSubmit={createProject} className="premium-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-950">Create Project</h2>
            {projects.length > 0 ? (
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="tertiary-button px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_2fr_auto]">
            <input
              className="premium-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              maxLength={160}
            />
            <input
              className="premium-input"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Goal (optional)"
              maxLength={2000}
            />
            <button className="premium-button" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create Project"}
            </button>
          </div>
          {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">Your Projects</h2>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="secondary-button px-3 py-1.5 text-sm"
          >
            + New Project
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="premium-empty-compact">
          <p className="text-sm font-medium text-slate-700">No projects yet.</p>
          <p className="mt-1 text-sm text-slate-600">
            Create a project to organize commitments and tasks from your meetings.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectWithSummary }) {
  const summary = project.summary ?? EMPTY_SUMMARY;
  const hasExecutionWork = summary.activeCommitments > 0 || summary.openTasks > 0;

  return (
    <Link
      href={`/projects/${project.id}` as Route}
      className="premium-card premium-card-hover group block p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 flex-1 font-semibold text-slate-950">{project.name}</h2>
        <span className="badge-meta capitalize">{project.status.replace("_", " ")}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
        {project.goal || project.description || "No project goal set yet."}
      </p>

      {hasExecutionWork ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <span>
              {summary.activeCommitments} active commitment{summary.activeCommitments === 1 ? "" : "s"}
            </span>
            <span>
              {summary.openTasks} open task{summary.openTasks === 1 ? "" : "s"}
            </span>
            {summary.blockedTasks > 0 ? (
              <span className="badge-state border-rose-200 bg-rose-50 text-rose-700">
                {summary.blockedTasks} blocked
              </span>
            ) : null}
          </div>

          {summary.nextDeadline ? (
            <p className="text-xs text-slate-500">
              Next deadline: {formatReadableDate(summary.nextDeadline)}
            </p>
          ) : null}

          {summary.progress.total > 0 ? (
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Progress</span>
                <span>
                  {summary.progress.completed} / {summary.progress.total} tasks complete
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${summary.progress.percent}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500">
          No active work yet. Analyze a meeting or connect a meeting to this project.
        </p>
      )}

      <p className="mt-4 text-xs font-semibold text-brand-700 transition group-hover:translate-x-0.5">
        Open project →
      </p>
    </Link>
  );
}
