import {
  persistDurableExecutionGraph,
  runCandidateExtraction,
  runCompleteness,
  runFinalVerification,
  runInitialVerification,
  type DurableExecutionState
} from "@/lib/execution-intelligence/durable-pipeline";
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

type AnalysisCheckpoint = {
  prepared?: PreparedMeetingAnalysis;
  state?: DurableExecutionState;
};

function asCheckpoint(value: unknown): AnalysisCheckpoint {
  if (!value || typeof value !== "object") return {};
  return value as AnalysisCheckpoint;
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
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (!checkpoint.prepared) {
      throw new Error("Missing prepared analysis checkpoint.");
    }

    if (input.stage === "candidates") {
      const state = await runCandidateExtraction({
        source: checkpoint.prepared.source,
        fallbackUsed: checkpoint.prepared.fallbackUsed
      });
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared: checkpoint.prepared, state }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (!checkpoint.state) {
      throw new Error("Missing execution graph checkpoint.");
    }

    if (input.stage === "verification") {
      const state = await runInitialVerification(checkpoint.state);
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared: checkpoint.prepared, state }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "completeness") {
      const state = await runCompleteness(checkpoint.state);
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared: checkpoint.prepared, state }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    if (input.stage === "final_verification") {
      const state = await runFinalVerification(checkpoint.state);
      await saveAnalysisJobCheckpoint({
        jobId: input.jobId,
        checkpoint: { prepared: checkpoint.prepared, state }
      });
      return { nextStage: nextWorkerStage(input.stage), done: false };
    }

    // persistence
    await markAnalysisJobRunning({
      jobId: input.jobId,
      stage: "persistence"
    });
    const persisted = await persistDurableExecutionGraph({
      state: checkpoint.state,
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
