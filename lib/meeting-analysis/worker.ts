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
  runV4GlobalCorrection,
  runV4Grouping,
  runV4GroupingVerification,
  runV4TaskConsolidation,
  runV4TreeAssembly,
  runV4WorkItemExtraction,
  type V4ExecutionState
} from "@/lib/execution-intelligence/v4-pipeline";
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
  prepareMeetingAnalysis,
  type PreparedMeetingAnalysis
} from "@/lib/meeting-analysis/topics";
import { categorizeMeetingTasksBestEffort } from "@/lib/task-categorization-batch";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * `engine` is selected once, at `topic_extraction`, and carried through the rest of the durable
 * run so a single generation is never split across two execution-intelligence architectures. Jobs
 * queued before this field existed fall back to "independent" (see `resolveEngine`).
 */
type AnalysisCheckpoint = {
  engine?: ExecutionIntelligenceEngine;
  prepared?: PreparedMeetingAnalysis;
  state?: DurableExecutionState;
  v4State?: V4ExecutionState;
};

function asCheckpoint(value: unknown): AnalysisCheckpoint {
  if (!value || typeof value !== "object") return {};
  return value as AnalysisCheckpoint;
}

function resolveEngine(checkpoint: AnalysisCheckpoint): ExecutionIntelligenceEngine {
  return checkpoint.engine ?? "independent";
}

export async function runMeetingAnalysisStage(input: {
  meetingId: string;
  jobId: string;
  generation: number;
  stage: WorkerAnalysisStage;
  retryCount?: number;
}): Promise<{ nextStage: WorkerAnalysisStage | null; done: boolean }> {
  await assertAnalysisJobStillCurrent(input);
  await markAnalysisJobRunning({
    jobId: input.jobId,
    stage: input.stage,
    retryCount: input.retryCount ?? 0
  });

  const job = await getMeetingAnalysisJob(input.jobId);
  if (!job) throw new Error("Analysis job not found.");
  const checkpoint = asCheckpoint(job.checkpoint);

  try {
    if (input.stage === "topic_extraction") {
      const prepared = await prepareMeetingAnalysis(input.meetingId);
      const engine = getExecutionIntelligenceEngine();
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared, engine }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (!checkpoint.prepared) {
      throw new Error("Missing prepared analysis checkpoint.");
    }
    const engine = resolveEngine(checkpoint);

    if (input.stage === "conversation_events") {
      const source =
        engine === "v4"
          ? await runV4ConversationEventExtraction(checkpoint.prepared.source, input.generation)
          : await runConversationEventExtraction(checkpoint.prepared.source, input.generation);
      const prepared = { ...checkpoint.prepared, source };
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared, engine }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "candidates") {
      if (engine === "v4") {
        const v4State = await runV4WorkItemExtraction({
          source: checkpoint.prepared.source,
          fallbackUsed: checkpoint.prepared.fallbackUsed
        });
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      } else {
        const state = await runActionExtraction({
          source: checkpoint.prepared.source,
          fallbackUsed: checkpoint.prepared.fallbackUsed
        });
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, state }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "global_correction") {
      // Only v4 has a global correction/completeness pass; `independent` has no such concept and
      // passes the checkpoint through unchanged.
      if (engine === "v4") {
        if (!checkpoint.v4State) throw new Error("Missing execution graph checkpoint.");
        const v4State = await runV4GlobalCorrection(checkpoint.v4State);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (engine === "v4" ? !checkpoint.v4State : !checkpoint.state) {
      throw new Error("Missing execution graph checkpoint.");
    }

    if (input.stage === "verification") {
      if (engine === "v4") {
        const v4State = await runV4Grouping(checkpoint.v4State!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      } else {
        const state = await runCommitmentExtraction(checkpoint.state!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, state }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "completeness") {
      if (engine === "v4") {
        const v4State = await runV4GroupingVerification(checkpoint.v4State!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      } else {
        const state = await runRelationshipEvaluation(checkpoint.state!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, state }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "final_verification") {
      if (engine === "v4") {
        const v4State = await runV4TreeAssembly(checkpoint.v4State!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      } else {
        const state = await runEvidenceVerification(checkpoint.state!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, state }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "task_consolidation") {
      // Only v4 consolidates fragmented child tasks; `independent` has no such concept.
      if (engine === "v4") {
        const v4State = await runV4TaskConsolidation(checkpoint.v4State!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      }
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "synthesis") {
      if (engine === "v4") {
        const v4State = await finalizeV4Execution(checkpoint.v4State!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, v4State }
        });
      } else {
        const state = await finalizeIndependentExecution(checkpoint.state!);
        await saveAnalysisJobCheckpoint({
          jobId: input.jobId,
          checkpoint: { prepared: checkpoint.prepared, engine, state }
        });
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
