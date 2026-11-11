/**
 * When a meeting actually happened, as opposed to when its Parfait record was created.
 *
 * - `meeting_date` (YYYY-MM-DD, nullable) is set only for a historical import whose real date is
 *   known. It is a calendar date with no time of day, so none is invented.
 * - `created_at` is when the Parfait record was created. For a Recall meeting that is effectively
 *   when the meeting happened (the bot is sent to a live call), which is why every existing caller
 *   used it as the meeting date and why a Recall meeting's result is unchanged here.
 *
 * Use this wherever a value means "the day the meeting took place": the meeting_date given to
 * analysis for resolving "tomorrow"/"Friday"/"next week", the date shown on a meeting, and the
 * date given to follow-up and assistant prompts. Keep `created_at` where the record's own
 * creation/ingestion time is what is meant (e.g. "Created ..." labels, newest-first ordering).
 *
 * A missing `meeting_date` key (a row read before the column exists, or a query that did not
 * select it) behaves exactly like null.
 */
export function getEffectiveMeetingDate(meeting: {
  meeting_date?: string | null;
  created_at: string;
}): string {
  return meeting.meeting_date ?? meeting.created_at;
}
