/** Workflow-safe: no I/O, clock, Node APIs, or implicit sorting. */
export const ANALYSIS_UNIT_CONCURRENCY = 2;

export interface OrderedAnalysisUnit {
  unitKey: string;
}

/** Callers explicitly sort stable keys (topic:000000, chunk:000000, batch:000000).
 * Reject ambiguous/duplicate order BEFORE starting any steps. DB order is never a contract.
 * Promise.all rejection stops later windows; an already-running sibling is NOT cancelled.
 */
export async function runOrderedAnalysisUnits<T extends OrderedAnalysisUnit, R>(
  units: readonly T[],
  runUnit: (unit: T) => Promise<R>
): Promise<R[]> {
  for (let index = 0; index < units.length; index += 1) {
    if (!units[index].unitKey || (index > 0 && units[index - 1].unitKey >= units[index].unitKey)) {
      throw new Error("Analysis units must have unique, explicitly ordered stable keys.");
    }
  }
  const results: R[] = [];
  for (let offset = 0; offset < units.length; offset += ANALYSIS_UNIT_CONCURRENCY) {
    const window = units.slice(offset, offset + ANALYSIS_UNIT_CONCURRENCY);
    results.push(...await Promise.all(window.map(runUnit)));
  }
  return results;
}
