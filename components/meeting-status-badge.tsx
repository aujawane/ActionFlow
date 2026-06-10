import type { Meeting } from "@/lib/types";

const stylesByStatus: Record<Meeting["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  joining: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700"
};

export function MeetingStatusBadge({ status }: { status: Meeting["status"] }) {
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium ${stylesByStatus[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}
