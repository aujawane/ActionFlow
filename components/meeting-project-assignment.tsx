"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { Project } from "@/lib/types";

export function MeetingProjectAssignment({
  meetingId,
  currentProjectId,
  projects
}: {
  meetingId: string;
  currentProjectId: string | null;
  projects: Project[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(currentProjectId ?? "");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compact by default whenever a project is already assigned -- the picker/create form only
  // takes over once the user asks to change it. Reopens automatically if assignment is cleared.
  const [editing, setEditing] = useState(!currentProjectId);

  useEffect(() => {
    if (!projectId) setEditing(true);
  }, [projectId]);

  async function assign(payload: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/meetings/${meetingId}/project`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setError(result.details || result.error || "Failed to assign project.");
      return;
    }
    setProjectId(result.project_id ?? "");
    setCreating(false);
    setName("");
    setGoal("");
    setEditing(!result.project_id);
    router.refresh();
  }

  const assignedProject = projects.find((project) => project.id === projectId);

  // Compact, single-line presentation once a project is assigned -- matches Phase 2's "visible
  // but should not dominate the page" requirement. The full picker/create form (below) is the
  // same form as before, just reached via "Change" instead of always being on screen.
  if (!editing && assignedProject) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">Project</span>
        <Link
          href={`/projects/${assignedProject.id}` as Route}
          className="font-semibold text-slate-900 hover:text-brand-700"
        >
          {assignedProject.name}
        </Link>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="tertiary-button px-2 py-1 text-xs"
        >
          Change
        </button>
        {error ? <p className="w-full text-sm text-rose-700">{error}</p> : null}
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-sm font-medium text-slate-700">
          Project / Initiative
          <select
            className="premium-input mt-2"
            value={projectId}
            disabled={saving}
            onChange={(event) => {
              const next = event.target.value;
              setProjectId(next);
              void assign({ project_id: next || null });
            }}
          >
            <option value="">Unassigned</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? "Cancel" : "Create New Project"}
        </button>
      </div>
      {creating ? (
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_2fr_auto]">
          <input
            className="premium-input"
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="premium-input"
            placeholder="Project goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <button
            type="button"
            className="premium-button"
            disabled={saving || !name.trim()}
            onClick={() =>
              void assign({
                new_project: {
                  name: name.trim(),
                  goal: goal.trim() || null
                }
              })
            }
          >
            Create & Assign
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
    </section>
  );
}
