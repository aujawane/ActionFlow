"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { Project } from "@/lib/types";

export function ProjectLibrary({
  initialProjects
}: {
  initialProjects: Project[];
}) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
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
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={createProject} className="premium-card p-5">
        <h2 className="text-lg font-semibold text-slate-950">Create Project</h2>
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

      {projects.length === 0 ? (
        <div className="premium-empty-compact">
          <p className="text-sm text-slate-600">
            Create a project, then assign meetings as evidence for its milestones.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}` as Route}
              className="premium-card premium-card-hover group block p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 flex-1 font-semibold text-slate-950">{project.name}</h2>
                <span className="badge-meta">{project.status.replace("_", " ")}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                {project.goal || project.description || "No project goal set yet."}
              </p>
              <p className="mt-4 text-xs font-semibold text-brand-700 transition group-hover:translate-x-0.5">
                Continue project →
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
