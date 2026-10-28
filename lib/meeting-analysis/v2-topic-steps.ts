import { FatalError, getStepMetadata } from "workflow";

import { AnalysisUnitValidationError } from "@/lib/meeting-analysis/job-units";
import {
  finalizeV2TopicExtraction,
  markV2TopicExtractionFailed,
  runTopicAnalysisUnit,
  runTopicSegmentationUnit
} from "@/lib/meeting-analysis/v2-topic-extraction";

/** Concrete B1 steps: serializable inputs, small acknowledgements, logic lives in
 * v2-topic-extraction.ts (same metadata/executor pattern as the B0 probe). */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

/** Business validation (stale, terminal, malformed plan/merge) is never retried. */
async function asFatalOnValidation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AnalysisUnitValidationError) throw new FatalError(error.message);
    throw error;
  }
}

export async function runTopicSegmentationStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => runTopicSegmentationUnit(input, getStepMetadata().attempt));
}

export async function runTopicAnalysisUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runTopicAnalysisUnit(input, getStepMetadata().attempt));
}

export async function finalizeTopicExtractionStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2TopicExtraction(input, getStepMetadata().attempt));
}

export async function failV2TopicExtractionStep(input: V2JobInput & { error: string }) {
  "use step";
  await markV2TopicExtractionFailed(input);
}
