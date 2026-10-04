"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ProjectVocabularyTerm } from "@/lib/types";

/** Pure grouping logic, exported separately so it's testable without a DOM/React-rendering
 * harness (this repo has neither -- see components/task-owner-select.tsx for the same pattern). */
export function groupVocabularyTermsByStatus(terms: readonly ProjectVocabularyTerm[]): {
  suggested: ProjectVocabularyTerm[];
  approved: ProjectVocabularyTerm[];
  rejected: ProjectVocabularyTerm[];
} {
  return {
    suggested: terms.filter((term) => term.status === "suggested"),
    approved: terms.filter((term) => term.status === "approved"),
    rejected: terms.filter((term) => term.status === "rejected")
  };
}

export function vocabularyEvidenceLabel(term: ProjectVocabularyTerm): string {
  const segmentCount = term.evidence_segment_ids.length;
  if (!term.evidence_meeting_id || segmentCount === 0) return "No transcript evidence recorded";
  return `${segmentCount} transcript segment${segmentCount === 1 ? "" : "s"}`;
}

/**
 * Minimal human-in-the-loop review surface for AI-discovered project vocabulary. AI suggestions
 * (status="suggested") are inert until explicitly approved here -- see
 * app/api/projects/[id]/vocabulary/[termId]/route.ts. Deliberately does not support creating new
 * terms by hand or editing an existing term's fields; approving/rejecting an existing suggestion is
 * the one required capability for this phase.
 */
export function ProjectVocabularyPanel({
  projectId,
  initialTerms
}: {
  projectId: string;
  initialTerms: ProjectVocabularyTerm[];
}) {
  const router = useRouter();
  const [terms, setTerms] = useState(initialTerms);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { suggested, approved, rejected } = groupVocabularyTermsByStatus(terms);

  async function review(termId: string, status: "approved" | "rejected") {
    if (pendingId) return;
    setError(null);
    setPendingId(termId);
    try {
      const response = await fetch(`/api/projects/${projectId}/vocabulary/${termId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.term) {
        setError(result.error || "Failed to update this suggestion.");
        return;
      }
      const updated = result.term as ProjectVocabularyTerm;
      setTerms((current) => current.map((term) => (term.id === termId ? updated : term)));
      router.refresh();
    } catch {
      setError("Network error while updating this suggestion.");
    } finally {
      setPendingId(null);
    }
  }

  if (terms.length === 0) return null;

  return (
    <section className="premium-card p-5">
      <h2 className="font-semibold text-slate-950">Project Vocabulary</h2>
      <p className="mt-1 text-xs text-slate-500">
        Terms the AI noticed while correcting meeting transcripts. Approved terms are used to
        correct future meetings automatically; suggestions below are not used until you approve
        them.
      </p>

      {error ? <p className="mt-3 text-xs font-medium text-rose-600">{error}</p> : null}

      {suggested.length > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Awaiting review ({suggested.length})
          </p>
          {suggested.map((term) => (
            <div
              key={term.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{term.canonical_term}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  <span className="capitalize">{term.term_type}</span>
                  {term.aliases.length > 0 ? ` · heard as "${term.aliases.join('", "')}"` : ""}
                  {" · "}
                  {Math.round(term.confidence * 100)}% confidence · {vocabularyEvidenceLabel(term)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pendingId === term.id}
                  aria-label={`Reject vocabulary suggestion ${term.canonical_term}`}
                  onClick={() => void review(term.id, "rejected")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="premium-button"
                  disabled={pendingId === term.id}
                  aria-label={`Approve vocabulary suggestion ${term.canonical_term}`}
                  onClick={() => void review(term.id, "approved")}
                >
                  Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {approved.length > 0 || rejected.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reviewed</p>
          {[...approved, ...rejected].map((term) => (
            <p key={term.id} className="text-xs text-slate-500">
              <span className="font-medium text-slate-700">{term.canonical_term}</span> —{" "}
              {term.status}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
