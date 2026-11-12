import type { MeetingSource } from "@/lib/types";

/** Every allowed meetings.source value. Must match meetings_source_check in
 * supabase/migrations/20261111090000_add_manual_transcript_import_foundation.sql. */
export const MEETING_SOURCES = ["recall", "manual_upload", "manual_paste"] as const satisfies
  readonly MeetingSource[];

export function isMeetingSource(value: unknown): value is MeetingSource {
  return typeof value === "string" && (MEETING_SOURCES as readonly string[]).includes(value);
}

/**
 * Where a meeting's transcript came from. A missing value means "recall": that is the column
 * default every pre-existing meeting receives, and it is also what a row read before the column
 * exists (or a query that did not select it) must mean.
 *
 * This is the only supported way to ask the question. Never infer the source from recall_bot_id:
 * a Recall meeting whose bot creation failed also has a null recall_bot_id.
 */
export function getMeetingSource(meeting: { source?: string | null }): MeetingSource {
  return isMeetingSource(meeting.source) ? meeting.source : "recall";
}

/** True only for meetings captured by the Recall bot -- the meetings for which Recall-only
 * controls (Sync Status, bot details, link editing, live-status polling) make sense. */
export function isRecallMeeting(meeting: { source?: string | null }): boolean {
  return getMeetingSource(meeting) === "recall";
}

/** Label for where a meeting's transcript came from, for the places the Recall meeting shows its
 * provider (Zoom / Google Meet). Imported meetings have no provider. */
export function importedMeetingLabel(meeting: { source?: string | null }): string | null {
  return isRecallMeeting(meeting) ? null : "Imported transcript";
}
