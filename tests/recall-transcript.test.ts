import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRecallTranscriptWithDiagnostics,
  parseRecallTranscriptToSegments
} from "../lib/recall/transcript";

test("fetches a transcript through the current transcript artifact endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RECALL_API_KEY;
  const originalRegion = process.env.RECALL_REGION;
  process.env.RECALL_API_KEY = "test-key-not-logged";
  process.env.RECALL_REGION = "us-west-2";

  const requestedUrls: string[] = [];
  const transcript = [
    {
      participant: { id: 7, name: "Aditya" },
      words: [{ text: "Test", start_timestamp: 1 }]
    }
  ];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/api/v1/bot/bot-1/")) {
      return Response.json({
        id: "bot-1",
        recordings: [
          {
            id: "recording-1",
            media_shortcuts: {
              transcript: {
                id: "transcript-1",
                status: { code: "done" },
                metadata: {
                  provider: { recallai_streaming: {} },
                  diarization: { use_separate_streams_when_available: true }
                }
              }
            }
          }
        ]
      });
    }
    if (url.endsWith("/api/v1/transcript/transcript-1/")) {
      return Response.json({
        id: "transcript-1",
        status: { code: "done" },
        data: { download_url: "https://download.example/transcript.json" }
      });
    }
    if (url === "https://download.example/transcript.json") {
      return Response.json(transcript);
    }
    return new Response("unexpected URL", { status: 500 });
  };

  try {
    const result = await fetchRecallTranscriptWithDiagnostics("bot-1");
    assert.deepEqual(result.transcript, transcript);
    assert.deepEqual(requestedUrls, [
      "https://us-west-2.recall.ai/api/v1/bot/bot-1/",
      "https://us-west-2.recall.ai/api/v1/transcript/transcript-1/",
      "https://download.example/transcript.json"
    ]);
    assert.equal(
      requestedUrls.some((url) => url.includes("/bot/bot-1/transcript/")),
      false
    );
    assert.equal(result.diagnostics.recordingId, "recording-1");
    assert.equal(result.diagnostics.transcriptArtifactId, "transcript-1");
    assert.equal(result.diagnostics.transcriptStatus, "done");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.RECALL_API_KEY = originalApiKey;
    process.env.RECALL_REGION = originalRegion;
  }
});

test("preserves Recall participant attribution and raw payload while parsing transcript entries", () => {
  const [segment] = parseRecallTranscriptToSegments([
    {
      participant: { id: 7, name: "Aditya" },
      words: [{ text: "Hello", start_timestamp: 1 }]
    }
  ]);

  assert.equal(segment.participant_name, "Aditya");
  assert.equal(segment.speaker, "Aditya");
  assert.deepEqual(segment.raw_payload, {
    participant: { id: 7, name: "Aditya" },
    words: [{ text: "Hello", start_timestamp: 1 }]
  });
});

test("parses the real Recall { absolute, relative } word timestamp shape instead of falling back to now()", () => {
  const [segment] = parseRecallTranscriptToSegments([
    {
      participant: { id: 1, name: "Craig" },
      words: [
        {
          text: "hello",
          start_timestamp: { absolute: "2026-08-05T18:53:32.573Z", relative: 2968.6714 },
          end_timestamp: { absolute: "2026-08-05T18:53:32.813Z", relative: 2968.9114 }
        }
      ]
    }
  ]);
  assert.equal(segment.timestamp, "2026-08-05T18:53:32.573Z");
});

test("falls back to now() only when no word/utterance timestamp of any recognized shape is present", () => {
  const before = Date.now();
  const [segment] = parseRecallTranscriptToSegments([
    { participant: { id: 1, name: "Craig" }, words: [{ text: "hello" }] }
  ]);
  const parsed = Date.parse(segment.timestamp);
  assert.ok(parsed >= before && parsed <= Date.now());
});
