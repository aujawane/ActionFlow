import Link from "next/link";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import type { Meeting } from "@/lib/types";

export function MeetingCard({ meeting }: { meeting: Meeting }) {
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">
            {meeting.title ?? "Untitled meeting"}
          </h3>
          <MeetingStatusBadge status={meeting.status} />
        </div>

        <p className="line-clamp-1 text-xs text-slate-500">{meeting.meeting_url}</p>

        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Created {new Date(meeting.created_at).toLocaleDateString()}
          </p>
          <p className="text-xs font-medium text-brand-600">Open</p>
        </div>
      </div>
    </Link>
  );
}
