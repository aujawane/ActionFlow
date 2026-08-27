import type { Meeting } from "@/lib/types";

/**
 * Pure list-update helpers for components/meeting-library.tsx. Every function is scoped to a
 * single meeting id and operates on whatever array it's given -- never a snapshot captured
 * earlier -- so callers that thread these through a functional setMeetings(current => ...) update
 * can't clobber a concurrent, unrelated mutation to a different meeting.
 */

export function removeMeetingById(meetings: Meeting[], meetingId: string): Meeting[] {
  return meetings.filter((meeting) => meeting.id !== meetingId);
}

/** Re-adds a specific meeting after a failed delete. A no-op if it's already present (e.g. a
 * router.refresh() already brought it back), so a late rollback can never duplicate an entry. */
export function restoreMeetingIfMissing(meetings: Meeting[], meeting: Meeting): Meeting[] {
  if (meetings.some((item) => item.id === meeting.id)) return meetings;
  return [...meetings, meeting];
}

/** Updates only the one meeting's pinned flag -- used for both the optimistic pin toggle and its
 * failure rollback, so a concurrent mutation to a different meeting is never touched. */
export function withMeetingPinned(
  meetings: Meeting[],
  meetingId: string,
  isPinned: boolean
): Meeting[] {
  return meetings.map((item) => (item.id === meetingId ? { ...item, is_pinned: isPinned } : item));
}

/** Replaces one meeting with the server's copy after a successful mutation response. */
export function withMeetingReplaced(meetings: Meeting[], updated: Meeting): Meeting[] {
  return meetings.map((item) => (item.id === updated.id ? updated : item));
}

export type MutationOutcome =
  | { kind: "refresh" }
  | { kind: "restore"; message: string };

/**
 * Decides what a delete/pin request's outcome means for the UI: success should refresh server
 * truth (router.refresh()); failure should roll back just the affected meeting and surface an
 * error. Pulled out of the component so this branch -- the one that determines whether a
 * mutation ever asks for fresh server data -- is unit-testable without a React rendering harness.
 */
export function decideMutationOutcome(
  succeeded: boolean,
  errorMessage: string | undefined,
  fallbackMessage: string
): MutationOutcome {
  if (succeeded) return { kind: "refresh" };
  return { kind: "restore", message: errorMessage || fallbackMessage };
}
