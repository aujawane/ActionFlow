"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";

import { InferredTaskBadge } from "@/components/task-execution-badges";
import {
  commitmentProgress,
  formatClassificationLabel,
  getExecutionClassification,
  isCommittedWork
} from "@/lib/execution-display";
import { isInferredTask } from "@/lib/task-execution-display";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

function textArray(value: MeetingCommitment["owners"]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (activeCommitments.length === 0) {
    return null;
  }

  function toggle(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="premium-card p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Execution Graph
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Commitments</h2>
        <p className="mt-1 text-sm text-slate-600">
          Agreed outcomes and responsibilities. Expand a commitment to see the
          distinct execution steps needed to fulfill it.
        </p>
      </div>

      <div className="mt-5 space-y-3">
        {activeCommitments.map((commitment) => {
          const linkedTasks = tasks.filter(
            (task) => task.commitment_id === commitment.id && isCommittedWork(task)
          );
          const progress = commitmentProgress(commitment, tasks);
          const owners = textArray(commitment.owners);
          const ownerLabel =
            owners.length > 0
              ? owners.join(", ")
              : commitment.owner || "Unassigned";
          const expanded = expandedIds.has(commitment.id);
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
                <button
                  type="button"
                  onClick={() => toggle(commitment.id)}
                  className="rounded-lg border border-brand-200 bg-white px-2.5 py-1 text-xs font-semibold text-brand-800"
                >
                  {expanded ? "Collapse" : "Expand"}
                </button>
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

              {expanded ? (
                <div className="mt-4 space-y-2">
                  {linkedTasks.length > 0 ? (
                    linkedTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white bg-white/80 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900">
                            {task.task}
                            {isInferredTask(task) ? (
                              <span className="ml-2 inline-flex align-middle">
                                <InferredTaskBadge />
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-slate-500">
                            {task.owner || "Unassigned"} · {formatStatus(task.status)}
                          </p>
                        </div>
                        <Link
                          href={`/tasks/${task.id}` as Route}
                          className="text-xs font-semibold text-brand-700 hover:underline"
                        >
                          Open workspace
                        </Link>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">
                      No distinct execution steps were required beyond this
                      commitment.
                    </p>
                  )}
                </div>
              ) : null}

              {linkedTasks[0] ? (
                <div className="mt-3">
                  <Link
                    href={`/tasks/${linkedTasks[0].id}` as Route}
                    className="text-xs font-semibold text-brand-700 hover:underline"
                  >
                    Open commitment workspace
                  </Link>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
