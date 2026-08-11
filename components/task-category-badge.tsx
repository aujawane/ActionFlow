import { getCategoryDisplayLabel, getTaskCategorization } from "@/lib/task-deliverables";
import type { MeetingTask } from "@/lib/types";

export function TaskCategoryBadge({ task }: { task: MeetingTask }) {
  const categorization = getTaskCategorization(task);
  return <span className="badge-meta">{getCategoryDisplayLabel(categorization.category)}</span>;
}
