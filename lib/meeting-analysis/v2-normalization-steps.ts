import { getStepMetadata } from "workflow";

import {
  finalizeV2Normalization,
  planV2Normalization,
  runV2NormalizationUnit
} from "@/lib/meeting-analysis/v2-normalization";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

/** Concrete durable-normalization steps: serializable inputs, small acknowledgements, logic lives
 * in v2-normalization.ts. */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

export async function planNormalizationStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => planV2Normalization(input, getStepMetadata().attempt));
}

export async function runNormalizationUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2NormalizationUnit(input, getStepMetadata().attempt));
}

export async function finalizeNormalizationStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2Normalization(input, getStepMetadata().attempt));
}
