import { getStepMetadata } from "workflow";

import {
  finalizeV2TopicExtraction,
  runTopicAnalysisUnit,
  runTopicSegmentationUnit
} from "@/lib/meeting-analysis/v2-topic-extraction";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

/** Concrete B1 steps: serializable inputs, small acknowledgements, logic lives in
 * v2-topic-extraction.ts (same metadata/executor pattern as the B0 probe). Terminal handling is
 * workflow-wide (failV2AnalysisStep in v2-workflow-steps.ts). */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

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
