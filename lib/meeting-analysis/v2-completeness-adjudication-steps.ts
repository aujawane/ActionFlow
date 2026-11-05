import { getStepMetadata } from "workflow";

import {
  finalizeV2Completeness,
  finalizeV2CompletenessPrimary,
  planV2CompletenessPrimary,
  runV2CompletenessCoverageUnit,
  runV2CompletenessPrimaryUnit
} from "@/lib/meeting-analysis/v2-completeness-adjudication";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

type V2JobInput = { meetingId: string; jobId: string; generation: number };

export async function planCompletenessPrimaryStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => planV2CompletenessPrimary(input, getStepMetadata().attempt));
}

export async function runCompletenessPrimaryUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2CompletenessPrimaryUnit(input, getStepMetadata().attempt));
}

export async function finalizeCompletenessPrimaryStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2CompletenessPrimary(input, getStepMetadata().attempt));
}

export async function runCompletenessCoverageUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2CompletenessCoverageUnit(input, getStepMetadata().attempt));
}

export async function finalizeCompletenessStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2Completeness(input, getStepMetadata().attempt));
}
