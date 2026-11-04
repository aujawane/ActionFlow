import { getStepMetadata } from "workflow";

import {
  finalizeV2Candidates,
  planV2Candidates,
  runV2CandidateUnit
} from "@/lib/meeting-analysis/v2-candidates";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

/** Concrete B2.2 steps: serializable inputs, small acknowledgements, logic lives in
 * v2-candidates.ts. */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

export async function planCandidatesStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => planV2Candidates(input, getStepMetadata().attempt));
}

export async function runCandidateUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2CandidateUnit(input, getStepMetadata().attempt));
}

export async function finalizeCandidatesStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2Candidates(input, getStepMetadata().attempt));
}
