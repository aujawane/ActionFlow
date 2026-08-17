"use client";

import { useState } from "react";

import { CommitmentCorrectionMenu } from "@/components/commitment-correction-menu";
import { TaskCorrectionMenu } from "@/components/task-correction-menu";
import {
  formatClassificationLabel,
  getExecutionClassification
} from "@/lib/execution-display";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

export function IdeasRequirementsPanel({
  commitments: initialCommitments,
  tasks: initialTasks,
  meetingParticipantOptions = []
}: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
  /** Resolved participant names from this meeting -- see lib/meeting-participants.ts. Powers the
   * "Correct owner" picker inside each item's "Report incorrect extraction" dialog. */
  meetingParticipantOptions?: string[];
}) {
  const [commitments, setCommitments] = useState(initialCommitments);
  const [tasks, setTasks] = useState(initialTasks);

  function handleCommitmentUpdated(updated: MeetingCommitment) {
    // Promoted commitments are active work now -- they belong on Meeting Detail's Commitments
    // panel, not here.
    if (updated.execution_classification === "committed") {
      setCommitments((current) => current.filter((commitment) => commitment.id !== updated.id));
      return;
    }
    setCommitments((current) =>
      current.map((commitment) => (commitment.id === updated.id ? updated : commitment))
    );
  }

  function handleTaskUpdated(updated: MeetingTask) {
    if (updated.execution_classification === "committed") {
      setTasks((current) => current.filter((task) => task.id !== updated.id));
      return;
    }
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
  }

  if (commitments.length === 0 && tasks.length === 0) return null;

  return (
    <section className="premium-card space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">Future Scope</h2>
        <p className="mt-1 text-sm text-slate-600">
          Discussed, not currently committed. These do not count toward task totals,
          owner workload, or follow-up emails.
        </p>
      </div>

      {commitments.length > 0 ? (
        <div className="space-y-2">
          {/* Deliberately not labeled "Commitments" -- these are explicitly NOT active
              commitments (proposed/requirement/future_consideration classification only). */}
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Potential outcomes
          </p>
          {commitments.map((commitment) => (
            <div
              key={commitment.id}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    {commitment.title}
                  </p>
                  <span className="badge-meta">
                    {formatClassificationLabel(
                      getExecutionClassification(commitment.execution_classification)
                    )}
                  </span>
                </div>
                <CommitmentCorrectionMenu
                  commitment={commitment}
                  onCommitmentUpdated={handleCommitmentUpdated}
                />
              </div>
              {commitment.description ? (
                <p className="mt-1 text-xs text-slate-600">{commitment.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {tasks.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Tasks
          </p>
          {tasks.map((task) => (
            <div
              key={task.id}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-slate-900">{task.task}</p>
                  <span className="badge-meta">
                    {formatClassificationLabel(
                      getExecutionClassification(task.execution_classification)
                    )}
                  </span>
                </div>
                <TaskCorrectionMenu
                  task={task}
                  onTaskUpdated={handleTaskUpdated}
                  meetingParticipantOptions={meetingParticipantOptions}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
