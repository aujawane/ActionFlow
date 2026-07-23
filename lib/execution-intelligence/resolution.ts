import type { ExecutionGraph } from "./schemas";

function normalizeNames(owner: string | null, owners: string[]) {
  const unique = new Map<string, string>();
  for (const value of [owner, ...owners]) {
    const normalized = value?.trim();
    if (!normalized || normalized.toLowerCase() === "unknown") continue;
    unique.set(normalized.toLowerCase(), normalized);
  }
  const resolvedOwners = Array.from(unique.values());
  return {
    owner: owner?.trim() || resolvedOwners[0] || null,
    owners: resolvedOwners
  };
}

export function resolveAssigneesAndDueDates(
  graph: ExecutionGraph
): ExecutionGraph {
  const commitments = graph.commitments.map((commitment) => ({
    ...commitment,
    ...normalizeNames(commitment.owner, commitment.owners)
  }));
  const commitmentsByRef = new Map(
    commitments.map((commitment) => [commitment.client_ref, commitment])
  );

  return {
    commitments,
    tasks: graph.tasks.map((task) => {
      const parent = task.commitment_ref
        ? commitmentsByRef.get(task.commitment_ref)
        : undefined;
      const names = normalizeNames(
        task.owner ?? parent?.owner ?? null,
        task.owners.length > 0 ? task.owners : parent?.owners ?? []
      );
      return {
        ...task,
        ...names,
        due_date: task.due_date ?? parent?.due_date ?? null,
        due_date_text: task.due_date_text ?? parent?.due_date_text ?? null
      };
    })
  };
}
