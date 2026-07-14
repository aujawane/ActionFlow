import assert from "node:assert/strict";
import test from "node:test";

import {
  applySpeakerAliases,
  applySpeakerAliasesToTasks,
  buildMeetingSpeakerRoster
} from "../lib/speaker-aliases";
import type {
  MeetingSpeakerAlias,
  MeetingTask,
  TranscriptSegment
} from "../lib/types";

function segment(
  id: string,
  participantName: string | null,
  diarizedSpeaker: string | null,
  speaker = participantName,
  text = "Test transcript text"
): TranscriptSegment {
  return {
    id,
    meeting_id: "meeting-1",
    speaker,
    participant_name: participantName,
    diarized_speaker: diarizedSpeaker,
    resolved_speaker: null,
    speaker_confidence: null,
    text,
    timestamp: "2026-07-14T00:00:00.000Z",
    raw_payload: {},
    created_at: "2026-07-14T00:00:00.000Z"
  };
}

function alias(rawSpeakerLabel: string, displayName: string): MeetingSpeakerAlias {
  return {
    id: `${rawSpeakerLabel}-${displayName}`,
    meeting_id: "meeting-1",
    raw_speaker_label: rawSpeakerLabel,
    display_name: displayName,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z"
  };
}

function task(owner: string | null): MeetingTask {
  return {
    id: `task-${owner ?? "none"}`,
    meeting_id: "meeting-1",
    topic_id: "topic-1",
    task: "Complete follow-up",
    owner,
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: null,
    status: "pending",
    workspace_type: "other",
    workspace_summary: null,
    created_at: "2026-07-14T00:00:00.000Z"
  };
}

test("keeps a real participant name for one voice on one device", () => {
  const [resolved] = applySpeakerAliases(
    [segment("segment-1", "Aditya", "Speaker 0")],
    []
  );
  assert.equal(resolved.speaker, "Aditya");
});

test("prefers diarized labels when one participant contains multiple voices", () => {
  const resolved = applySpeakerAliases(
    [
      segment("segment-1", "Conference Room", "Speaker 0"),
      segment("segment-2", "Conference Room", "Speaker 1")
    ],
    []
  );
  assert.deepEqual(
    resolved.map((item) => item.speaker),
    ["Speaker 0", "Speaker 1"]
  );
});

test("applies aliases idempotently to shared-device transcript rows", () => {
  const aliases = [alias("Speaker 0", "Aditya")];
  const once = applySpeakerAliases(
    [segment("segment-1", "Conference Room", "Speaker 0")],
    aliases
  );
  const twice = applySpeakerAliases(once, aliases);
  assert.equal(once[0].speaker, "Aditya");
  assert.equal(once[0].resolved_speaker, "Aditya");
  assert.deepEqual(twice, once);
});

test("includes unresolved unknown speakers and roster counts", () => {
  const roster = buildMeetingSpeakerRoster({
    segments: [segment("segment-1", null, null, null)],
    aliases: [],
    tasks: [task("Unknown Speaker")]
  });
  assert.deepEqual(roster, [
    {
      rawSpeakerLabel: "Unknown Speaker",
      displayName: "Unknown Speaker",
      participantName: null,
      diarizedSpeaker: null,
      isResolved: false,
      isAmbiguous: false,
      segmentCount: 1,
      taskCount: 1,
      exampleQuotes: ["Test transcript text"],
      possibleNameHints: []
    }
  ]);
});

test("resolves persisted task owners with the same alias map", () => {
  const resolved = applySpeakerAliasesToTasks(
    [task("Speaker 1")],
    [alias("Speaker 1", "Craig")]
  );
  assert.equal(resolved[0].owner, "Craig");
});

test("returns action-focused quotes and self-identification hints", () => {
  const roster = buildMeetingSpeakerRoster({
    segments: [
      segment(
        "segment-1",
        "Conference Room",
        "Speaker 0",
        "Conference Room",
        "We should review the release plan."
      ),
      segment(
        "segment-2",
        "Conference Room",
        "Speaker 0",
        "Conference Room",
        "I'm Aditya. I will take the webhook idempotency work."
      ),
      segment(
        "segment-3",
        "Conference Room",
        "Speaker 0",
        "Conference Room",
        "I can make sure completed meetings do not get reprocessed."
      )
    ],
    aliases: [],
    tasks: []
  });

  assert.deepEqual(roster[0].possibleNameHints, ["Aditya"]);
  assert.deepEqual(roster[0].exampleQuotes, [
    "I will take the webhook idempotency work.",
    "I can make sure completed meetings do not get reprocessed.",
    "We should review the release plan."
  ]);
});
