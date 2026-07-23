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
      diarized_speaker: "Speaker 0",
      speaker_confidence: 0.9,
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

test("preserves Recall speaker fields while parsing artifact transcript entries", () => {
  const [segment] = parseRecallTranscriptToSegments([
    {
      participant: { id: 7, name: "Aditya" },
      diarized_speaker: "Speaker 1",
      speaker_confidence: 0.85,
      words: [{ text: "Hello", start_timestamp: 1 }]
    }
  ]);

  assert.equal(segment.participant_name, "Aditya");
  assert.equal(segment.diarized_speaker, "Speaker 1");
  assert.equal(segment.speaker, "Aditya");
  assert.equal(segment.speaker_confidence, 0.85);
  assert.deepEqual(segment.raw_payload, {
    participant: { id: 7, name: "Aditya" },
    diarized_speaker: "Speaker 1",
    speaker_confidence: 0.85,
    words: [{ text: "Hello", start_timestamp: 1 }]
  });
});
