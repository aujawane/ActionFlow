"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  FollowUpEmailMode,
  MeetingArtifact,
  MeetingTask
} from "@/lib/types";

type ApiError = { error?: string; details?: string };

function metadataString(artifact: MeetingArtifact, key: string) {
  const value = artifact.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataStringArray(artifact: MeetingArtifact, key: string) {
  const value = artifact.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function artifactIdentity(artifact: MeetingArtifact) {
  if (artifact.artifact_type === "follow_up_email_team_summary") return "team_summary";
  return `individual:${metadataString(artifact, "recipient_name")?.toLowerCase() ?? artifact.id}`;
}

function mergeArtifacts(current: MeetingArtifact[], incoming: MeetingArtifact[]) {
  const incomingKeys = new Set(incoming.map(artifactIdentity));
  return [...incoming, ...current.filter((artifact) => !incomingKeys.has(artifactIdentity(artifact)))]
    .sort((a, b) => {
      if (a.artifact_type !== b.artifact_type) {
        return a.artifact_type === "follow_up_email_individual" ? -1 : 1;
      }
      return (metadataString(a, "recipient_name") ?? "").localeCompare(
        metadataString(b, "recipient_name") ?? ""
      );
    });
}

async function parseJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
}

export function MeetingFollowUpEmails({
  meetingId,
  tasks
}: {
  meetingId: string;
  tasks: MeetingTask[];
}) {
  const [artifacts, setArtifacts] = useState<MeetingArtifact[]>([]);
  const [mode, setMode] = useState<FollowUpEmailMode>("individual");
  const [showGenerator, setShowGenerator] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const assignedTaskCount = useMemo(
    () =>
      tasks.filter((task) => {
        const owner = task.owner?.trim();
        return Boolean(owner && owner.toLowerCase() !== "unassigned");
      }).length,
    [tasks]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadArtifacts() {
      setLoadingExisting(true);
      const response = await fetch(`/api/meetings/${meetingId}/follow-up-emails`, {
        cache: "no-store"
      });
      const result = await parseJson<{ artifacts?: MeetingArtifact[] } & ApiError>(
        response
      );
      if (cancelled) return;
      setLoadingExisting(false);
      if (!response.ok) {
        setError(result.error || "Unable to load follow-up emails.");
        return;
      }
      setArtifacts(result.artifacts ?? []);
    }
    void loadArtifacts();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  async function generate(input: {
    mode: FollowUpEmailMode;
    regenerate: boolean;
    recipientName?: string;
    artifactId?: string;
  }) {
    if (input.artifactId) setRegeneratingId(input.artifactId);
    else setGenerating(true);
    setError(null);
    setMessage(null);

    const response = await fetch(
      `/api/meetings/${meetingId}/follow-up-emails/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: input.mode,
          regenerate: input.regenerate,
          recipient_name: input.recipientName
        })
      }
    );
    const result = await parseJson<{
      artifacts?: MeetingArtifact[];
      reused?: boolean;
    } & ApiError>(response);
    setGenerating(false);
    setRegeneratingId(null);

    if (!response.ok || !result.artifacts) {
      setError(result.error || "Unable to generate follow-up emails.");
      return;
    }

    setArtifacts((current) => mergeArtifacts(current, result.artifacts!));
    setShowGenerator(false);
    setMessage(
      result.reused ? "Showing saved email drafts." : "Email drafts generated."
    );
  }

  function updateArtifact(updated: MeetingArtifact) {
    setArtifacts((current) =>
      current.map((artifact) => (artifact.id === updated.id ? updated : artifact))
    );
  }

  const individualArtifacts = artifacts.filter(
    (artifact) => artifact.artifact_type === "follow_up_email_individual"
  );
  const teamArtifacts = artifacts.filter(
    (artifact) => artifact.artifact_type === "follow_up_email_team_summary"
  );
  const noTasks = tasks.length === 0;

  return (
    <section className="rounded-2xl border border-brand-100 bg-brand-50/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Meeting follow-up
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-950">
            Follow-up email drafts
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Turn assigned action items into editable emails. Nothing is sent automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowGenerator((current) => !current);
            setError(null);
          }}
          disabled={noTasks}
          className="premium-button"
        >
          Generate follow-up emails
        </button>
      </div>

      {noTasks ? (
        <p className="mt-4 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
          No tasks found for this meeting yet.
        </p>
      ) : null}

      {showGenerator && !noTasks ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">
              Choose an email format
            </legend>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label
                className={`cursor-pointer rounded-xl border p-4 transition ${
                  mode === "individual"
                    ? "border-brand-400 bg-brand-50"
                    : "border-slate-200 hover:border-brand-200"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="follow-up-mode"
                    value="individual"
                    checked={mode === "individual"}
                    onChange={() => setMode("individual")}
                  />
                  <span className="text-sm font-semibold text-slate-900">
                    Individual emails
                  </span>
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                    Recommended
                  </span>
                </span>
                <span className="mt-2 block text-sm text-slate-600">
                  Create separate emails with each person&apos;s assigned tasks.
                </span>
              </label>
              <label
                className={`cursor-pointer rounded-xl border p-4 transition ${
                  mode === "team_summary"
                    ? "border-brand-400 bg-brand-50"
                    : "border-slate-200 hover:border-brand-200"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="follow-up-mode"
                    value="team_summary"
                    checked={mode === "team_summary"}
                    onChange={() => setMode("team_summary")}
                  />
                  <span className="text-sm font-semibold text-slate-900">
                    Team summary email
                  </span>
                </span>
                <span className="mt-2 block text-sm text-slate-600">
                  Create one email with everyone&apos;s action items.
                </span>
              </label>
            </div>
          </fieldset>

          {mode === "individual" && assignedTaskCount === 0 ? (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Individual emails require assigned tasks. Use Team summary email instead or
              assign tasks first.
            </p>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowGenerator(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="premium-button"
              disabled={generating || (mode === "individual" && assignedTaskCount === 0)}
              onClick={() =>
                void generate({ mode, regenerate: false })
              }
            >
              {generating ? "Generating..." : "Generate drafts"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-4 rounded-xl border border-brand-100 bg-white px-3 py-2 text-sm font-medium text-brand-800">
          {message}
        </p>
      ) : null}

      {loadingExisting ? (
        <p className="mt-4 text-sm text-slate-500">Loading saved email drafts...</p>
      ) : null}

      {individualArtifacts.length > 0 ? (
        <div className="mt-5 space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">Individual emails</h4>
          {individualArtifacts.map((artifact) => (
            <EmailDraftCard
              key={artifact.id}
              artifact={artifact}
              tasks={tasks}
              regenerating={regeneratingId === artifact.id}
              onUpdated={updateArtifact}
              onRegenerate={() =>
                void generate({
                  mode: "individual",
                  regenerate: true,
                  recipientName: metadataString(artifact, "recipient_name") ?? undefined,
                  artifactId: artifact.id
                })
              }
            />
          ))}
        </div>
      ) : null}

      {teamArtifacts.length > 0 ? (
        <div className="mt-5 space-y-3">
          <h4 className="text-sm font-semibold text-slate-900">Team summary</h4>
          {teamArtifacts.map((artifact) => (
            <EmailDraftCard
              key={artifact.id}
              artifact={artifact}
              tasks={tasks}
              regenerating={regeneratingId === artifact.id}
              onUpdated={updateArtifact}
              onRegenerate={() =>
                void generate({
                  mode: "team_summary",
                  regenerate: true,
                  artifactId: artifact.id
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function EmailDraftCard({
  artifact,
  tasks,
  regenerating,
  onUpdated,
  onRegenerate
}: {
  artifact: MeetingArtifact;
  tasks: MeetingTask[];
  regenerating: boolean;
  onUpdated: (artifact: MeetingArtifact) => void;
  onRegenerate: () => void;
}) {
  const [title, setTitle] = useState(artifact.title);
  const [content, setContent] = useState(artifact.content ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setTitle(artifact.title);
    setContent(artifact.content ?? "");
  }, [artifact]);

  const taskIds = new Set([
    ...metadataStringArray(artifact, "task_ids"),
    ...metadataStringArray(artifact, "included_task_ids")
  ]);
  const relatedTasks = tasks.filter((task) => taskIds.has(task.id));
  const recipientName = metadataString(artifact, "recipient_name");
  const recipientEmail = metadataString(artifact, "recipient_email");

  async function save() {
    setSaving(true);
    setStatus(null);
    const response = await fetch(`/api/meeting-artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content })
    });
    const result = await parseJson<{ artifact?: MeetingArtifact } & ApiError>(response);
    setSaving(false);
    if (!response.ok || !result.artifact) {
      setStatus(result.error || "Unable to save edits.");
      return;
    }
    onUpdated(result.artifact);
    setStatus("Edits saved.");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`Subject: ${title}\n\n${content}`);
      setStatus("Copied to clipboard.");
    } catch {
      setStatus("Unable to copy this email.");
    }
  }

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            {recipientName ?? "Everyone"}
          </p>
          {recipientName ? (
            <p className="mt-0.5 text-xs text-slate-500">
              {recipientEmail || "Email unknown"}
            </p>
          ) : null}
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
          Version {artifact.version}
        </span>
      </div>

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        Subject
      </label>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="premium-input mt-1 text-sm"
      />

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        Email body
      </label>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={12}
        className="premium-input mt-1 resize-y whitespace-pre-wrap text-sm leading-6"
      />

      {relatedTasks.length > 0 ? (
        <div className="mt-4 rounded-xl bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Related tasks
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {relatedTasks.map((task) => (
              <li key={task.id}>{task.task}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="secondary-button" onClick={() => void copy()}>
          Copy subject + body
        </button>
        <button
          type="button"
          className="premium-button"
          disabled={saving || !title.trim() || !content.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save edits"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          {regenerating ? "Regenerating..." : "Regenerate"}
        </button>
      </div>
      {status ? <p className="mt-3 text-xs font-medium text-slate-600">{status}</p> : null}
    </article>
  );
}
