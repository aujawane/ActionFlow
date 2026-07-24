export function InferredTaskBadge() {
  return (
    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
      Inferred
    </span>
  );
}

export function CommitmentLinkBadge({ title }: { title: string }) {
  return (
    <span className="rounded-full border border-brand-100 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-800">
      Commitment: {title}
    </span>
  );
}
