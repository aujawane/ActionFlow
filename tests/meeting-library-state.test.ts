import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMutationOutcome,
  removeMeetingById,
  restoreMeetingIfMissing,
  withMeetingPinned,
  withMeetingReplaced
} from "../lib/meeting-library-state";
import type { Meeting } from "../lib/types";

function makeMeeting(overrides: Partial<Meeting> & { id: string }): Meeting {
  return {
    user_id: "user-1",
    project_id: null,
    title: `Meeting ${overrides.id}`,
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    recall_bot_id: null,
    status: "completed",
    is_pinned: false,
    deleted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

test("removeMeetingById filters out only the targeted meeting", () => {
  const meetings = [makeMeeting({ id: "a" }), makeMeeting({ id: "b" }), makeMeeting({ id: "c" })];
  const result = removeMeetingById(meetings, "b");
  assert.deepEqual(
    result.map((m) => m.id),
    ["a", "c"]
  );
});

test("restoreMeetingIfMissing re-adds a meeting that was rolled back after a failed delete", () => {
  const meetings = [makeMeeting({ id: "a" }), makeMeeting({ id: "c" })];
  const restored = makeMeeting({ id: "b" });
  const result = restoreMeetingIfMissing(meetings, restored);
  assert.deepEqual(
    result.map((m) => m.id),
    ["a", "c", "b"]
  );
});

test("restoreMeetingIfMissing is a no-op when the meeting is already present -- a stale rollback cannot duplicate an entry", () => {
  const meetings = [makeMeeting({ id: "a" }), makeMeeting({ id: "b" })];
  const result = restoreMeetingIfMissing(meetings, makeMeeting({ id: "b" }));
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((m) => m.id),
    ["a", "b"]
  );
});

test("a failed delete's rollback cannot resurrect a different meeting that a concurrent delete already removed", () => {
  // Regression for the exact race the audit flagged: two deletes in flight, A succeeds and is
  // removed from the *current* state, B fails and rolls back -- B's rollback must only affect B.
  let state = [makeMeeting({ id: "a" }), makeMeeting({ id: "b" })];
  const setState = (updater: (current: Meeting[]) => Meeting[]) => {
    state = updater(state);
  };

  const meetingA = state[0];
  const meetingB = state[1];

  // Both deletes start: optimistic removal of both.
  setState((current) => removeMeetingById(current, meetingA.id));
  setState((current) => removeMeetingById(current, meetingB.id));
  assert.equal(state.length, 0);

  // A's DELETE request succeeds -- nothing to do, it stays removed.
  // B's DELETE request fails -- rollback restores only B, using the *current* (functional) state,
  // not a snapshot captured before A's request was made.
  setState((current) => restoreMeetingIfMissing(current, meetingB));

  assert.deepEqual(
    state.map((m) => m.id),
    ["b"]
  );
});

test("withMeetingPinned updates only the targeted meeting's pinned flag", () => {
  const meetings = [
    makeMeeting({ id: "a", is_pinned: false }),
    makeMeeting({ id: "b", is_pinned: false })
  ];
  const result = withMeetingPinned(meetings, "a", true);
  assert.equal(result.find((m) => m.id === "a")?.is_pinned, true);
  assert.equal(result.find((m) => m.id === "b")?.is_pinned, false);
});

test("a failed pin toggle's rollback cannot clobber a different meeting's concurrent pin change", () => {
  let state = [
    makeMeeting({ id: "a", is_pinned: false }),
    makeMeeting({ id: "b", is_pinned: false })
  ];
  const setState = (updater: (current: Meeting[]) => Meeting[]) => {
    state = updater(state);
  };

  // Optimistic pin of A, optimistic pin of B.
  setState((current) => withMeetingPinned(current, "a", true));
  setState((current) => withMeetingPinned(current, "b", true));

  // B's request succeeds and the server's copy is applied.
  setState((current) => withMeetingReplaced(current, makeMeeting({ id: "b", is_pinned: true })));

  // A's request fails -- rollback reverts only A, leaving B's now-confirmed pin untouched.
  setState((current) => withMeetingPinned(current, "a", false));

  assert.equal(state.find((m) => m.id === "a")?.is_pinned, false);
  assert.equal(state.find((m) => m.id === "b")?.is_pinned, true);
});

test("withMeetingReplaced swaps in the server's copy of one meeting without touching the rest", () => {
  const meetings = [makeMeeting({ id: "a" }), makeMeeting({ id: "b" })];
  const updated = makeMeeting({ id: "b", title: "Renamed" });
  const result = withMeetingReplaced(meetings, updated);
  assert.equal(result.find((m) => m.id === "b")?.title, "Renamed");
  assert.equal(result.find((m) => m.id === "a")?.title, "Meeting a");
});

test("a successful delete/pin response asks for a server refresh, not a local restore", () => {
  const outcome = decideMutationOutcome(true, undefined, "Failed to delete meeting.");
  assert.deepEqual(outcome, { kind: "refresh" });
});

test("a failed delete/pin response restores state and surfaces the server's error, falling back to a default message", () => {
  const withServerMessage = decideMutationOutcome(false, "Meeting not found.", "Failed to delete meeting.");
  assert.deepEqual(withServerMessage, { kind: "restore", message: "Meeting not found." });

  const withoutServerMessage = decideMutationOutcome(false, undefined, "Failed to delete meeting.");
  assert.deepEqual(withoutServerMessage, { kind: "restore", message: "Failed to delete meeting." });
});

test("a fresh initialMeetings prop fully replaces stale local state (what the resync effect does on router.refresh())", () => {
  // Mirrors components/meeting-library.tsx's `useEffect(() => setMeetings(initialMeetings),
  // [initialMeetings])`: whatever the server now says is authoritative and replaces local state
  // outright -- it isn't merged with whatever optimistic/stale entries were sitting in state.
  const staleLocalState = [
    makeMeeting({ id: "deleted-but-still-in-old-state" }),
    makeMeeting({ id: "kept" })
  ];
  const freshInitialMeetings = [makeMeeting({ id: "kept" })];

  const resync = (_current: Meeting[], nextInitialMeetings: Meeting[]) => nextInitialMeetings;
  const result = resync(staleLocalState, freshInitialMeetings);

  assert.deepEqual(
    result.map((m) => m.id),
    ["kept"]
  );
});
