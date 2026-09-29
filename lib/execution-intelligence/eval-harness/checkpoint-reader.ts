import type { GlobalWorkItemAddition, GlobalWorkItemCorrection, WorkItem } from "../work-item-schemas";
import type { PassAGroundingRejectionTraceEntry, PassAHarvestTraceEntry } from "../work-item-stages";
import type { PassBAdjudicationTraceEntryResolved } from "../v4-pipeline";
import type { TopicWorkItemExtraction } from "../work-item-merge";
import type { FinalCommitmentRow, FinalTaskRow, MeetingSnapshot, TranscriptSegmentRow } from "./snapshot";

/**
 * READ-ONLY reconstruction of a MeetingSnapshot from an already-completed V4 analysis job's
 * persisted checkpoint, plus the meeting's final persisted commitments/tasks. Formalizes the exact
 * query pattern used by hand across the generation-11/12/13 forensic benchmarks (see
 * docs/V4_BENCHMARK_CRAIG_AUG19_GEN1{1,2,3}_*.md) and by app/api/dev/meeting-extraction-debug/
 * route.ts, so future evaluation never needs another one-off script.
 *
 * Issues exactly 4 SELECTs (job, transcript_segments, meeting_commitments, meeting_tasks). Never
 * writes, never calls OpenAI, never mutates a row -- reading a `status="completed"` job's own
 * already-computed checkpoint is the entire point.
 */
/** Mirrors the (thenable) shape of a real @supabase/supabase-js PostgrestFilterBuilder chain --
 * `.eq()`/`.order()` keep returning a builder, and the builder itself resolves like a Promise when
 * awaited directly, exactly like the real thing. `maybeSingle()` resolves to a single row. */
type QueryBuilder = {
  eq: (column: string, value: unknown) => QueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
} & PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

/** A minimal structural shape of the one Supabase client method this reader actually calls, so it
 * never has to pin a specific `SupabaseClient<...>` generic instantiation (which drifts between
 * @supabase/supabase-js versions and between callers that pass a typed vs. untyped Database schema)
 * -- any real client (typed or not) satisfies this. */
export type MinimalSupabaseClient = {
  from: (table: string) => {
    select: (columns: string) => QueryBuilder;
  };
};

export async function readMeetingSnapshot(input: {
  client: MinimalSupabaseClient;
  meetingId: string;
  /** Either pass a specific jobId, or a generation to look up within this meeting -- exactly one
   * of the two should be supplied. */
  jobId?: string;
  generation?: number;
}): Promise<{ ok: true; snapshot: MeetingSnapshot } | { ok: false; error: string }> {
  const { client, meetingId } = input;

  let jobQuery = client
    .from("meeting_analysis_jobs")
    .select("id, meeting_id, generation, status, current_stage, checkpoint")
    .eq("meeting_id", meetingId);
  jobQuery = input.jobId ? jobQuery.eq("id", input.jobId) : jobQuery.eq("generation", input.generation ?? -1);

  const [jobResult, segmentsResult, commitmentsResult, tasksResult] = await Promise.all([
    jobQuery.maybeSingle(),
    client.from("transcript_segments").select("id, timestamp, speaker, text").eq("meeting_id", meetingId).order("timestamp"),
    client.from("meeting_commitments").select("id, title, owner, owners, status, metadata").eq("meeting_id", meetingId),
    client.from("meeting_tasks").select("id, task, owner, owners, status, extraction_metadata").eq("meeting_id", meetingId)
  ]);

  if (jobResult.error) return { ok: false, error: `job query failed: ${jobResult.error.message}` };
  if (!jobResult.data) return { ok: false, error: `no job found for meeting ${meetingId} (jobId=${input.jobId}, generation=${input.generation})` };
  // `maybeSingle()`'s row shape is intentionally left as `unknown` in QueryBuilder (this reader has
  // no compile-time guarantee of the actual meeting_analysis_jobs column types) -- narrowed once,
  // explicitly, right here to exactly the columns this reader's own `.select(...)` requested.
  const job = jobResult.data as { id: string; generation: number; status: string; checkpoint: unknown };
  if (job.status !== "completed") {
    return { ok: false, error: `job ${job.id} has status "${job.status}", not "completed" -- refusing to evaluate an incomplete run` };
  }
  if (segmentsResult.error) return { ok: false, error: `transcript_segments query failed: ${segmentsResult.error.message}` };
  if (commitmentsResult.error) return { ok: false, error: `meeting_commitments query failed: ${commitmentsResult.error.message}` };
  if (tasksResult.error) return { ok: false, error: `meeting_tasks query failed: ${tasksResult.error.message}` };

  const checkpoint = job.checkpoint as
    | {
        engine?: string;
        v4State?: {
          fallbackUsed?: boolean;
          topicWorkItems?: TopicWorkItemExtraction[];
          mergedWorkItems?: WorkItem[];
          completenessHarvestTrace?: PassAHarvestTraceEntry[];
          completenessGroundingRejectionTrace?: PassAGroundingRejectionTraceEntry[];
          completenessAdjudicationTrace?: PassBAdjudicationTraceEntryResolved[];
          completenessTraceTruncated?: boolean;
          globalAdditions?: GlobalWorkItemAddition[];
          globalCorrections?: GlobalWorkItemCorrection[];
          workItems?: WorkItem[];
          eligibleWorkItems?: WorkItem[];
          metrics?: Record<string, unknown>;
        };
      }
    | null
    | undefined;

  if (!checkpoint) return { ok: false, error: `job ${job.id} has no checkpoint` };
  if (checkpoint.engine !== "v4") {
    return { ok: false, error: `job ${job.id} used engine "${checkpoint.engine}", not "v4" -- this harness only evaluates V4 runs` };
  }
  const v4State = checkpoint.v4State;
  if (!v4State) return { ok: false, error: `job ${job.id}'s checkpoint has no v4State` };

  const snapshot: MeetingSnapshot = {
    meetingId,
    jobId: job.id,
    generation: job.generation,
    engine: checkpoint.engine ?? null,
    fallbackUsed: v4State.fallbackUsed ?? false,
    transcriptSegments: (segmentsResult.data ?? []) as TranscriptSegmentRow[],
    topicWorkItems: v4State.topicWorkItems ?? [],
    mergedWorkItems: v4State.mergedWorkItems ?? [],
    harvestTrace: v4State.completenessHarvestTrace ?? [],
    groundingRejectionTrace: v4State.completenessGroundingRejectionTrace ?? [],
    adjudicationTrace: v4State.completenessAdjudicationTrace ?? [],
    traceTruncated: v4State.completenessTraceTruncated ?? false,
    globalAdditions: v4State.globalAdditions ?? [],
    globalCorrections: v4State.globalCorrections ?? [],
    workItems: v4State.workItems ?? [],
    eligibleWorkItems: v4State.eligibleWorkItems ?? [],
    metrics: v4State.metrics ?? null,
    finalCommitments: (commitmentsResult.data ?? []) as FinalCommitmentRow[],
    finalTasks: (tasksResult.data ?? []) as FinalTaskRow[]
  };

  return { ok: true, snapshot };
}
