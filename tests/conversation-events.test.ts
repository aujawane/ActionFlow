import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationEvent } from "../lib/execution-intelligence/conversation-event-schemas";
import {
  extractConversationEvents,
  linkConversationEvents
} from "../lib/execution-intelligence/conversation-events";
import { CANDIDATE_GENERATION_PROMPT, COMPLETENESS_PROMPT } from "../lib/execution-intelligence/prompts";
import { ensureAcceptedWorkTasks } from "../lib/execution-intelligence/standalone-events";

const requestId = "11111111-1111-4111-8111-111111111111";
const acceptanceId = "22222222-2222-4222-8222-222222222222";

function event(overrides: Partial<ConversationEvent>): ConversationEvent {
  return {
    client_ref: "event-1",
    type: "request",
    actors: ["Laura"],
    action: "send",
    object: "today's transcript to Laura",
    temporal_state: "future",
    commitment_signal: "requested",
    source_quote: "Can you send me today's transcript?",
    source_segment_ids: [requestId],
    linked_event_refs: [],
    confidence: 0.98,
    ...overrides
  };
}

test("links a request and acceptance across extraction chunks", () => {
  const events = linkConversationEvents([
    event({ client_ref: "chunk_1_request" }),
    event({
      client_ref: "chunk_2_acceptance",
      type: "acceptance",
      actors: ["Aditya"],
      commitment_signal: "accepted",
      source_quote: "Yeah, I'll send it.",
      source_segment_ids: [acceptanceId]
    })
  ], `[${requestId}] Laura: Can you send me today's transcript?\n[${acceptanceId}] Aditya: Yeah, I'll send it.`);

  assert.deepEqual(events[0].linked_event_refs, ["chunk_2_acceptance"]);
  assert.deepEqual(events[1].linked_event_refs, ["chunk_1_request"]);
});

test("accepted requests survive as standalone tasks while progress updates do not", () => {
  const request = event({ client_ref: "request" });
  const acceptance = event({
    client_ref: "acceptance",
    type: "acceptance",
    actors: ["Aditya"],
    commitment_signal: "accepted",
    source_quote: "Yeah, I'll send it.",
    source_segment_ids: [acceptanceId],
    linked_event_refs: ["request"]
  });
  request.linked_event_refs = ["acceptance"];
  const progress = event({
    client_ref: "progress",
    type: "progress_update",
    actors: ["Aditya"],
    action: "work on",
    object: "Drops",
    temporal_state: "present",
    commitment_signal: "none",
    source_quote: "I've been working on Drops."
  });
  const result = ensureAcceptedWorkTasks({
    graph: { commitments: [], tasks: [] },
    events: [request, acceptance, progress]
  });

  assert.equal(result.added, 1);
  assert.equal(result.graph.tasks[0].commitment_ref, null);
  assert.equal(result.graph.tasks[0].owner, "Aditya");
  assert.match(result.graph.tasks[0].title, /send.*transcript/i);
  assert.deepEqual(result.graph.tasks[0].conversation_event_ids?.sort(), ["acceptance", "request"]);
  assert.doesNotMatch(result.graph.tasks[0].title, /drops/i);
});

test("conversation event extraction repairs invalid IDs from unique source quotes and drops ungrounded events", async () => {
  const result = await extractConversationEvents(
    {
      meetingId: "meeting-1",
      meetingDate: "2026-08-05",
      transcript: `[${requestId}] Laura: Can you send me today's transcript?`,
      transcriptSegmentCount: 1,
      topics: [],
      insights: []
    },
    {
      createResponse: async () => ({
        output_text: JSON.stringify({
          events: [
            event({
              client_ref: "repairable",
              source_segment_ids: ["segment-1"]
            }),
            event({
              client_ref: "ungrounded",
              source_quote: "A quote that is not in the transcript.",
              source_segment_ids: ["not-a-uuid"]
            })
          ]
        })
      })
    }
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].client_ref, "repairable");
  assert.deepEqual(result.events[0].source_segment_ids, [requestId]);
});

test("execution prompts make conversation events primary and insights supporting-only", () => {
  assert.doesNotMatch(CANDIDATE_GENERATION_PROMPT, /generate plausible commitments/i);
  assert.match(CANDIDATE_GENERATION_PROMPT, /Conversation Events are the primary execution evidence/i);
  assert.match(COMPLETENESS_PROMPT, /never sufficient evidence/i);
  assert.match(COMPLETENESS_PROMPT, /must not resurrect work/i);
});
