import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

import {
  matchConvertedCommitments,
  matchExecutionGraphRows
} from "./matching";
import type { ExecutionGraph } from "./schemas";
import type { ConversationEvent } from "./conversation-event-schemas";
import { validateConversationEventsForPersistence } from "./conversation-event-identity";

type ConversationEventRpcError = {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
};

type ConversationEventRpc = (input: {
  p_meeting_id: string;
  p_generation: number;
  p_events: ConversationEvent[];
}) => Promise<{ error: ConversationEventRpcError | null }>;

export async function persistConversationEvents(input: {
  meetingId: string;
  generation: number;
  events: ConversationEvent[];
  validSourceSegmentIds: Iterable<string>;
}, dependencies: { rpc?: ConversationEventRpc } = {}): Promise<
  { ok: true } | { ok: false; error: string; details?: string }
> {
  const validation = validateConversationEventsForPersistence(input);
  const diagnostics = {
    generation: validation.diagnostics.generation,
    chunks: validation.diagnostics.chunkEventCounts,
    event_count: validation.diagnostics.eventCount,
    duplicate_client_refs: validation.diagnostics.duplicateClientRefs,
    empty_client_ref_indexes: validation.diagnostics.emptyClientRefIndexes,
    invalid_linked_refs: validation.diagnostics.invalidLinkedRefs,
    invalid_source_segment_ids: validation.diagnostics.invalidSourceSegmentIds
  };
  if (!validation.ok) {
    console.warn(
      "[execution-intelligence] conversation event persistence validation failed",
      diagnostics
    );
    return {
      ok: false,
      error: "Conversation events failed persistence validation.",
      details: validation.error
    };
  }
  console.info(
    "[execution-intelligence] conversation event persistence validated",
    diagnostics
  );

  const rpc: ConversationEventRpc =
    dependencies.rpc ??
    (async (payload) => {
      const { error } = await supabaseAdmin.rpc(
        "replace_meeting_conversation_events",
        payload
      );
      return { error };
    });
  const { error } = await rpc({
    p_meeting_id: input.meetingId,
    p_generation: input.generation,
    p_events: input.events
  });
  if (error) {
    return {
      ok: false,
      error: "Failed to persist conversation events.",
      details: JSON.stringify({
        code: error.code ?? null,
        message: error.message,
        details: error.details ?? null,
        hint: error.hint ?? null
      })
    };
  }
  return { ok: true };
}

export type PersistExecutionGraphResult =
  | {
      ok: true;
      commitments: MeetingCommitment[];
      tasks: MeetingTask[];
    }
  | { ok: false; error: string; details?: string; stale?: boolean };

export async function claimExecutionAnalysis(meetingId: string): Promise<
  | { ok: true; generation: number }
  | { ok: false; error: string; details?: string }
> {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_meeting_execution_analysis",
    { p_meeting_id: meetingId }
  );
  if (error || typeof data !== "number") {
    return {
      ok: false,
      error: "Failed to claim an execution analysis generation.",
      details: error?.message ?? "The generation RPC returned an invalid value."
    };
  }
  return { ok: true, generation: data };
}

export async function persistExecutionGraph(input: {
  meetingId: string;
  generation: number;
  graph: ExecutionGraph;
}): Promise<PersistExecutionGraphResult> {
  const [
    { data: existingCommitments, error: commitmentsLoadError },
    { data: existingTasks, error: tasksLoadError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meeting_commitments")
      .select("*")
      .eq("meeting_id", input.meetingId),
    supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("meeting_id", input.meetingId)
  ]);
  if (commitmentsLoadError || tasksLoadError) {
    return {
      ok: false,
      error: "Failed to load the existing execution graph for a safe merge.",
      details: commitmentsLoadError?.message ?? tasksLoadError?.message
    };
  }

  const matches = matchExecutionGraphRows({
    graph: input.graph,
    commitments: ((existingCommitments ?? []) as MeetingCommitment[]).filter(
      (commitment) => !commitment.converted_to_task_id
    ),
    tasks: (existingTasks ?? []) as MeetingTask[]
  });
  const matchedCommitmentIds = new Set(matches.commitments.values());
  const ownerOnlyGeneratedCommitmentIds = ((existingCommitments ?? []) as MeetingCommitment[])
    .filter((commitment) => {
      if (matchedCommitmentIds.has(commitment.id) || !commitment.preserve_on_reanalysis) {
        return false;
      }
      const fields = Array.isArray(commitment.manual_override_fields)
        ? commitment.manual_override_fields.flatMap((field) =>
            typeof field === "string" ? [field] : []
          )
        : [];
      const ownerOnly =
        fields.length > 0 &&
        fields.every((field) => ["owner", "owners", "lead_owner_name"].includes(field));
      const metadata = commitment.metadata as { client_ref?: unknown } | null;
      return ownerOnly && typeof metadata?.client_ref === "string";
    })
    .map((commitment) => commitment.id);
  if (ownerOnlyGeneratedCommitmentIds.length > 0) {
    const { error: releaseError } = await supabaseAdmin
      .from("meeting_commitments")
      .update({ preserve_on_reanalysis: false })
      .in("id", ownerOnlyGeneratedCommitmentIds);
    if (releaseError) {
      return {
        ok: false,
        error: "Failed to release obsolete generated commitments before replacement.",
        details: releaseError.message
      };
    }
  }
  const convertedCommitments = matchConvertedCommitments({
    graph: input.graph,
    commitments: ((existingCommitments ?? []) as MeetingCommitment[]).filter(
      (commitment) => !matchedCommitmentIds.has(commitment.id)
    )
  });
  const commitmentsPayload = input.graph.commitments.map((commitment, index) => ({
      ...commitment,
      conversation_event_ids: commitment.conversation_event_ids ?? [],
    existing_id: matches.commitments.get(index) ?? null
  }));
  const tasksPayload = input.graph.tasks.map((task, index) => {
    const convertedCommitmentId = convertedCommitments.get(index);
    return {
      ...task,
      conversation_event_ids: task.conversation_event_ids ?? [],
      consolidated_from_refs: convertedCommitmentId
        ? [
            ...(task.consolidated_from_refs ?? []),
            `existing:${convertedCommitmentId}`
          ]
        : task.consolidated_from_refs,
      existing_id: matches.tasks.get(index) ?? null
    };
  });

  const { error: rpcError } = await supabaseAdmin.rpc(
    "replace_meeting_execution_graph",
    {
      p_meeting_id: input.meetingId,
      p_generation: input.generation,
      p_commitments: commitmentsPayload,
      p_tasks: tasksPayload
    }
  );

  if (rpcError) {
    const stale = rpcError.message.toLowerCase().includes("stale_analysis_run");
    return {
      ok: false,
      error: stale
        ? "A newer meeting analysis superseded this result."
        : "Failed to atomically persist the execution graph.",
      details: rpcError.message,
      stale
    };
  }

  const [{ data: commitmentRows }, { data: taskRows }] = await Promise.all([
    supabaseAdmin
      .from("meeting_commitments")
      .select("id, metadata")
      .eq("meeting_id", input.meetingId),
    supabaseAdmin
      .from("meeting_tasks")
      .select("id, extraction_metadata")
      .eq("meeting_id", input.meetingId)
  ]);
  const commitmentsByRef = new Map(
    input.graph.commitments.map((item) => [item.client_ref, item])
  );
  const tasksByRef = new Map(
    input.graph.tasks.map((item) => [item.client_ref, item])
  );
  const traceabilityUpdates = await Promise.all([
    ...(commitmentRows ?? []).map((row) => {
      const metadata = row.metadata as { client_ref?: string } | null;
      const item = metadata?.client_ref ? commitmentsByRef.get(metadata.client_ref) : undefined;
      return item
        ? supabaseAdmin.from("meeting_commitments").update({
            conversation_event_ids: item.conversation_event_ids ?? [],
            metadata: {
              ...(metadata ?? {}),
              commitment_reason: item.commitment_reason ?? null,
              supporting_action_refs: item.supporting_action_refs ?? [],
              acceptance_criteria: item.acceptance_criteria ?? [],
              group_basis: item.group_basis ?? null,
              primary_owner_reason: item.primary_owner_reason ?? null
            }
          }).eq("id", row.id)
        : Promise.resolve({ error: null });
    }),
    ...(taskRows ?? []).map((row) => {
      const metadata = row.extraction_metadata as { client_ref?: string } | null;
      const item = metadata?.client_ref ? tasksByRef.get(metadata.client_ref) : undefined;
      return item
        ? supabaseAdmin.from("meeting_tasks").update({
            conversation_event_ids: item.conversation_event_ids ?? [],
            extraction_metadata: {
              ...(metadata ?? {}),
              action_classification: item.action_classification ?? null,
              action_status: item.action_status ?? null,
              requester: item.requester ?? null,
              recipient: item.recipient ?? null,
              extraction_reason: item.extraction_reason ?? null,
              relationship_confidence: item.relationship_confidence ?? null,
              relationship_reason: item.relationship_reason ?? null,
              relationship_evidence: item.relationship_evidence ?? [],
              work_item_role: item.work_item_role ?? null,
              scope_state: item.scope_state ?? null,
              merge_provenance: item.merge_provenance ?? null
            }
          }).eq("id", row.id)
        : Promise.resolve({ error: null });
    })
  ]);
  const traceabilityError = traceabilityUpdates.find((result) => result.error)?.error;
  if (traceabilityError) {
    return {
      ok: false,
      error: "Execution graph was stored but event traceability could not be attached.",
      details: traceabilityError.message
    };
  }

  const [
    { data: commitments, error: commitmentsError },
    { data: tasks, error: tasksError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meeting_commitments")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("created_at", { ascending: true })
  ]);

  if (commitmentsError || tasksError) {
    return {
      ok: false,
      error: "Execution graph was stored but could not be reloaded.",
      details: commitmentsError?.message ?? tasksError?.message
    };
  }

  return {
    ok: true,
    commitments: (commitments ?? []) as MeetingCommitment[],
    tasks: (tasks ?? []) as MeetingTask[]
  };
}
