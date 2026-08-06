import type { ConversationEvent } from "./conversation-event-schemas";
import { semanticTokenSimilarity } from "./graph";
import type { ExecutionGraph, TaskCandidate } from "./schemas";

function eventText(event: ConversationEvent) {
  return [event.action, event.object].filter(Boolean).join(" ").trim();
}

function titleForEvent(event: ConversationEvent, linked?: ConversationEvent) {
  const text = eventText(event) || (linked ? eventText(linked) : "");
  if (text) return text.charAt(0).toUpperCase() + text.slice(1);
  return event.source_quote.replace(/^(?:yes|yeah|sure|okay|ok)[,\s-]*/i, "").trim();
}

function acceptedWork(events: ConversationEvent[]) {
  const byRef = new Map(events.map((event) => [event.client_ref, event]));
  return events.flatMap((event) => {
    const explicitPromise = event.type === "promise" && event.commitment_signal === "explicit";
    const accepted = event.type === "acceptance" || event.commitment_signal === "accepted";
    const acceptedAssignment = event.type === "assignment" && ["accepted", "explicit"].includes(event.commitment_signal);
    const scheduled = event.type === "scheduling_agreement" && ["accepted", "explicit"].includes(event.commitment_signal);
    if (!explicitPromise && !accepted && !acceptedAssignment && !scheduled) return [];
    const linked = event.linked_event_refs.map((ref) => byRef.get(ref)).find((candidate) =>
      candidate && ["request", "assignment", "proposal", "question"].includes(candidate.type)
    );
    if (accepted && !linked && !event.action && !event.object) return [];
    return [{ event, linked }];
  });
}

export function ensureAcceptedWorkTasks(input: {
  graph: ExecutionGraph;
  events: ConversationEvent[];
}): { graph: ExecutionGraph; added: number } {
  const tasks = [...input.graph.tasks];
  let added = 0;
  for (const { event, linked } of acceptedWork(input.events)) {
    const title = titleForEvent(event, linked);
    if (!title) continue;
    const eventIds = new Set([event.client_ref, linked?.client_ref].filter((value): value is string => Boolean(value)));
    const represented = [...input.graph.commitments, ...tasks].some((item) =>
      item.conversation_event_ids?.some((id) => eventIds.has(id)) ||
      semanticTokenSimilarity(item.title, title) >= 0.72
    );
    if (represented) continue;

    const relatedCommitment = input.graph.commitments
      .map((commitment) => ({ commitment, score: semanticTokenSimilarity(commitment.title, title) }))
      .filter(({ score }) => score >= 0.4)
      .sort((left, right) => right.score - left.score)[0]?.commitment;
    const evidence = linked ?? event;
    const sourceSegmentIds = Array.from(new Set([
      ...event.source_segment_ids,
      ...(linked?.source_segment_ids ?? [])
    ]));
    const owner = event.actors[0] ?? null;
    const task: TaskCandidate = {
      client_ref: `accepted_event_${event.client_ref}`,
      commitment_ref: relatedCommitment?.client_ref ?? null,
      topic_id: relatedCommitment?.topic_id ?? null,
      title,
      description: null,
      owner,
      owners: event.actors,
      due_date: null,
      due_date_text: null,
      priority: "medium",
      confidence: Math.min(event.confidence, linked?.confidence ?? 1),
      source_quote: evidence.source_quote,
      source_segment_ids: sourceSegmentIds,
      evidence_source: "conversation_event",
      conversation_event_ids: Array.from(eventIds),
      inferred: false,
      task_type: "commitment",
      workspace_type: event.type === "scheduling_agreement" ? "scheduling" : "other",
      suggested_steps: [],
      execution_classification: "committed",
      consolidated_from_refs: []
    };
    tasks.push(task);
    added += 1;
  }
  return { graph: { ...input.graph, tasks }, added };
}
