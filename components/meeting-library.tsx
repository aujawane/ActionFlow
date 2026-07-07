"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import type { Meeting } from "@/lib/types";

type SortOption = "newest" | "oldest" | "title_asc" | "title_desc";

type MeetingApiResponse = {
  meeting?: Meeting;
  error?: string;
  details?: string;
};

function getMeetingTitle(meeting: Meeting) {
  return meeting.title?.trim() || "Untitled meeting";
}

function getMeetingDate(meeting: Meeting) {
  return new Date(meeting.created_at);
}

function getMonthLabel(meeting: Meeting) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric"
  }).format(getMeetingDate(meeting));
}

function sortMeetings(meetings: Meeting[], sortOption: SortOption) {
  return [...meetings].sort((a, b) => {
    if (sortOption === "oldest") {
      return getMeetingDate(a).getTime() - getMeetingDate(b).getTime();
    }
    if (sortOption === "title_asc") {
      return getMeetingTitle(a).localeCompare(getMeetingTitle(b));
    }
    if (sortOption === "title_desc") {
      return getMeetingTitle(b).localeCompare(getMeetingTitle(a));
    }
    return getMeetingDate(b).getTime() - getMeetingDate(a).getTime();
  });
}

function groupByMonth(meetings: Meeting[]) {
  const groups = new Map<string, Meeting[]>();
  for (const meeting of meetings) {
    const month = getMonthLabel(meeting);
    groups.set(month, [...(groups.get(month) ?? []), meeting]);
  }
  return Array.from(groups.entries());
}

export function MeetingLibrary({ initialMeetings }: { initialMeetings: Meeting[] }) {
  const [meetings, setMeetings] = useState(initialMeetings);
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [monthFilter, setMonthFilter] = useState("all");
  const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const monthOptions = useMemo(() => {
    const sortedByNewest = sortMeetings(meetings, "newest");
    return Array.from(new Set(sortedByNewest.map((meeting) => getMonthLabel(meeting))));
  }, [meetings]);

  const filteredMeetings = useMemo(() => {
    const filtered =
      monthFilter === "all"
        ? meetings
        : meetings.filter((meeting) => getMonthLabel(meeting) === monthFilter);
    return sortMeetings(filtered, sortOption);
  }, [meetings, monthFilter, sortOption]);

  const pinnedMeetings = filteredMeetings.filter((meeting) => meeting.is_pinned);
  const unpinnedMeetings = filteredMeetings.filter((meeting) => !meeting.is_pinned);
  const groupedMeetings = groupByMonth(unpinnedMeetings);

  async function togglePin(meeting: Meeting) {
    setBusyMeetingId(meeting.id);
    setMessage(null);

    const nextPinned = !meeting.is_pinned;
    setMeetings((current) =>
      current.map((item) =>
        item.id === meeting.id ? { ...item, is_pinned: nextPinned } : item
      )
    );

    const response = await fetch(`/api/meetings/${meeting.id}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_pinned: nextPinned })
    });
    const result = (await response.json().catch(() => ({}))) as MeetingApiResponse;
    setBusyMeetingId(null);

    if (!response.ok || !result.meeting) {
      setMeetings((current) =>
        current.map((item) =>
          item.id === meeting.id ? { ...item, is_pinned: meeting.is_pinned } : item
        )
      );
      setMessage(result.error || "Failed to update pinned state.");
      return;
    }

    setMeetings((current) =>
      current.map((item) => (item.id === result.meeting!.id ? result.meeting! : item))
    );
  }

  async function deleteMeeting(meeting: Meeting) {
    const confirmed = window.confirm(
      `Delete "${getMeetingTitle(meeting)}"? This hides it from your meeting library.`
    );
    if (!confirmed) return;

    setBusyMeetingId(meeting.id);
    setMessage(null);

    const previousMeetings = meetings;
    setMeetings((current) => current.filter((item) => item.id !== meeting.id));

    const response = await fetch(`/api/meetings/${meeting.id}`, { method: "DELETE" });
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    setBusyMeetingId(null);

    if (!response.ok) {
      setMeetings(previousMeetings);
      setMessage(result.error || "Failed to delete meeting.");
    }
  }

  if (meetings.length === 0) {
    return (
      <div className="premium-empty">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-semibold text-white shadow-lg shadow-brand-700/20">
          +
        </div>
        <p className="mt-4 text-base font-semibold text-slate-900">No meetings yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
          Create your first meeting to start ingesting transcript events and extracting action
          items.
        </p>
        <Link href="/meetings/new" className="premium-button mt-5">
          Create First Meeting
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="premium-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Meeting Library</h2>
          <p className="mt-1 text-xs text-slate-500">
            Browse, pin, sort, filter, and clean up your meetings.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Sort
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as SortOption)}
              className="premium-input mt-1 min-w-40 text-sm normal-case tracking-normal"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title_asc">Title A-Z</option>
              <option value="title_desc">Title Z-A</option>
            </select>
          </label>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Month
            <select
              value={monthFilter}
              onChange={(event) => setMonthFilter(event.target.value)}
              className="premium-input mt-1 min-w-40 text-sm normal-case tracking-normal"
            >
              <option value="all">All months</option>
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {message ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {message}
        </p>
      ) : null}

      {filteredMeetings.length === 0 ? (
        <div className="premium-empty p-8">
          <p className="text-sm font-semibold text-slate-800">No meetings match this filter.</p>
          <p className="mt-1 text-sm text-slate-600">Try choosing All months.</p>
        </div>
      ) : (
        <>
          {pinnedMeetings.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">Pinned Meetings</h2>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {pinnedMeetings.map((meeting) => (
                  <MeetingLibraryCard
                    key={meeting.id}
                    meeting={meeting}
                    busy={busyMeetingId === meeting.id}
                    onTogglePin={togglePin}
                    onDelete={deleteMeeting}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <div className="space-y-6">
            {groupedMeetings.map(([month, monthMeetings]) => (
              <section key={month} className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-900">{month}</h2>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {monthMeetings.map((meeting) => (
                    <MeetingLibraryCard
                      key={meeting.id}
                      meeting={meeting}
                      busy={busyMeetingId === meeting.id}
                      onTogglePin={togglePin}
                      onDelete={deleteMeeting}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MeetingLibraryCard({
  meeting,
  busy,
  onTogglePin,
  onDelete
}: {
  meeting: Meeting;
  busy: boolean;
  onTogglePin: (meeting: Meeting) => void;
  onDelete: (meeting: Meeting) => void;
}) {
  return (
    <article className="premium-card premium-card-hover group p-5">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/meetings/${meeting.id}`} className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">
              {getMeetingTitle(meeting)}
            </h3>
          </Link>
          <MeetingStatusBadge status={meeting.status} />
        </div>

        <Link
          href={`/meetings/${meeting.id}`}
          className="line-clamp-1 rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-500 transition group-hover:bg-brand-50/70 group-hover:text-brand-800"
        >
          {meeting.meeting_url}
        </Link>

        {meeting.recall_bot_id ? (
          <p className="line-clamp-1 text-xs text-slate-500">
            Bot ID: <span className="font-mono">{meeting.recall_bot_id}</span>
          </p>
        ) : meeting.status === "failed" ? (
          <p className="text-xs text-rose-600">Bot creation failed. Open meeting for details.</p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Created {getMeetingDate(meeting).toLocaleDateString()}
          </p>
          <Link
            href={`/meetings/${meeting.id}`}
            className="text-xs font-semibold text-brand-700 transition hover:text-brand-800"
          >
            Open
          </Link>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={() => onTogglePin(meeting)}
            disabled={busy}
            className="rounded-xl border border-brand-100 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-800 transition hover:border-brand-200 hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {meeting.is_pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(meeting)}
            disabled={busy}
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}
