import type { CommitmentCandidate, TaskCandidate } from "../schemas";
import type { ExecutionSourceContext } from "../stages";
import {
  finalizeV4Execution,
  runV4FinalReconciliation,
  runV4GlobalCorrection,
  runV4Grouping,
  runV4GroupingVerification,
  runV4TaskConsolidation,
  runV4TreeAssembly,
  runV4WorkItemExtraction,
  type V4ExecutionState
} from "../v4-pipeline";
import { buildCanonicalTranscriptWithSegmentIds, type TranscriptTextSegment } from "../../transcript-order";
import type { FinalCommitmentRow, FinalTaskRow, MeetingSnapshot, TranscriptSegmentRow } from "./snapshot";

/**
 * EVAL-ONLY adapter: runs the exact, unmodified production V4 pipeline stage functions
 * (v4-pipeline.ts -- the same functions scripts/eval-v4.ts and the real durable job worker,
 * lib/meeting-analysis/worker.ts, both call) against an in-memory transcript, and repackages the
 * result as a `MeetingSnapshot` the existing ground-truth evaluator (stage-tracer.ts) already
 * knows how to score. Never persists anything -- no Supabase job row, no meeting_commitments/
 * meeting_tasks writes. This file calls V4; it does not implement or alter any V4 logic.
 *
 * WHY THIS IS SAFE/FAITHFUL: every `MeetingSnapshot` field the evaluator actually reads for
 * scoring (see stage-tracer.ts) is either copied verbatim off `V4ExecutionState` (topicWorkItems,
 * mergedWorkItems, the three completeness traces, globalAdditions/globalCorrections, workItems,
 * eligibleWorkItems, metrics -- all top-level, identically-named fields on `V4ExecutionState`,
 * confirmed by inspecting lib/execution-intelligence/v4-pipeline.ts and
 * lib/meeting-analysis/worker.ts, which persists that same object verbatim as a real job's
 * `checkpoint.v4State`) or derived from `state.graph` (the `ExecutionGraph` that
 * `persistExecutionGraph`/the `replace_meeting_execution_graph` Postgres RPC would otherwise write
 * to `meeting_commitments`/`meeting_tasks`).
 *
 * ONE DOCUMENTED APPROXIMATION: `finalCommitments`/`finalTasks` below are built directly from
 * `state.graph.commitments`/`state.graph.tasks` rather than round-tripped through a real Supabase
 * insert. This is deliberate, not a shortcut taken for convenience -- `treeToExecutionGraph`'s
 * output already *is* the exact same `CommitmentCandidate[]`/`TaskCandidate[]` data the real RPC
 * receives as its only input; the RPC's job is just to assign a DB id and compute `status` from
 * `completion_state` via a trivial `case` statement (mirrored exactly below, see
 * `mapCommitmentStatus`) -- it does not change WHICH work items end up final. The evaluator itself
 * never reads `FinalCommitmentRow.status`/`FinalTaskRow.status` for any scoring decision (grep
 * stage-tracer.ts: `findDownstreamPresence` only ever matches on `metadata.client_ref`,
 * `supporting_action_refs`, `consolidated_from_refs`, and `merge_provenance.merged_from_task_refs`
 * -- all copied here verbatim from the candidate), so this approximation cannot silently bias a
 * score either. `meeting_tasks.status` is not derived from `action_status`/`completion_state` by
 * the real RPC at all (it takes the column default) -- mirrored here as the literal `"pending"`
 * placeholder for the same reason: it is never read by the evaluator.
 *
 * SYNTHETIC-ID ROUND-TRIP (required, discovered empirically): the frozen synthetic fixtures
 * (tests/fixtures/v4-eval/synthetic/*) deliberately use plain deterministic segment ids
 * ("SYN-M1-0001", etc.) per that benchmark's own explicit design instruction, NOT UUIDs. V4's own
 * extraction schema (`rawWorkItemSchema.source_segment_ids`, work-item-schemas.ts) requires
 * `z.string().uuid()` with no repair step for this particular field (unlike the later
 * execution-graph salvage path, which does null out/repair bad ids) -- every single extracted item
 * citing a non-UUID segment id fails schema validation outright and is silently dropped by
 * `salvageArray` (work-item-model.ts), which is indistinguishable from "zero commitments found"
 * without inspecting `metrics.salvagedItems`. This is a genuine fixture/harness id-format
 * incompatibility, not a V4 extraction-quality finding -- confirmed by inspecting the raw model
 * response usage (`salvagedItems` > 0 with real `output_tokens`) before this round-trip was added.
 * Fixing it here (translate to a UUID-shaped id before calling V4, translate back before handing
 * results to the evaluator) touches neither the frozen fixtures nor any V4 validation logic.
 */

const SYNTHETIC_UUID_PREFIX = "00000000-0000-4000-8000-";

function toSyntheticUuid(index: number): string {
  return `${SYNTHETIC_UUID_PREFIX}${String(index).padStart(12, "0")}`;
}

/** Deep-walks any JSON-shaped value and replaces every string that exactly matches a known
 * synthetic-UUID key in `originalByUuid` with its original id. Used instead of enumerating every
 * individual `source_segment_ids`-bearing field across `WorkItem`/`CommitmentCandidate`/
 * `TaskCandidate`/the Pass-A/B trace entry types, so the round-trip can never miss a spot as those
 * types evolve. Safe by construction: the synthetic prefix never occurs in real model output. */
function deepRemapIds<T>(value: T, originalByUuid: ReadonlyMap<string, string>): T {
  if (typeof value === "string") {
    return (originalByUuid.get(value) ?? value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => deepRemapIds(entry, originalByUuid)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepRemapIds(entry, originalByUuid);
    }
    return out as T;
  }
  return value;
}

const COMMITMENT_COMPLETION_STATE_TO_STATUS: Record<string, string> = {
  completed: "completed",
  blocked: "blocked",
  in_progress: "in_progress",
  cancelled: "dismissed"
};

function mapCommitmentStatus(completionState: string): string {
  return COMMITMENT_COMPLETION_STATE_TO_STATUS[completionState] ?? "pending";
}

function toFinalCommitmentRow(candidate: CommitmentCandidate, generation: number): FinalCommitmentRow {
  return {
    id: candidate.client_ref,
    title: candidate.title,
    owner: candidate.owner,
    owners: candidate.owners,
    status: mapCommitmentStatus(candidate.completion_state),
    metadata: {
      client_ref: candidate.client_ref,
      supporting_action_refs: candidate.supporting_action_refs ?? [],
      consolidated_from_refs: candidate.consolidated_from_refs ?? [],
      analysis_generation: generation
    }
  };
}

function toFinalTaskRow(candidate: TaskCandidate, generation: number): FinalTaskRow {
  return {
    id: candidate.client_ref,
    task: candidate.title,
    owner: candidate.owner,
    owners: candidate.owners,
    status: "pending",
    extraction_metadata: {
      client_ref: candidate.client_ref,
      merge_provenance: candidate.merge_provenance
        ? { merged_from_task_refs: candidate.merge_provenance.merged_from_task_refs }
        : null,
      analysis_generation: generation
    } as FinalTaskRow["extraction_metadata"]
  };
}

export type LocalV4RunInput = {
  meetingId: string;
  meetingDate: string;
  transcriptSegments: TranscriptSegmentRow[];
  fallbackUsed?: boolean;
};

export type LocalV4RunResult = {
  snapshot: MeetingSnapshot;
  state: V4ExecutionState;
};

/** Runs the complete, unmodified V4 pipeline (work-item extraction through final reconciliation)
 * against an in-memory transcript and returns both the raw `V4ExecutionState` (for independent
 * inspection/trace archival) and an evaluator-ready `MeetingSnapshot`. Calls OpenAI for every
 * model-backed stage -- this is a real, live run, not a simulation. */
export async function runV4PipelineLocally(input: LocalV4RunInput): Promise<LocalV4RunResult> {
  const originalByUuid = new Map<string, string>();
  const uuidSegments: TranscriptSegmentRow[] = input.transcriptSegments.map((segment, i) => {
    const uuid = toSyntheticUuid(i + 1);
    originalByUuid.set(uuid, segment.id);
    return { ...segment, id: uuid };
  });

  const transcript = buildCanonicalTranscriptWithSegmentIds(uuidSegments as unknown as TranscriptTextSegment[]);
  const source: ExecutionSourceContext = {
    meetingId: input.meetingId,
    meetingDate: input.meetingDate,
    transcript,
    topics: [],
    insights: [],
    project: null
  };

  let state = await runV4WorkItemExtraction({ source, fallbackUsed: input.fallbackUsed ?? false });
  state = await runV4GlobalCorrection(state);
  state = await runV4Grouping(state);
  state = await runV4GroupingVerification(state);
  state = await runV4TreeAssembly(state);
  state = await runV4TaskConsolidation(state);
  state = await runV4FinalReconciliation(state);
  state = await finalizeV4Execution(state);

  // Translate every synthetic-UUID segment id V4 produced/cited back to the frozen fixture's own
  // ids before this ever reaches the evaluator -- see the SYNTHETIC-ID ROUND-TRIP note above.
  const topicWorkItems = deepRemapIds(state.topicWorkItems, originalByUuid);
  const mergedWorkItems = deepRemapIds(state.mergedWorkItems, originalByUuid);
  const harvestTrace = deepRemapIds(state.completenessHarvestTrace, originalByUuid);
  const groundingRejectionTrace = deepRemapIds(state.completenessGroundingRejectionTrace, originalByUuid);
  const adjudicationTrace = deepRemapIds(state.completenessAdjudicationTrace, originalByUuid);
  const globalAdditions = deepRemapIds(state.globalAdditions, originalByUuid);
  const globalCorrections = deepRemapIds(state.globalCorrections, originalByUuid);
  const workItems = deepRemapIds(state.workItems, originalByUuid);
  const eligibleWorkItems = deepRemapIds(state.eligibleWorkItems, originalByUuid);
  const graph = deepRemapIds(state.graph, originalByUuid);
  const debugTrace = state.debugTrace ? deepRemapIds(state.debugTrace, originalByUuid) : state.debugTrace;

  const generation = 1;
  const snapshot: MeetingSnapshot = {
    meetingId: input.meetingId,
    jobId: `local-eval-${input.meetingId}`,
    generation,
    engine: "v4",
    fallbackUsed: state.fallbackUsed,
    transcriptSegments: input.transcriptSegments,
    topicWorkItems,
    mergedWorkItems,
    harvestTrace,
    groundingRejectionTrace,
    adjudicationTrace,
    traceTruncated: state.completenessTraceTruncated,
    globalAdditions,
    globalCorrections,
    workItems,
    eligibleWorkItems,
    metrics: state.metrics as unknown as Record<string, unknown>,
    finalCommitments: graph.commitments.map((c) => toFinalCommitmentRow(c, generation)),
    finalTasks: graph.tasks.map((t) => toFinalTaskRow(t, generation))
  };

  return { snapshot, state: { ...state, graph, debugTrace } };
}
