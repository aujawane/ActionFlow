import { getCategoryDisplayLabel, getTaskCategorization } from "@/lib/task-deliverables";
import type { MeetingTask } from "@/lib/types";

export function TaskCategoryBadge({ task }: { task: MeetingTask }) {
  const categorization = getTaskCategorization(task);
  return (
    <span className="rounded-full border border-brand-100 bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-800">
      {getCategoryDisplayLabel(categorization.category)}
    </span>
  );
}
