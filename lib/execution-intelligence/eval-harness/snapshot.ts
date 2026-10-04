import type {
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
  WorkItem
} from "../work-item-schemas";
import type { PassAGroundingRejectionTraceEntry, PassAHarvestTraceEntry } from "../work-item-stages";
import type { PassBAdjudicationTraceEntryResolved } from "../v4-pipeline";
import type { TopicWorkItemExtraction } from "../work-item-merge";

/**
 * The read-only slice of one completed V4 generation's persisted state the evaluator operates on.
 * Deliberately decoupled from *how* it was fetched (a live Supabase read for the CLI, a hand-built
 * object for tests) -- see scripts/eval-v4-ground-truth.ts for the live checkpoint reader and
 * tests/v4-eval-harness.test.ts for synthetic snapshots. Every field here is read verbatim from
 * `meeting_analysis_jobs.checkpoint.v4State` (or its `debugTrace`) and the final
 * `meeting_commitments`/`meeting_tasks` rows -- nothing here is derived by re-running any pipeline
 * stage.
 */
export type TranscriptSegmentRow = {
  id: string;
  timestamp: string;
  speaker: string;
  text: string;
};

export type FinalTaskRow = {
  id: string;
  task: string;
  owner: string | null;
  owners?: string[];
  status: string;
  extraction_metadata?: {
    client_ref?: string | null;
    merge_provenance?: { merged_from_task_refs?: string[] } | null;
  } | null;
};

export type FinalCommitmentRow = {
  id: string;
  title: string;
  owner: string | null;
  owners?: string[];
  status: string;
  metadata?: {
    client_ref?: string | null;
    supporting_action_refs?: string[];
    consolidated_from_refs?: string[];
    analysis_generation?: number | null;
  } | null;
};

export type MeetingSnapshot = {
  meetingId: string;
  jobId: string;
  generation: number;
  engine: string | null;
  fallbackUsed: boolean;
  transcriptSegments: TranscriptSegmentRow[];

  /** Initial (topic-scoped) extraction, before completeness recovery ever runs. */
  topicWorkItems: TopicWorkItemExtraction[];
  /** Initial extraction after mergeTopicWorkItems's own dedup -- still pre-completeness. */
  mergedWorkItems: WorkItem[];

  /** Pass A / Pass B diagnostic trace (see work-item-stages.ts / v4-pipeline.ts). Empty arrays for
   * a generation predating this trace's introduction -- the tracer degrades gracefully (see
   * stage-tracer.ts), reporting those stages as "unknown" rather than "absent". Always the
   * *resolved* shape (candidate_id already joined to its resulting WorkItem ref where
   * applicable) -- that is the only shape ever persisted to a checkpoint; the unresolved
   * `PassBAdjudicationTraceEntry` is a purely in-memory intermediate inside
   * runCompletenessAdjudicationPass and never reaches storage. */
  harvestTrace: PassAHarvestTraceEntry[];
  groundingRejectionTrace: PassAGroundingRejectionTraceEntry[];
  adjudicationTrace: PassBAdjudicationTraceEntryResolved[];
  traceTruncated: boolean;

  /** Completeness additions that survived grounding + both dedup layers. */
  globalAdditions: GlobalWorkItemAddition[];
  /** Lifecycle reconciliation's per-ref reviews (echoed-unchanged or repaired). */
  globalCorrections: GlobalWorkItemCorrection[];
  /** Final ledger: mergedWorkItems with corrections applied, plus globalAdditions. */
  workItems: WorkItem[];
  eligibleWorkItems: WorkItem[];

  /** Aggregate ExecutionMetrics for this generation, if persisted (introduced generation-11+). */
  metrics: Record<string, unknown> | null;

  /** Final, actually-persisted output -- the only thing a user ever sees. */
  finalCommitments: FinalCommitmentRow[];
  finalTasks: FinalTaskRow[];
};
