import {
  formatClassificationLabel,
  getExecutionClassification
} from "@/lib/execution-display";
import type { MeetingCommitment, MeetingTask } from "@/lib/types";

export function IdeasRequirementsPanel({
  commitments,
  tasks
}: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  if (commitments.length === 0 && tasks.length === 0) return null;

  return (
    <section className="premium-card space-y-4 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Parking Lot
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">
          Ideas / Requirements
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Discussed items that are not yet committed execution work. These do not
          count toward action-item totals, owner workload, or follow-up emails.
        </p>
      </div>

      {commitments.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Commitments
          </p>
          {commitments.map((commitment) => (
            <div
              key={commitment.id}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-slate-900">
                  {commitment.title}
                </p>
                <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {formatClassificationLabel(
                    getExecutionClassification(commitment.execution_classification)
                  )}
                </span>
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
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-slate-900">{task.task}</p>
                <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {formatClassificationLabel(
                    getExecutionClassification(task.execution_classification)
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
