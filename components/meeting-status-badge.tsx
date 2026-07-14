import type { Meeting } from "@/lib/types";

const stylesByStatus: Record<Meeting["status"], string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-200",
  joining: "bg-brand-50 text-brand-800 border-brand-200",
  recording: "bg-amber-50 text-amber-700 border-amber-200",
  processing: "bg-purple-50 text-purple-700 border-purple-200",
  completed: "bg-brand-50 text-brand-800 border-brand-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200"
};

export function MeetingStatusBadge({ status }: { status: Meeting["status"] }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize shadow-sm ${stylesByStatus[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replace("_", " ")}
    </span>
  );
}
