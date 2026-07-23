import { semanticTokenSimilarity } from "./graph";
import type { ExecutionGraph } from "./schemas";

export function linkTasksToCommitments(graph: ExecutionGraph): ExecutionGraph {
  const commitmentRefs = new Set(
    graph.commitments.map((commitment) => commitment.client_ref)
  );

  return {
    commitments: graph.commitments,
    tasks: graph.tasks.map((task) => {
      if (task.commitment_ref && commitmentRefs.has(task.commitment_ref)) {
        return task;
      }

      let bestRef: string | null = null;
      let bestScore = 0;
      for (const commitment of graph.commitments) {
        const sharedSegment = task.source_segment_ids.some((id) =>
          commitment.source_segment_ids.includes(id)
        );
        const titleSimilarity = semanticTokenSimilarity(
          task.title,
          commitment.title
        );
        const topicBonus =
          task.topic_id && task.topic_id === commitment.topic_id ? 0.15 : 0;
        const score = titleSimilarity + topicBonus + (sharedSegment ? 0.2 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestRef = commitment.client_ref;
        }
      }

      return {
        ...task,
        commitment_ref: bestScore >= 0.6 ? bestRef : null
      };
    })
  };
}
