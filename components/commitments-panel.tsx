"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo } from "react";
import {
  commitmentProgress,
  formatClassificationLabel,
  getExecutionClassification,
  isCommittedWork
} from "@/lib/execution-display";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

function textArray(value: MeetingCommitment["owners"]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
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
  commitments,
  tasks
}: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  const activeCommitments = useMemo(
    () => commitments.filter(isCommittedWork),
    [commitments]
  );

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
          const classification = getExecutionClassification(
            commitment.execution_classification
          );

          return (
            <article
              key={commitment.id}
              className="rounded-2xl border border-brand-100 bg-brand-50/40 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-950">
                      {commitment.title}
                    </h3>
                    <span className="rounded-full border border-brand-200 bg-white px-2 py-0.5 text-[11px] font-semibold capitalize text-brand-800">
                      {formatClassificationLabel(classification)}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-600">
                      {commitment.type.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-600">
                      {formatStatus(commitment.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Owner: <span className="font-semibold">{ownerLabel}</span>
                    {supportingOwners.length > 0 ? (
                      <>
                        {" · Supporting: "}
                        <span className="font-semibold">{supportingOwners.join(", ")}</span>
                      </>
                    ) : null}
                    {commitment.due_date || commitment.due_date_text ? (
                      <>
                        {" · Due: "}
                        <span className="font-semibold">
                          {commitment.due_date ?? commitment.due_date_text}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                <Link
                  href={`/commitments/${commitment.id}` as Route}
                  className="rounded-lg border border-brand-200 bg-white px-2.5 py-1 text-xs font-semibold text-brand-800"
                >
                  Open Commitment
                </Link>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    {progress.total === 0
                      ? "No child tasks"
                      : `${progress.completed} of ${progress.total} tasks complete`}
                  </span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/80">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>

              {commitment.description ? (
                <p className="mt-3 text-sm leading-6 text-slate-700">
                  {commitment.description}
                </p>
              ) : null}

              {acceptanceCriteria(commitment).length > 0 ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white/70 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Acceptance criteria
                  </p>
                  <ul className="mt-1.5 space-y-1 text-sm text-slate-700">
                    {acceptanceCriteria(commitment).map((criterion) => (
                      <li key={criterion.ref} className="flex gap-2">
                        <span aria-hidden="true">•</span>
                        <span>{criterion.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

            </article>
          );
        })}
      </div>
    </section>
  );
}
