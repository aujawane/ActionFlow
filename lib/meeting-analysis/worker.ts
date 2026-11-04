import {
  persistDurableExecutionGraph,
  runActionExtraction,
  runCommitmentExtraction,
  runConversationEventExtraction,
  runEvidenceVerification,
  finalizeIndependentExecution,
  runRelationshipEvaluation,
  type DurableExecutionState
} from "@/lib/execution-intelligence/durable-pipeline";
import {
  finalizeV4Execution,
  persistV4ExecutionGraph,
  runV4ConversationEventExtraction,
  runV4FinalReconciliation,
  runV4GlobalCorrection,
  runV4GlobalCorrectionAfterHarvest,
  runV4Grouping,
  runV4GroupingVerification,
  runV4TaskConsolidation,
  runV4TreeAssembly,
  runV4WorkItemExtraction,
  type V4ExecutionState
} from "@/lib/execution-intelligence/v4-pipeline";
import type { AtomicActionHarvestPassResult } from "@/lib/execution-intelligence/work-item-stages";
import {
  getExecutionIntelligenceEngine,
  type ExecutionIntelligenceEngine
} from "@/lib/env";
import {
  assertAnalysisJobStillCurrent,
  getMeetingAnalysisJob,
  markAnalysisJobRunning,
  markAnalysisJobTerminal,
  nextWorkerStage,
  saveAnalysisJobCheckpoint,
  StaleAnalysisError,
  type WorkerAnalysisStage
} from "@/lib/meeting-analysis/jobs";
import {
  CHECKPOINT_VERSION,
  saveV2Checkpoint,
  stageCheckpoint,
  validateB2Topology
} from "@/lib/meeting-analysis/checkpoint";
import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import { normalizeMeetingTranscriptForAnalysis } from "@/lib/meeting-analysis/normalization";
import {
  prepareMeetingAnalysis,
  type PreparedMeetingAnalysis
} from "@/lib/meeting-analysis/topics";
import { categorizeMeetingTasksBestEffort } from "@/lib/task-categorization-batch";
import { runDependencyInferenceBestEffort } from "@/lib/task-dependency-inference-batch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingAnalysisJob } from "@/lib/types";

/**
 * `engine` is selected once, at `topic_extraction`, and carried through the rest of the durable
 * run so a single generation is never split across two execution-intelligence architectures. Jobs
 * queued before this field existed fall back to "independent" (see `resolveEngine`).
 */
type AnalysisCheckpoint = {
  engine?: ExecutionIntelligenceEngine;
  /** Summary only (counts), for observability -- the actual normalized text/corrections are
   * persisted directly onto transcript_segments, not carried through the checkpoint. */
  normalization?: Awaited<ReturnType<typeof normalizeMeetingTranscriptForAnalysis>>;
  prepared?: PreparedMeetingAnalysis;
  state?: DurableExecutionState;
  v4State?: V4ExecutionState;
  gcV2?: { harvest?: Extract<AtomicActionHarvestPassResult, { ok: true }>; [key: string]: unknown };
};

function asCheckpoint(value: unknown): AnalysisCheckpoint {
  if (!value || typeof value !== "object") return {};
  return value as AnalysisCheckpoint;
}

function resolveEngine(checkpoint: AnalysisCheckpoint): ExecutionIntelligenceEngine {
  return checkpoint.engine ?? "independent";
}

/** The stage computations that precede each checkpoint write. Injectable for tests only; every
 * production caller uses these defaults. */
const stageDeps = {
  normalizeMeetingTranscriptForAnalysis,
  prepareMeetingAnalysis,
  getExecutionIntelligenceEngine,
  runConversationEventExtraction,
  runV4ConversationEventExtraction,
  runActionExtraction,
  runV4WorkItemExtraction,
  runV4GlobalCorrection,
  runV4GlobalCorrectionAfterHarvest,
  runCommitmentExtraction,
  runV4Grouping,
  runRelationshipEvaluation,
  runV4GroupingVerification,
  runEvidenceVerification,
  runV4TreeAssembly,
  runV4TaskConsolidation,
  runV4FinalReconciliation,
  finalizeV4Execution,
  finalizeIndependentExecution
};
export type MeetingAnalysisStageDeps = typeof stageDeps;

/**
 * Pipeline v1 writes each stage's literal exactly as it always has. Pipeline v2 merges the
 * stage-owned keys over the current checkpoint (checkpointVersion, normalization, v2Topology and
 * unknown keys survive) and writes through the generation-guarded save.
 */
async function saveStageCheckpoint(
  job: Pick<MeetingAnalysisJob, "pipeline_version" | "checkpoint">,
  input: { jobId: string; generation: number },
  owned: Record<string, unknown>,
  options: { remove?: readonly string[] } = {}
) {
  const checkpoint = stageCheckpoint(job, job.checkpoint, owned, options);
  if (job.pipeline_version !== 2) {
    await saveAnalysisJobCheckpoint({ jobId: input.jobId, checkpoint });
    return;
  }
  try {
    await saveV2Checkpoint({ jobId: input.jobId, generation: input.generation, checkpoint });
  } catch (error) {
    // Zero matching rows: superseded, stale or already terminal. Never mark such a job failed.
    if (error instanceof AnalysisUnitValidationError) throw new StaleAnalysisError(error.message);
    throw error;
  }
}

export async function runMeetingAnalysisStage(input: {
  meetingId: string;
  jobId: string;
  generation: number;
  stage: WorkerAnalysisStage;
  retryCount?: number;
}, deps: MeetingAnalysisStageDeps = stageDeps): Promise<{ nextStage: WorkerAnalysisStage | null; done: boolean }> {
  await assertAnalysisJobStillCurrent(input);
  await markAnalysisJobRunning({
    jobId: input.jobId,
    stage: input.stage,
    retryCount: input.retryCount ?? 0
  });

  const job = await getMeetingAnalysisJob(input.jobId);
  if (!job) throw new Error("Analysis job not found.");
  const checkpoint = asCheckpoint(job.checkpoint);
  const save = (owned: Record<string, unknown>, options?: { remove?: readonly string[] }) =>
    saveStageCheckpoint(job, input, owned, options);

  try {
    // A v2 checkpoint that already lost its version (a B1-era downstream write) is never merged
    // into or extended; fail before any stage work.
    if (job.pipeline_version === 2 && job.checkpoint?.checkpointVersion !== CHECKPOINT_VERSION) {
      throw new Error("Pipeline v2 checkpoint is missing checkpointVersion 2.");
    }

    if (input.stage === "transcript_normalization") {
      // Persists normalized_text/normalization_corrections/normalized_at directly onto
      // transcript_segments -- topic_extraction's ordinary re-query of that table picks up the
      // result automatically, so nothing besides a small summary needs to travel through the
      // checkpoint. A no-op (fast) when TRANSCRIPT_NORMALIZATION_ENABLED is off; a failed model
      // call degrades to leaving raw text in place, it never fails this stage or blocks the job.
      const normalization = await deps.normalizeMeetingTranscriptForAnalysis(input.meetingId);
      await save({ ...checkpoint, normalization });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "topic_extraction") {
      const prepared = await deps.prepareMeetingAnalysis(input.meetingId);
      const engine = deps.getExecutionIntelligenceEngine();
      await save({ ...checkpoint, prepared, engine });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (!checkpoint.prepared) {
      throw new Error("Missing prepared analysis checkpoint.");
    }
    const engine = resolveEngine(checkpoint);

    if (input.stage === "conversation_events") {
      const source =
        engine === "v4"
          ? await deps.runV4ConversationEventExtraction(checkpoint.prepared.source, input.generation)
          : await deps.runConversationEventExtraction(checkpoint.prepared.source, input.generation);
      const prepared = { ...checkpoint.prepared, source };
      await save({ prepared, engine });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "candidates") {
      if (engine === "v4") {
        const v4State = await deps.runV4WorkItemExtraction({
          source: checkpoint.prepared.source,
          fallbackUsed: checkpoint.prepared.fallbackUsed
        });
        await save({ prepared: checkpoint.prepared, engine, v4State });
      } else {
        const state = await deps.runActionExtraction({
          source: checkpoint.prepared.source,
          fallbackUsed: checkpoint.prepared.fallbackUsed
        });
        await save({ prepared: checkpoint.prepared, engine, state });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "global_correction") {
      // Only v4 has a global correction/completeness pass; `independent` has no such concept and
      // passes the checkpoint through unchanged.
      if (engine === "v4") {
        if (!checkpoint.v4State) throw new Error("Missing execution graph checkpoint.");
        if (job.pipeline_version === 2) {
          validateB2Topology(job);
          const harvest = checkpoint.gcV2?.harvest;
          if (!harvest || harvest.ok !== true || !Array.isArray(harvest.candidates)) {
            throw new AnalysisUnitValidationError("Missing atomic action harvest checkpoint.");
          }
          const v4State = await deps.runV4GlobalCorrectionAfterHarvest(checkpoint.v4State, harvest);
          await save({ prepared: checkpoint.prepared, engine, v4State }, { remove: ["gcV2"] });
        } else {
          const v4State = await deps.runV4GlobalCorrection(checkpoint.v4State);
          await save({ prepared: checkpoint.prepared, engine, v4State });
        }
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (engine === "v4" ? !checkpoint.v4State : !checkpoint.state) {
      throw new Error("Missing execution graph checkpoint.");
    }

    if (input.stage === "verification") {
      if (engine === "v4") {
        const v4State = await deps.runV4Grouping(checkpoint.v4State!);
        await save({ prepared: checkpoint.prepared, engine, v4State });
      } else {
        const state = await deps.runCommitmentExtraction(checkpoint.state!);
        await save({ prepared: checkpoint.prepared, engine, state });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "completeness") {
      if (engine === "v4") {
        const v4State = await deps.runV4GroupingVerification(checkpoint.v4State!);
        await save({ prepared: checkpoint.prepared, engine, v4State });
      } else {
        const state = await deps.runRelationshipEvaluation(checkpoint.state!);
        await save({ prepared: checkpoint.prepared, engine, state });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "final_verification") {
      if (engine === "v4") {
        const v4State = await deps.runV4TreeAssembly(checkpoint.v4State!);
        await save({ prepared: checkpoint.prepared, engine, v4State });
      } else {
        const state = await deps.runEvidenceVerification(checkpoint.state!);
        await save({ prepared: checkpoint.prepared, engine, state });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "task_consolidation") {
      // Only v4 consolidates fragmented child tasks; `independent` has no such concept.
      if (engine === "v4") {
        const v4State = await deps.runV4TaskConsolidation(checkpoint.v4State!);
        await save({ prepared: checkpoint.prepared, engine, v4State });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "synthesis") {
      if (engine === "v4") {
        const reconciled = await deps.runV4FinalReconciliation(checkpoint.v4State!);
        const v4State = await deps.finalizeV4Execution(reconciled);
        await save({ prepared: checkpoint.prepared, engine, v4State });
      } else {
        const state = await deps.finalizeIndependentExecution(checkpoint.state!);
        await save({ prepared: checkpoint.prepared, engine, state });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    // persistence
    await markAnalysisJobRunning({
      jobId: input.jobId,
      stage: "persistence"
    });
    const persisted =
      engine === "v4"
        ? await persistV4ExecutionGraph({ state: checkpoint.v4State!, generation: input.generation })
        : await persistDurableExecutionGraph({
            state: checkpoint.state!,
            generation: input.generation
          });

    await markAnalysisJobRunning({
      jobId: input.jobId,
      stage: "categorization"
    });
    if (persisted.tasks.length > 0 && process.env.OPENAI_API_KEY) {
      try {
        await categorizeMeetingTasksBestEffort({
          tasks: persisted.tasks,
          meetingContextByTopicId: new Map(
            checkpoint.prepared.meetingContextByTopicId
          )
        });
      } catch (error) {
        console.warn("[meeting-analysis] Task categorization failed:", error);
      }

      // Dependency inference enrichment -- runs once, after the canonical current commitment/
      // task graph is fully persisted. Best-effort/non-throwing by design (see
      // runDependencyInferenceBestEffort): a failure here must never fail the analysis job.
      try {
        await runDependencyInferenceBestEffort({
          commitments: persisted.commitments,
          tasks: persisted.tasks,
          meetingContextByTopicId: new Map(
            checkpoint.prepared.meetingContextByTopicId
          ),
          currentGeneration: input.generation
        });
      } catch (error) {
        console.warn("[meeting-analysis] Task dependency inference failed:", error);
      }
    }

    await markAnalysisJobTerminal({
      jobId: input.jobId,
      status: "completed",
      stage: "completed",
      progress: 100,
      error: null
    });
    await supabaseAdmin
      .from("meetings")
      .update({ status: "completed" })
      .eq("id", input.meetingId)
      .eq("execution_graph_generation", input.generation);

    return { nextStage: null, done: true };
  } catch (error) {
    if (error instanceof StaleAnalysisError || (error as Error)?.name === "StaleAnalysisError") {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "Meeting analysis failed.";
    await markAnalysisJobTerminal({
      jobId: input.jobId,
      status: "failed",
      stage: "failed",
      progress: 100,
      error: message
    });
    throw error;
  }
}
