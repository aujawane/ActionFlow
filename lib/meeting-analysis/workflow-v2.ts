import { runOrderedAnalysisUnits } from "@/lib/meeting-analysis/workflow-concurrency";
import { runV2FoundationProbeStep } from "@/lib/meeting-analysis/v2-foundation-probe";
import type { UnitResult } from "@/lib/meeting-analysis/job-units";

/** B0 controlled foundation probe. Explicit v2 claim required; never used by enqueue.ts.
 * B1 will add stage coordinators and concrete steps after durable-unit validation. */
export async function meetingAnalysisV2FoundationWorkflow(input: {
  meetingId: string; jobId: string; generation: number;
  units: { unitKey: string; result: UnitResult }[];
}) {
  "use workflow";
  return runOrderedAnalysisUnits(input.units, (unit) => runV2FoundationProbeStep({
    meetingId: input.meetingId, jobId: input.jobId, generation: input.generation,
    stage: "foundation_probe", ...unit
  }));
}
