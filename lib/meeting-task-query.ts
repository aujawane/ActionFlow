import type { MeetingTask } from "@/lib/types";

type QueryError = { code?: string; message?: string } | null;
type TaskQueryResult = { data: unknown[] | null; error: QueryError };
type TaskFetcher = (columns: string) => PromiseLike<TaskQueryResult>;

export const CURRENT_TASK_COLUMNS =
  "id, meeting_id, topic_id, commitment_id, task, owner, owners, task_type, priority, suggested_steps, source_quote, source_segment_ids, confidence, status, due_date, due_date_text, workspace_type, workspace_summary, inferred, extraction_metadata, rationale, supporting_context, categorization_metadata, created_at";

export const LEGACY_TASK_COLUMNS =
  "id, meeting_id, topic_id, task, owner, task_type, priority, suggested_steps, source_quote, confidence, status, due_date, workspace_type, workspace_summary, rationale, supporting_context, categorization_metadata, created_at";

const OPTIONAL_EXECUTION_COLUMNS = [
  "commitment_id",
  "owners",
  "source_segment_ids",
  "due_date_text",
  "inferred",
  "extraction_metadata"
];

export function isMissingOptionalTaskColumnError(error: QueryError) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = error.message?.toLowerCase() ?? "";
  return OPTIONAL_EXECUTION_COLUMNS.some((column) => message.includes(column));
}

export async function loadMeetingTasksWithFallback(fetchRows: TaskFetcher): Promise<{
  data: MeetingTask[];
  error: QueryError;
  usedLegacyFallback: boolean;
}> {
  const current = await fetchRows(CURRENT_TASK_COLUMNS);
  if (!current.error) {
    return {
      data: (current.data ?? []) as MeetingTask[],
      error: null,
      usedLegacyFallback: false
    };
  }
  if (!isMissingOptionalTaskColumnError(current.error)) {
    return { data: [], error: current.error, usedLegacyFallback: false };
  }

  const legacy = await fetchRows(LEGACY_TASK_COLUMNS);
  return {
    data: (legacy.data ?? []) as MeetingTask[],
    error: legacy.error,
    usedLegacyFallback: true
  };
}
