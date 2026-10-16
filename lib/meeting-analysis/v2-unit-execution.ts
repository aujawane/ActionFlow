import {
  AnalysisUnitValidationError, markAnalysisUnitRunning, completeAnalysisUnit, failAnalysisUnit,
  type AnalysisUnitIdentity, type UnitResult
} from "@/lib/meeting-analysis/job-units";
import { assertV2AnalysisJob } from "@/lib/meeting-analysis/v2-validation";

export interface V2UnitInput extends AnalysisUnitIdentity { meetingId: string }
const persistence = {
  validate: assertV2AnalysisJob,
  running: markAnalysisUnitRunning,
  complete: completeAnalysisUnit,
  fail: failAnalysisUnit
};
export type V2UnitPersistence = typeof persistence;

/** Called INSIDE a concrete `use step` function with getStepMetadata().attempt.
 * SDK attempts are one-based. retry_count is max(attempt - 1) in SQL.
 * Business validation explicitly throws AnalysisUnitValidationError/FatalError.
 * Other errors retain SDK retry eligibility, including ambiguous completion failures.
 * A failed unit is retryable via running; the stage coordinator owns job terminal handling.
 * No checkpoint copies enter this API: only the stage coordinator may save snapshots.
 */
export async function executeV2AnalysisUnit(
  input: V2UnitInput,
  attempt: number,
  execute: () => Promise<UnitResult>,
  store: V2UnitPersistence = persistence
): Promise<UnitResult> {
  try {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new AnalysisUnitValidationError("Workflow attempt must be a positive one-based integer.");
    }
    await store.validate(input);
    const unit = await store.running({ ...input, attempt });
    if (unit.status === "completed") return unit.result;
    let result: UnitResult;
    try {
      result = await execute();
    } catch (error) {
      try {
        await store.fail({ ...input, attempt, error: error instanceof Error ? error.message : "Unit failed." });
      } catch (persistError) {
        if (persistError instanceof AnalysisUnitValidationError) throw persistError;
        // Keep the original retry classification if failure telemetry is unavailable.
        console.warn("[meeting-analysis-v2] Could not persist unit failure.");
      }
      throw error;
    }
    // A lost completion response must retry, then reuse the durable accepted result.
    return (await store.complete({ ...input, attempt, result })).result;
  } catch (error) {
    if (error instanceof AnalysisUnitValidationError) {
      // Dynamic import also supports Node test runners: workflow's `require` export
      // is its TypeScript plugin, while the ESM export contains runtime utilities.
      const { FatalError } = await import("workflow");
      throw new FatalError(error.message);
    }
    throw error;
  }
}
