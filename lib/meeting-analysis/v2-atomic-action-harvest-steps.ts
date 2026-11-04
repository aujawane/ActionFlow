import { getStepMetadata } from "workflow";

import {
  finalizeV2AtomicActionHarvest,
  planV2AtomicActionHarvest,
  runV2AtomicActionHarvestUnit
} from "@/lib/meeting-analysis/v2-atomic-action-harvest";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

type V2JobInput = { meetingId: string; jobId: string; generation: number };

export async function planAtomicActionHarvestStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => planV2AtomicActionHarvest(input, getStepMetadata().attempt));
}

export async function runAtomicActionHarvestUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2AtomicActionHarvestUnit(input, getStepMetadata().attempt));
}

export async function finalizeAtomicActionHarvestStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2AtomicActionHarvest(input, getStepMetadata().attempt));
}
