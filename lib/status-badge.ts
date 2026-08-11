/** Shared primary-state badge styling for commitments and tasks (both use the same status enum
 * shape: pending | in_progress | blocked | completed | dismissed). Centralized so every card
 * (commitment cards, task cards, standalone tasks) presents execution status with the same,
 * easy-to-scan color language instead of each screen inventing its own. */
const STATE_STYLES: Record<string, string> = {
  pending: "border-slate-200 bg-slate-50 text-slate-700",
  in_progress: "border-sky-200 bg-sky-50 text-sky-800",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
  completed: "border-brand-200 bg-brand-50 text-brand-800",
  dismissed: "border-slate-200 bg-slate-50 text-slate-400"
};

export function statusBadgeClassName(status: string): string {
  return STATE_STYLES[status] ?? STATE_STYLES.pending;
}

export function formatStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}
