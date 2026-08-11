import type { JsonValue, MeetingCommitment, MeetingTask } from "@/lib/types";

/**
 * The single source of truth for "is this row from the meeting's current analysis generation."
 * Every commitment/task row is stamped with the generation of the last analysis run that matched
 * it (see replace_meeting_execution_graph in the DB) -- a row nothing in the current run matched
 * keeps whatever (older) generation it last had. Rows the RPC's protective delete guards won't
 * remove (preserve_on_reanalysis, linked comments/artifacts, a still-referencing child task) can
 * survive indefinitely at that stale stamp even though a newer, correct generation has already
 * superseded them. A row with no stamp at all (e.g. created directly, outside the analysis
 * pipeline -- a manual record, or a Project Brain create_milestone) is treated as current -- there
 * is nothing to compare it against, and hiding user-created content because it predates generation
 * tracking would be wrong.
 *
 * Deliberately framework-agnostic (no UI imports) so every consumer -- meeting UI, project
 * execution aggregation, Project Brain's context loader, Project Brain's mutation-target
 * validation -- shares this one implementation instead of each reimplementing the comparison.
 */
function extractAnalysisGeneration(metadata: JsonValue | null | undefined): number | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).analysis_generation;
    if (typeof value === "number") return value;
  }
  return null;
}

export function isCommitmentCurrentGeneration(
  commitment: Pick<MeetingCommitment, "metadata">,
  currentGeneration: number | null | undefined
): boolean {
  if (currentGeneration == null) return true;
  const generation = extractAnalysisGeneration(commitment.metadata);
  return generation == null || generation === currentGeneration;
}

export function isTaskCurrentGeneration(
  task: Pick<MeetingTask, "extraction_metadata">,
  currentGeneration: number | null | undefined
): boolean {
  if (currentGeneration == null) return true;
  const generation = extractAnalysisGeneration(task.extraction_metadata ?? null);
  return generation == null || generation === currentGeneration;
}
