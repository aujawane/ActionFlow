/**
 * @deprecated The semantic auto-linker is not used by the active `independent` or `v4` engines.
 * Retained only for old tests and migration context. See docs/execution-intelligence-v4.md for
 * the removal plan.
 */
import { semanticTokenSimilarity } from "./graph";
import type { ExecutionGraph } from "./schemas";

function websiteDeliveryNecessity(taskTitle: string, commitmentTitle: string) {
  const commitment = commitmentTitle.toLowerCase();
  const task = taskTitle.toLowerCase();
  return (
    /\b(website|site|e-commerce|ecommerce)\b/.test(commitment) &&
    /\b(images?|photos?|content|copy|founder story|domain|deploy|wireframes?|catalog|authentication|login|signup|payment|ordering|chatbot)\b/.test(
      task
    )
  );
}

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
        const necessityBonus = websiteDeliveryNecessity(
          task.title,
          commitment.title
        )
          ? 0.6
          : 0;
        const score =
          titleSimilarity + topicBonus + (sharedSegment ? 0.2 : 0) + necessityBonus;
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
/** @deprecated Semantic auto-linking is bypassed by relationship evaluation. */
