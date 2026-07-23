import type { MeetingCommitment, MeetingTask } from "@/lib/types";

function textArray(value: MeetingCommitment["owners"]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function CommitmentsPanel({
  commitments,
  tasks
}: {
  commitments: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  if (commitments.length === 0) {
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
          Outcomes and responsibilities created from this meeting, with their
          linked execution steps.
        </p>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {commitments.map((commitment) => {
          const linkedTasks = tasks.filter(
            (task) => task.commitment_id === commitment.id
          );
          const owners = textArray(commitment.owners);
          const ownerLabel =
            owners.length > 0
              ? owners.join(", ")
              : commitment.owner || "Unassigned";

          return (
            <article
              key={commitment.id}
              className="rounded-2xl border border-brand-100 bg-brand-50/40 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-slate-950">
                    {commitment.title}
                  </h3>
                  <p className="mt-1 text-xs text-slate-600">
                    Owner: <span className="font-semibold">{ownerLabel}</span>
                  </p>
                </div>
                <span className="rounded-full border border-brand-200 bg-white px-2 py-1 text-xs font-semibold capitalize text-brand-800">
                  {commitment.type.replace("_", " ")}
                </span>
              </div>

              {commitment.description ? (
                <p className="mt-3 text-sm leading-6 text-slate-700">
                  {commitment.description}
                </p>
              ) : null}

              {linkedTasks.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Execution steps
                  </p>
                  <ul className="mt-2 space-y-2">
                    {linkedTasks.map((task) => (
                      <li
                        key={task.id}
                        className="flex gap-2 text-sm text-slate-700"
                      >
                        <span aria-hidden="true">•</span>
                        <span>
                          {task.task}
                          {task.inferred ? (
                            <span className="ml-2 text-xs font-medium text-slate-500">
                              inferred
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-4 text-xs text-slate-500">
                  No execution steps were required or reliably inferred.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
