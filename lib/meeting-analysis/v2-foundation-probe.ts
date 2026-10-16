import { getStepMetadata } from "workflow";
import { executeV2AnalysisUnit, type V2UnitInput } from "@/lib/meeting-analysis/v2-unit-execution";
import type { UnitResult } from "@/lib/meeting-analysis/job-units";

/** Controlled test seam only. No normal enqueue path and no V4/model work. B1 concrete
 * steps should use this same metadata/executor pattern, with serializable inputs. */
export async function runV2FoundationProbeStep(input: V2UnitInput & { result: UnitResult }) {
  "use step";
  return executeV2AnalysisUnit(input, getStepMetadata().attempt, async () => input.result);
}
