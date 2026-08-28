"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { LiveMeetingStatusBadge } from "@/components/live-meeting-status-badge";
import {
  canEditMeetingUrl,
  MEETING_URL_LOCKED_MESSAGE
} from "@/lib/meeting-details";
import {
  meetingTitleSchema,
  supportedMeetingUrlSchema
} from "@/lib/meeting-form-validation";
import { meetingPlatformLabel } from "@/lib/meeting-platform";
import type { Meeting, Project } from "@/lib/types";

type MeetingResponse = {
  meeting?: Meeting;
  error?: string;
  details?: unknown;
};

function responseError(result: MeetingResponse, fallback: string) {
  if (typeof result.details === "string") return result.details;
  return result.error || fallback;
}

export function MeetingDetailsEditor({
  initialMeeting,
  projects,
  meetingDateLabel,
  participants
}: {
  initialMeeting: Meeting;
  projects: Project[];
  meetingDateLabel: string | null;
  participants: string[];
}) {
  const router = useRouter();
  const [meeting, setMeeting] = useState(initialMeeting);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initialMeeting.title ?? "");
  const [projectId, setProjectId] = useState(initialMeeting.project_id ?? "");
  const [meetingUrl, setMeetingUrl] = useState(initialMeeting.meeting_url);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkEditable = canEditMeetingUrl(meeting);
  const assignedProject = projects.find((project) => project.id === meeting.project_id);

  useEffect(() => {
    setMeeting(initialMeeting);
  }, [initialMeeting]);

  function beginEditing() {
    setTitle(meeting.title ?? "");
    setProjectId(meeting.project_id ?? "");
    setMeetingUrl(meeting.meeting_url);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setTitle(meeting.title ?? "");
    setProjectId(meeting.project_id ?? "");
    setMeetingUrl(meeting.meeting_url);
    setError(null);
    setEditing(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsedTitle = meetingTitleSchema.safeParse(title);
    if (!parsedTitle.success) {
      setError(parsedTitle.error.issues[0]?.message ?? "Meeting title is required.");
      return;
    }

    let normalizedMeetingUrl = meeting.meeting_url;
    if (linkEditable) {
      const parsedUrl = supportedMeetingUrlSchema.safeParse(meetingUrl);
      if (!parsedUrl.success) {
        setError(parsedUrl.error.issues[0]?.message ?? "Meeting link is invalid.");
        return;
      }
      normalizedMeetingUrl = parsedUrl.data;
    }

    setSaving(true);
    let currentMeeting = meeting;
    try {
      const detailPatch: Record<string, string> = {};
      if (parsedTitle.data !== meeting.title) detailPatch.title = parsedTitle.data;
      if (linkEditable && normalizedMeetingUrl !== meeting.meeting_url) {
        detailPatch.meeting_url = normalizedMeetingUrl;
      }

      if (Object.keys(detailPatch).length > 0) {
        const response = await fetch(`/api/meetings/${meeting.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(detailPatch)
        });
        const result = (await response.json().catch(() => ({}))) as MeetingResponse;
        if (!response.ok || !result.meeting) {
          setError(responseError(result, "Failed to update meeting details."));
          return;
        }
        currentMeeting = result.meeting;
        setMeeting(currentMeeting);
      }

      const normalizedProjectId = projectId || null;
      if (normalizedProjectId !== (currentMeeting.project_id ?? null)) {
        const response = await fetch(`/api/meetings/${meeting.id}/project`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: normalizedProjectId })
        });
        const result = (await response.json().catch(() => ({}))) as MeetingResponse;
        if (!response.ok || !result.meeting) {
          setError(responseError(result, "Failed to assign project."));
          return;
        }
        currentMeeting = result.meeting;
        setMeeting(currentMeeting);
      }

      setTitle(currentMeeting.title ?? "");
      setProjectId(currentMeeting.project_id ?? "");
      setMeetingUrl(currentMeeting.meeting_url);
      setEditing(false);
      router.refresh();
    } catch {
      setError("Unable to save meeting details. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`premium-card p-5 transition-colors sm:p-6 ${
        editing ? "border-slate-300 bg-slate-50/70" : ""
      }`}
    >
      <form onSubmit={save}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Meeting Detail
            </p>

            {editing ? (
              <label className="block max-w-2xl text-sm font-medium text-slate-700">
                Title
                <input
                  className="premium-input mt-1.5"
                  value={title}
                  maxLength={200}
                  disabled={saving}
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            ) : (
              <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-slate-950 sm:text-[1.65rem]">
                {meeting.title ?? "Untitled meeting"}
              </h1>
            )}

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-slate-500">
              <span className="badge-meta">{meetingPlatformLabel(meeting.platform)}</span>
              {meetingDateLabel ? <span>{meetingDateLabel}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            {!editing ? (
              <button
                type="button"
                className="secondary-button !px-3 !py-1.5 text-xs"
                onClick={beginEditing}
              >
                Edit Meeting
              </button>
            ) : null}
            <LiveMeetingStatusBadge meetingId={meeting.id} initialStatus={meeting.status} />
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <div className="grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-6">
            {editing ? (
              <label className="block max-w-md">
                <span className="mb-1.5 block text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  Project
                </span>
                <select
                  className="premium-input"
                  value={projectId}
                  disabled={saving}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div>
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  Project
                </p>
                {assignedProject ? (
                  <Link
                    href={`/projects/${assignedProject.id}` as Route}
                    className="mt-1 block text-sm font-semibold text-slate-900 hover:text-brand-700"
                  >
                    {assignedProject.name}
                  </Link>
                ) : (
                  <span className="mt-1 block text-sm font-semibold text-slate-700">
                    Unassigned
                  </span>
                )}
              </div>
            )}

            {participants.length > 0 ? (
              <div>
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  Participants
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {participants.map((participant) => (
                    <span
                      key={participant}
                      className="rounded-md border border-slate-200 bg-white/70 px-2 py-0.5 text-xs font-medium text-slate-600"
                    >
                      {participant}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {editing ? (
            <div className="max-w-2xl border-t border-slate-200 pt-3.5">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-slate-400">
                Technical Details
              </p>
              <label className="mt-3 block text-sm font-medium text-slate-700">
                Meeting Link
                <input
                  className="premium-input mt-1.5 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                  type="url"
                  value={meetingUrl}
                  disabled={saving || !linkEditable}
                  onChange={(event) => setMeetingUrl(event.target.value)}
                />
              </label>
              {!linkEditable ? (
                <p className="mt-1.5 text-xs leading-5 text-slate-500">
                  {MEETING_URL_LOCKED_MESSAGE}
                </p>
              ) : null}
              {meeting.recall_bot_id ? (
                <p className="mt-2 text-xs text-slate-500">
                  Recall Bot ID: <span className="font-mono">{meeting.recall_bot_id}</span>
                </p>
              ) : null}
            </div>
          ) : meeting.meeting_url || meeting.recall_bot_id ? (
            <details className="disclosure border-t border-slate-100 pt-2.5">
              <summary className="!font-medium !text-slate-400 hover:!text-slate-600">
                Technical details
              </summary>
              <dl className="mt-2.5 grid gap-2 border-l-2 border-slate-100 pl-3 text-xs">
                {meeting.meeting_url ? (
                  <div>
                    <dt className="font-medium text-slate-400">Meeting link</dt>
                    <dd className="mt-0.5 break-all text-slate-600">
                      {meeting.meeting_url}
                    </dd>
                  </div>
                ) : null}
                {meeting.recall_bot_id ? (
                  <div>
                    <dt className="font-medium text-slate-400">Recall Bot ID</dt>
                    <dd className="mt-0.5 break-all font-mono text-slate-600">
                      {meeting.recall_bot_id}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </details>
          ) : null}

          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
        </div>

        {editing ? (
          <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3.5">
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={cancelEditing}
            >
              Cancel
            </button>
            <button type="submit" className="premium-button" disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
