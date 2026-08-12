"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";
import { CommitmentCorrectionMenu } from "@/components/commitment-correction-menu";
import { commitmentProgress, isCommittedWork } from "@/lib/execution-display";
import { getActiveChildTasks } from "@/lib/execution-corrections";
import { formatReadableDate } from "@/lib/format-date";
import { formatStatusLabel, statusBadgeClassName } from "@/lib/status-badge";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

function textArray(value: MeetingCommitment["owners"]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

type AcceptanceCriterion = { ref: string; title: string };

/** V4 stores acceptance criteria in commitment.metadata (see execution-graph-v4.ts); other
 * engines simply have none, so this renders nothing for them. */
function acceptanceCriteria(commitment: MeetingCommitment): AcceptanceCriterion[] {
  const metadata = commitment.metadata as { acceptance_criteria?: unknown } | null;
  const raw = metadata?.acceptance_criteria;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is AcceptanceCriterion =>
      Boolean(item) && typeof item === "object" && typeof (item as { title?: unknown }).title === "string"
  );
}

export function CommitmentsPanel({
  commitments: initialCommitments,
  tasks
}: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  const [commitments, setCommitments] = useState(initialCommitments);
  const activeCommitments = useMemo(
    () => commitments.filter(isCommittedWork),
    [commitments]
  );

  function handleCommitmentUpdated(updated: MeetingCommitment) {
    setCommitments((current) =>
      current.map((commitment) => (commitment.id === updated.id ? updated : commitment))
    );
  }

  if (activeCommitments.length === 0) {
    return null;
  }

  return (
    <section className="premium-card p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Execution Graph
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Commitments</h2>
        <p className="mt-1 text-sm text-slate-600">
          Synthesized meeting-wide outcomes. Open a commitment to manage its
          owner-grouped execution tasks.
        </p>
      </div>

      <div className="mt-5 space-y-3">
        {activeCommitments.map((commitment) => {
          const progress = commitmentProgress(commitment, tasks);
          // The primary owner is the person accountable for the outcome (see
          // final-reconciliation.ts's ownership repair) -- distinct from `owners`, which is every
          // contributor with a child task. Showing the union as "Owner:" would misrepresent
          // supporting contributors as co-owners of the deliverable.
          const ownerLabel = commitment.owner || "Unassigned";
          const supportingOwners = textArray(commitment.owners).filter(
            (owner) => owner !== commitment.owner
          );
          const dueLabel = formatReadableDate(commitment.due_date) ?? commitment.due_date_text;
          const criteria = acceptanceCriteria(commitment);
          const hasActiveChildren = getActiveChildTasks(commitment, tasks).length > 0;

          return (
            <article key={commitment.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              {/* 1. Title + 2. status -- the two things that must be identifiable at a glance. */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="min-w-0 flex-1 font-semibold text-slate-950">{commitment.title}</h3>
                <div className="flex items-center gap-1.5">
                  <span className={`badge-state ${statusBadgeClassName(commitment.status)}`}>
                    {formatStatusLabel(commitment.status)}
                  </span>
                  <CommitmentCorrectionMenu
                    commitment={commitment}
                    hasActiveChildren={hasActiveChildren}
                    onCommitmentUpdated={handleCommitmentUpdated}
                  />
                </div>
              </div>

              {/* 3. Owner + 4. due date -- scannable, one line. Type is quiet product metadata. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                <span>
                  <span className="text-slate-500">Owner </span>
                  <span className="font-semibold text-slate-800">{ownerLabel}</span>
                </span>
                {supportingOwners.length > 0 ? (
                  <span>
                    <span className="text-slate-500">Supporting </span>
                    <span className="font-semibold text-slate-800">
                      {supportingOwners.slice(0, 2).join(", ")}
                      {supportingOwners.length > 2 ? ` +${supportingOwners.length - 2}` : ""}
                    </span>
                  </span>
                ) : null}
                {dueLabel ? (
                  <span>
                    <span className="text-slate-500">Due </span>
                    <span className="font-semibold text-slate-800">{dueLabel}</span>
                  </span>
                ) : null}
                <span className="badge-meta">{commitment.type.replaceAll("_", " ")}</span>
              </div>

              {/* 5. Progress -- numeric and visual together. */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {progress.total === 0
                      ? "No child tasks"
                      : `${progress.completed} / ${progress.total} tasks`}
                  </span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>

              {/* 6. Short description preview -- full text stays reachable via Open Commitment. */}
              {commitment.description ? (
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
                  {commitment.description}
                </p>
              ) : null}

              {criteria.length > 0 ? (
                <details className="disclosure mt-3">
                  <summary>{criteria.length} acceptance criteria</summary>
                  <ul className="mt-2 space-y-1 border-l-2 border-slate-100 pl-3 text-sm text-slate-700">
                    {criteria.map((criterion) => (
                      <li key={criterion.ref}>{criterion.title}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {/* 7. Primary navigation action. */}
              <div className="mt-4 flex justify-end">
                <Link
                  href={`/commitments/${commitment.id}` as Route}
                  className="secondary-button px-3 py-1.5 text-xs"
                >
                  Open Commitment
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
