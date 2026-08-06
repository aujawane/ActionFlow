import {
  finalizeIndependentExecution,
  runActionExtraction,
  runCommitmentExtraction,
  runEvidenceVerification,
  runRelationshipEvaluation
} from "./durable-pipeline";
import {
  persistConversationEvents,
  persistExecutionGraph
} from "./persistence";
import { transcriptSourceSegmentIds } from "./conversation-event-identity";
import type { ExecutionSourceContext } from "./stages";

export async function runIndependentExecutionIntelligence(input: {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  generation: number;
  persistGraph?: typeof persistExecutionGraph;
  persistEvents?: typeof persistConversationEvents;
}) {
  let state = await runActionExtraction({
    source: input.source,
    fallbackUsed: input.fallbackUsed
  });
  state = await runCommitmentExtraction(state);
  state = await runRelationshipEvaluation(state);
  state = await runEvidenceVerification(state);
  state = await finalizeIndependentExecution(state);

  const persistGraph = input.persistGraph ?? persistExecutionGraph;
  const persisted = await persistGraph({
    meetingId: input.source.meetingId,
    generation: input.generation,
    graph: state.graph
  });
  if (!persisted.ok) {
    return {
      ok: false as const,
      error: persisted.error,
      details: persisted.details,
      status: persisted.stale ? 409 : 500,
      metrics: state.metrics
    };
  }

  const persistEvents = input.persistEvents ?? persistConversationEvents;
  const persistedEvents = await persistEvents({
    meetingId: input.source.meetingId,
    generation: input.generation,
    events: input.source.conversationEvents ?? [],
    validSourceSegmentIds: transcriptSourceSegmentIds(input.source.transcript)
  });
  if (!persistedEvents.ok) {
    console.warn("[execution-intelligence] Optional Conversation Event persistence failed", {
      meeting_id: input.source.meetingId,
      error: persistedEvents.error,
      details: persistedEvents.details
    });
  }

  return {
    ok: true as const,
    graph: state.graph,
    debugTrace: state.debugTrace,
    commitments: persisted.commitments,
    tasks: persisted.tasks,
    metrics: state.metrics
  };
}
