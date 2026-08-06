import type { ConversationEvent } from "./conversation-event-schemas";

export type ConversationEventValidationDiagnostics = {
  generation: number;
  eventCount: number;
  chunkEventCounts: Record<string, number>;
  duplicateClientRefs: string[];
  emptyClientRefIndexes: number[];
  invalidLinkedRefs: Array<{ clientRef: string; linkedRef: string }>;
  invalidSourceSegmentIds: Array<{ clientRef: string; segmentId: string }>;
};

function duplicates(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

/** Models generate event semantics; this function owns persistent event identity. */
export function canonicalizeConversationEventChunk(input: {
  events: ConversationEvent[];
  generation: number;
  chunkIndex: number;
}): ConversationEvent[] {
  const chunkNumber = input.chunkIndex + 1;
  const width = Math.max(3, String(input.events.length).length);
  const canonicalRefs = input.events.map(
    (_, index) =>
      `g${input.generation}_c${chunkNumber}_e${String(index + 1).padStart(width, "0")}`
  );
  const canonicalByTemporaryRef = new Map<string, string[]>();
  input.events.forEach((event, index) => {
    const refs = canonicalByTemporaryRef.get(event.client_ref) ?? [];
    refs.push(canonicalRefs[index]);
    canonicalByTemporaryRef.set(event.client_ref, refs);
  });

  const duplicateTemporaryRefs = Array.from(canonicalByTemporaryRef)
    .filter(([, refs]) => refs.length > 1)
    .map(([ref]) => ref)
    .sort();
  const invalidTemporaryLinkedRefs = Array.from(
    new Set(
      input.events.flatMap((event) =>
        event.linked_event_refs.filter(
          (ref) => !canonicalByTemporaryRef.has(ref)
        )
      )
    )
  ).sort();
  console.info("[execution-intelligence] conversation event IDs canonicalized", {
    generation: input.generation,
    chunk: chunkNumber,
    event_count: input.events.length,
    duplicate_temporary_client_refs: duplicateTemporaryRefs,
    invalid_temporary_linked_refs: invalidTemporaryLinkedRefs
  });

  return input.events.map((event, index) => {
    const clientRef = canonicalRefs[index];
    const linkedEventRefs = Array.from(
      new Set(
        event.linked_event_refs.flatMap(
          (ref) => canonicalByTemporaryRef.get(ref) ?? []
        )
      )
    ).filter((ref) => ref !== clientRef);
    return {
      ...event,
      client_ref: clientRef,
      linked_event_refs: linkedEventRefs
    };
  });
}

export function transcriptSourceSegmentIds(transcript: string) {
  return Array.from(
    transcript.matchAll(
      /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi
    ),
    (match) => match[1]
  );
}

export function validateConversationEventsForPersistence(input: {
  events: ConversationEvent[];
  generation: number;
  validSourceSegmentIds: Iterable<string>;
}):
  | { ok: true; diagnostics: ConversationEventValidationDiagnostics }
  | {
      ok: false;
      error: string;
      diagnostics: ConversationEventValidationDiagnostics;
    } {
  const refs = input.events.map((event) => event.client_ref);
  const refSet = new Set(refs);
  const validSegments = new Set(input.validSourceSegmentIds);
  const emptyClientRefIndexes = input.events.flatMap((event, index) =>
    event.client_ref.trim() ? [] : [index]
  );
  const invalidLinkedRefs = input.events.flatMap((event) =>
    event.linked_event_refs.flatMap((linkedRef) =>
      refSet.has(linkedRef)
        ? []
        : [{ clientRef: event.client_ref, linkedRef }]
    )
  );
  const invalidSourceSegmentIds = input.events.flatMap((event) =>
    event.source_segment_ids.flatMap((segmentId) =>
      validSegments.has(segmentId)
        ? []
        : [{ clientRef: event.client_ref, segmentId }]
    )
  );
  const chunkEventCounts: Record<string, number> = {};
  for (const ref of refs) {
    const match = ref.match(/^g\d+_c(\d+)_e\d+$/);
    const chunk = match?.[1] ?? "unknown";
    chunkEventCounts[chunk] = (chunkEventCounts[chunk] ?? 0) + 1;
  }
  const diagnostics: ConversationEventValidationDiagnostics = {
    generation: input.generation,
    eventCount: input.events.length,
    chunkEventCounts,
    duplicateClientRefs: duplicates(refs),
    emptyClientRefIndexes,
    invalidLinkedRefs,
    invalidSourceSegmentIds
  };

  if (
    diagnostics.duplicateClientRefs.length > 0 ||
    diagnostics.emptyClientRefIndexes.length > 0 ||
    diagnostics.invalidLinkedRefs.length > 0 ||
    diagnostics.invalidSourceSegmentIds.length > 0
  ) {
    return {
      ok: false,
      error: `Conversation event persistence validation failed: ${JSON.stringify(
        diagnostics
      )}`,
      diagnostics
    };
  }
  return { ok: true, diagnostics };
}
