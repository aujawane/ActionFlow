import Link from "next/link";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import type { Meeting } from "@/lib/types";

export function MeetingCard({ meeting }: { meeting: Meeting }) {
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-900">
            {meeting.title ?? "Untitled meeting"}
          </h3>
          <p className="text-xs text-slate-500">{meeting.meeting_url}</p>
        </div>
        <MeetingStatusBadge status={meeting.status} />
      </div>
    </Link>
  );
}
