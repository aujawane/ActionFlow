import { getExecutionIntelligenceTimeoutMs } from "@/lib/env";
import { getOpenAIModel, openai } from "@/lib/openai";

import { splitExecutionSourceIntoChunks } from "./chunking";
import { EXECUTION_CHUNK_CONCURRENCY } from "./chunking";
import {
  conversationEventsJsonSchema,
  conversationEventSchema,
  conversationEventsSchema,
  type ConversationEvent
} from "./conversation-event-schemas";
import { canonicalizeConversationEventChunk } from "./conversation-event-identity";
import { semanticTokenSimilarity } from "./graph";
import type { ExecutionSourceContext } from "./stages";

export const CONVERSATION_EVENT_EXTRACTION_PROMPT = `
You are Parfait's conversation event extractor. Describe what happened in the
conversation; do not generate commitments, tasks, plans, or plausible follow-up work.

Extract only observable conversational events: promise, request, acceptance,
assignment, decision, progress_update, proposal, future_idea, question, reminder,
scheduling_agreement, blocker, completed_work, and requirement.

Preserve the distinction between discussion and execution:
- Progress reports and completed work are past/present events, never new promises.
- Maybe/could/someday language is a proposal or future_idea with no accepted signal.
- A request is requested, not accepted, until another turn clearly accepts it.
- "Yes", "I'll do that", and equivalent replies are acceptance events. Resolve their
  action and object from the nearby request, while quoting the accepting turn exactly.
- An implementation decision is a decision. It is only an execution signal when the
  same evidence explicitly establishes ownership of future work.
- Questions without agreement have commitment_signal=none.

Actors are the people who perform the conversational act. Use future only for future
work, past for completed work, present for current progress/blockers, and unspecified
when tense is unclear. Copy exact segment IDs and an exact source quote. Link events
within this chunk when they are parts of one exchange. Return only schema-valid JSON.
`.trim();

export type ConversationEventStageResult =
  | { ok: true; events: ConversationEvent[]; latencyMs: number }
  | { ok: false; error: string; details?: string; latencyMs: number };

type CreateResponse = (signal: AbortSignal) => Promise<{ output_text?: string | null }>;

const TRANSCRIPT_SEGMENT_LINE =
  /^\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\s*(.*)$/i;

function normalizeEvidenceText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Keep model events grounded to segment IDs that actually exist in this chunk.
 * If the model emits a malformed or out-of-chunk ID, recover it only when the
 * exact source quote uniquely identifies one transcript segment.
 */
export function salvageConversationEventOutput(
  raw: unknown,
  transcript: string
): { events: ConversationEvent[]; dropped: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = (raw as Record<string, unknown>).events;
  if (!Array.isArray(values)) return null;

  const segments = transcript.split("\n").flatMap((line) => {
    const match = line.match(TRANSCRIPT_SEGMENT_LINE);
    return match
      ? [{ id: match[1], text: normalizeEvidenceText(match[2]) }]
      : [];
  });
  const segmentIdByLowercase = new Map(
    segments.map((segment) => [segment.id.toLowerCase(), segment.id])
  );
  let dropped = 0;
  const events = values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      dropped += 1;
      return [];
    }
    const item = value as Record<string, unknown>;
    const sourceSegmentIds = Array.isArray(item.source_segment_ids)
      ? Array.from(
          new Set(
            item.source_segment_ids.flatMap((id) => {
              if (typeof id !== "string") return [];
              const matched = segmentIdByLowercase.get(id.trim().toLowerCase());
              return matched ? [matched] : [];
            })
          )
        )
      : [];

    if (sourceSegmentIds.length === 0 && typeof item.source_quote === "string") {
      const quote = normalizeEvidenceText(item.source_quote);
      const quoteMatches = quote
        ? segments.filter((segment) => segment.text.includes(quote))
        : [];
      if (quoteMatches.length === 1) sourceSegmentIds.push(quoteMatches[0].id);
    }

    if (sourceSegmentIds.length === 0) {
      dropped += 1;
      return [];
    }
    const parsed = conversationEventSchema.safeParse({
      ...item,
      source_segment_ids: sourceSegmentIds
    });
    if (!parsed.success) {
      dropped += 1;
      return [];
    }
    return [parsed.data];
  });
  return { events, dropped };
}

export async function extractConversationEvents(
  source: ExecutionSourceContext,
  options: { createResponse?: CreateResponse } = {}
): Promise<ConversationEventStageResult> {
  const startedAt = Date.now();
  const timeoutMs = getExecutionIntelligenceTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = {
      model: getOpenAIModel(),
      max_output_tokens: 12_000,
      input: [
        { role: "system" as const, content: CONVERSATION_EVENT_EXTRACTION_PROMPT },
        {
          role: "user" as const,
          content: JSON.stringify({
            meeting_id: source.meetingId,
            meeting_date: source.meetingDate,
            topics: source.topics,
            transcript: source.transcript
          })
        }
      ],
      text: {
        format: {
          type: "json_schema" as const,
          name: "conversation_events",
          strict: true,
          schema: conversationEventsJsonSchema
        }
      }
    };
    const response = options.createResponse
      ? await options.createResponse(controller.signal)
      : await openai.responses.create(request, {
          signal: controller.signal,
          timeout: timeoutMs,
          maxRetries: 0
        });
    const raw = response.output_text?.trim();
    if (!raw) {
      return { ok: false, error: "OpenAI returned empty conversation event output.", latencyMs: Date.now() - startedAt };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "OpenAI returned invalid conversation event JSON.", details: raw.slice(0, 500), latencyMs: Date.now() - startedAt };
    }
    const salvaged = salvageConversationEventOutput(parsed, source.transcript);
    if (!salvaged) {
      const validated = conversationEventsSchema.safeParse(parsed);
      return { ok: false, error: "Conversation event output did not match the schema.", details: validated.success ? "Conversation event envelope was invalid." : validated.error.message, latencyMs: Date.now() - startedAt };
    }
    if (salvaged.dropped > 0) {
      console.warn("[execution-intelligence] Salvaged conversation event output", {
        meeting_id: source.meetingId,
        dropped_events: salvaged.dropped,
        retained_events: salvaged.events.length
      });
    }
    return { ok: true, events: salvaged.events, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: "Conversation event extraction failed.",
      details: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

function eventText(event: ConversationEvent) {
  return [event.action, event.object].filter(Boolean).join(" ");
}

export function linkConversationEvents(
  events: ConversationEvent[],
  transcript: string
): ConversationEvent[] {
  const segmentOrder = new Map<string, number>();
  for (const [index, match] of Array.from(transcript.matchAll(/\[([0-9a-f-]{36})\]/gi)).entries()) {
    segmentOrder.set(match[1], index);
  }
  const ordered = [...events].sort((left, right) => {
    const leftIndex = Math.min(...left.source_segment_ids.map((id) => segmentOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
    const rightIndex = Math.min(...right.source_segment_ids.map((id) => segmentOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
    return leftIndex - rightIndex;
  });
  const byRef = new Map(ordered.map((event) => [event.client_ref, event]));
  const links = new Map(ordered.map((event) => [event.client_ref, new Set(event.linked_event_refs.filter((ref) => byRef.has(ref)))]));

  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index];
    if (event.type !== "acceptance" && event.commitment_signal !== "accepted") continue;
    let best: { event: ConversationEvent; score: number } | null = null;
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const prior = ordered[priorIndex];
      if (!["request", "assignment", "proposal", "question"].includes(prior.type)) continue;
      const distance = index - priorIndex;
      const similarity = semanticTokenSimilarity(eventText(event), eventText(prior));
      const score = similarity * 4 + 1 / distance;
      if (!best || score > best.score) best = { event: prior, score };
      if (similarity >= 0.7) break;
    }
    if (!best) continue;
    links.get(event.client_ref)?.add(best.event.client_ref);
    links.get(best.event.client_ref)?.add(event.client_ref);
  }

  return ordered.map((event) => ({
    ...event,
    linked_event_refs: Array.from(links.get(event.client_ref) ?? [])
  }));
}

function deduplicateEvents(events: ConversationEvent[]) {
  const result: ConversationEvent[] = [];
  const aliases = new Map<string, string>();
  for (const event of events) {
    const duplicate = result.find((existing) =>
      existing.type === event.type &&
      existing.source_segment_ids.some((id) => event.source_segment_ids.includes(id)) &&
      semanticTokenSimilarity(eventText(existing) || existing.source_quote, eventText(event) || event.source_quote) >= 0.55
    );
    if (!duplicate) {
      result.push(event);
      continue;
    }
    aliases.set(event.client_ref, duplicate.client_ref);
    duplicate.source_segment_ids = Array.from(new Set([...duplicate.source_segment_ids, ...event.source_segment_ids]));
    duplicate.linked_event_refs = Array.from(new Set([...duplicate.linked_event_refs, ...event.linked_event_refs]));
    duplicate.confidence = Math.max(duplicate.confidence, event.confidence);
  }
  return result.map((event) => ({
    ...event,
    linked_event_refs: Array.from(new Set(event.linked_event_refs.map((ref) => aliases.get(ref) ?? ref))).filter((ref) => ref !== event.client_ref)
  }));
}

export async function extractAndLinkConversationEvents(
  source: ExecutionSourceContext,
  options: {
    extractChunk?: typeof extractConversationEvents;
    generation?: number;
  } = {}
): Promise<ConversationEventStageResult> {
  const startedAt = Date.now();
  const chunks = splitExecutionSourceIntoChunks(source);
  const extractChunk = options.extractChunk ?? extractConversationEvents;
  const results: Array<ConversationEventStageResult | undefined> = new Array(chunks.length);
  let nextIndex = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= chunks.length) return;
      const result = await extractChunk(chunks[index].source);
      results[index] = result;
      if (!result.ok) failed = true;
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(EXECUTION_CHUNK_CONCURRENCY, chunks.length) },
      () => worker()
    )
  );
  const failureIndex = results.findIndex((result) => Boolean(result && !result.ok));
  if (failureIndex >= 0) {
    const failure = results[failureIndex];
    if (!failure || failure.ok) throw new Error("Conversation event failure state was inconsistent.");
    return { ...failure, error: `Conversation event chunk ${failureIndex + 1} failed: ${failure.error}`, latencyMs: Date.now() - startedAt };
  }
  if (results.some((result) => !result)) {
    return {
      ok: false,
      error: "Conversation event extraction stopped before all chunks completed.",
      latencyMs: Date.now() - startedAt
    };
  }
  const successful = results.filter(
    (result): result is Extract<ConversationEventStageResult, { ok: true }> =>
      Boolean(result?.ok)
  );
  const generation = options.generation ?? 0;
  const events = successful.flatMap((result, index) =>
    canonicalizeConversationEventChunk({
      events: result.events,
      generation,
      chunkIndex: index
    })
  );
  return {
    ok: true,
    events: linkConversationEvents(deduplicateEvents(events), source.transcript),
    latencyMs: Date.now() - startedAt
  };
}
