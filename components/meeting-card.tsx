import Link from "next/link";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import type { Meeting } from "@/lib/types";

export function MeetingCard({ meeting }: { meeting: Meeting }) {
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className="premium-card premium-card-hover group block p-5"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">
            {meeting.title ?? "Untitled meeting"}
          </h3>
          <MeetingStatusBadge status={meeting.status} />
        </div>

        <p className="line-clamp-1 rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-500 transition group-hover:bg-brand-50/70 group-hover:text-brand-800">
          {meeting.meeting_url}
        </p>

        {meeting.recall_bot_id ? (
          <p className="line-clamp-1 text-xs text-slate-500">
            Bot ID: <span className="font-mono">{meeting.recall_bot_id}</span>
          </p>
        ) : meeting.status === "failed" ? (
          <p className="text-xs text-rose-600">
            Bot creation failed. Open meeting for details.
          </p>
        ) : null}

        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Created {new Date(meeting.created_at).toLocaleDateString()}
          </p>
          <p className="text-xs font-semibold text-brand-700 transition group-hover:translate-x-0.5">
            Open
          </p>
        </div>
      </div>
    </Link>
  );
}
