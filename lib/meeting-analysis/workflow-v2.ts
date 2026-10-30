import { ANALYSIS_STAGE_ORDER } from "@/lib/meeting-analysis/jobs";
import { runOrderedAnalysisUnits } from "@/lib/meeting-analysis/workflow-concurrency";
import { runV2FoundationProbeStep } from "@/lib/meeting-analysis/v2-foundation-probe";
import {
  finalizeTopicExtractionStep,
  runTopicAnalysisUnitStep,
  runTopicSegmentationStep
} from "@/lib/meeting-analysis/v2-topic-steps";
import {
  failV2AnalysisStep,
  initializeV2TopologyStep,
  runV2AnalysisStageStep
} from "@/lib/meeting-analysis/v2-workflow-steps";
import type { UnitResult } from "@/lib/meeting-analysis/job-units";

/** B0 controlled foundation probe. Explicit v2 claim required; never used by enqueue.ts. */
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

const STAGES_AFTER_TOPICS = ANALYSIS_STAGE_ORDER.slice(ANALYSIS_STAGE_ORDER.indexOf("topic_extraction") + 1);

/** Pipeline v2 (B2 topology). topic_extraction is durable fan-out; every other stage runs the
 * unchanged v1 stage logic (with v2 checkpoint merging). Started only by enqueueMeetingAnalysisV2
 * (explicit, staging-gated opt-in), always on a freshly claimed job. */
export async function meetingAnalysisV2Workflow(input: { meetingId: string; jobId: string; generation: number }) {
  "use workflow";
  try {
    // Before any model work: B2-only steps reject jobs without this marker (B1-era v2 jobs).
    await initializeV2TopologyStep(input);
    await runV2AnalysisStageStep({ ...input, stage: "transcript_normalization" });
    const { units } = await runTopicSegmentationStep(input);
    await runOrderedAnalysisUnits(units, (unit) => runTopicAnalysisUnitStep({ ...input, unitKey: unit.unitKey }));
    let finalized = await finalizeTopicExtractionStep(input);
    if (finalized.status === "fallback_required") {
      // v1 topic-insert fallback: the rejected topic transaction rolled back; analyze the
      // whole meeting once (durable meeting:000000) and replace canonical output with it.
      await runTopicAnalysisUnitStep({ ...input, unitKey: finalized.unitKey });
      finalized = await finalizeTopicExtractionStep(input);
    }
    if (finalized.status !== "completed") throw new Error("Topic extraction fallback did not finalize.");
    for (const stage of STAGES_AFTER_TOPICS) {
      await runV2AnalysisStageStep({ ...input, stage });
    }
  } catch (error) {
    // Reached only after a step's Workflow retries are exhausted or a FatalError. A stale or
    // already-failed job matches no row. A hard platform kill never reaches this.
    await failV2AnalysisStep({
      ...input, error: error instanceof Error ? error.message : "Meeting analysis failed."
    });
    throw error;
  }
}
