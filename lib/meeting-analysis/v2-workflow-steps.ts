import { FatalError, getStepMetadata } from "workflow";

import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import type { WorkerAnalysisStage } from "@/lib/meeting-analysis/jobs";
import {
  initializeV2Topology,
  markV2AnalysisFailed,
  retryCountFromAttempt
} from "@/lib/meeting-analysis/v2-lifecycle";
import { runAnalysisStage } from "@/lib/meeting-analysis/workflow-steps";

/** Workflow-level pipeline-v2 steps: serializable inputs, small acknowledgements. */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

/** Business validation (stale, terminal, wrong version/topology) is never retried. Every other
 * error keeps its Workflow retry eligibility. */
export async function asFatalOnValidation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AnalysisUnitValidationError) throw new FatalError(error.message);
    throw error;
  }
}

export async function initializeV2TopologyStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => initializeV2Topology(input));
}

/** The unchanged v1 stage logic (runAnalysisStage), plus retry_count from the step attempt. */
export async function runV2AnalysisStageStep(input: V2JobInput & { stage: WorkerAnalysisStage }) {
  "use step";
  return runAnalysisStage({ ...input, retryCount: retryCountFromAttempt(getStepMetadata().attempt) });
}

export async function failV2AnalysisStep(input: V2JobInput & { error: string }) {
  "use step";
  await markV2AnalysisFailed(input);
}
