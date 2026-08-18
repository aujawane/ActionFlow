import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { buildTranscriptWithSegmentIds } from "../lib/analysis";
import {
  getTranscriptSpeakerLabel,
  normalizeTranscriptSpeaker
} from "../lib/transcript-speaker";

test("Recall participant name is the canonical transcript speaker label", () => {
  assert.equal(
    getTranscriptSpeakerLabel({ participant_name: "  Cameron  ", speaker: "Speaker 1" }),
    "Cameron"
  );
});

test("Recall speaker is used when participant name is unavailable", () => {
  assert.equal(
    getTranscriptSpeakerLabel({ participant_name: null, speaker: " Craig Lauer " }),
    "Craig Lauer"
  );
});

test("missing Recall attribution falls back safely", () => {
  assert.equal(
    getTranscriptSpeakerLabel({ participant_name: " ", speaker: null }),
    "Unknown Speaker"
  );
});

test("same-device attribution remains one Recall participant at launch", () => {
  const normalized = [
    { participant_name: "Conference Room", speaker: "Speaker 0" },
    { participant_name: "Conference Room", speaker: "Speaker 1" }
  ].map(normalizeTranscriptSpeaker);
  assert.deepEqual(normalized.map((segment) => segment.speaker), [
    "Conference Room",
    "Conference Room"
  ]);
});

test("Execution Intelligence transcript formatting uses the canonical Recall participant label", () => {
  const transcript = buildTranscriptWithSegmentIds([{
    id: "00000000-0000-4000-8000-000000000001",
    participant_name: "Cameron",
    speaker: "Legacy Alias",
    text: "I will send the draft.",
    timestamp: "2026-08-17T12:00:00.000Z"
  }]);
  assert.match(transcript, /Cameron: I will send the draft/);
  assert.doesNotMatch(transcript, /Legacy Alias/);
});

test("production code has no speaker-resolution UI, API, or alias-table dependency", async () => {
  const productionFiles = [
    "../app/meetings/[id]/page.tsx",
    "../app/api/meetings/[id]/transcript/route.ts",
    "../lib/recall/processing.ts",
    "../lib/meeting-analysis/topics.ts",
    "../lib/meeting-assistant/transcript-selection.ts",
    "../lib/meeting-participants.ts",
    "../lib/project-brain/context.ts"
  ];
  for (const file of productionFiles) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /meeting_speaker_aliases|resolved_speaker|diarized_speaker|speaker_confidence|Speaker Resolution/);
  }
  await assert.rejects(access(new URL("../components/speaker-mapping-panel.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/meetings/[id]/speakers/route.ts", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/meetings/[id]/speaker-aliases/route.ts", import.meta.url)));
});

test("transcript development routes remain production-gated", async () => {
  for (const file of [
    "../app/api/dev/meeting-extraction-debug/route.ts",
    "../app/api/dev/recall-transcript-debug/route.ts",
    "../app/api/dev/reimport-transcript/route.ts"
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /process\.env\.NODE_ENV !== "development"/);
  }
});
