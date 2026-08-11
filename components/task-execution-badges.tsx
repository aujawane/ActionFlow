/** AI/extraction metadata (this task was inferred rather than explicitly stated) -- kept subtle so
 * it never competes with the task's actual status/content. */
export function InferredTaskBadge() {
  return <span className="badge-internal">Inferred</span>;
}

export function CommitmentLinkBadge({ title }: { title: string }) {
  return <span className="badge-meta">Commitment: {title}</span>;
}
