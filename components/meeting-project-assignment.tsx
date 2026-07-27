"use client";

import { useState } from "react";
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
    router.refresh();
  }

  return (
    <section className="premium-card p-5">
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
