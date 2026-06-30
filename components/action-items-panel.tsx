import type { MeetingTask } from "@/lib/types";

function formatTaskType(taskType: MeetingTask["task_type"]) {
  if (taskType === "implicit_commitment") return "Implicit Commitment";
  if (taskType === "unassigned_work") return "Unassigned Work";
  return "Commitment";
}

function formatStatus(status: MeetingTask["status"]) {
  return status.replace("_", " ");
}

function formatConfidence(confidence: number | null) {
  if (confidence === null || Number.isNaN(confidence)) return null;
  return `${Math.round(confidence * 100)}% confidence`;
}

function getSuggestedSteps(task: MeetingTask) {
  if (!Array.isArray(task.suggested_steps)) {
    return [];
  }

  return task.suggested_steps.reduce<string[]>((steps, step) => {
    if (typeof step === "string" && step.trim().length > 0) {
      steps.push(step.trim());
    }
    return steps;
  }, []);
}

function TaskCard({ task }: { task: MeetingTask }) {
  const suggestedSteps = getSuggestedSteps(task);
  const confidence = formatConfidence(task.confidence);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{task.task}</p>
          <p className="mt-1 text-xs text-slate-500">
            Owner: <span className="font-medium text-slate-700">{task.owner || "Unassigned"}</span>
          </p>
        </div>
        {confidence ? (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
            {confidence}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full border border-brand-100 bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-800">
          {formatTaskType(task.task_type)}
        </span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium capitalize text-slate-700">
          {task.priority} priority
        </span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium capitalize text-slate-700">
          {formatStatus(task.status)}
        </span>
      </div>

      {suggestedSteps.length > 0 ? (
        <div className="mt-4 rounded-xl bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Suggested Next Steps
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-slate-700">
            {suggestedSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {task.source_quote ? (
        <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-xs italic text-slate-500">
          &ldquo;{task.source_quote}&rdquo;
        </blockquote>
      ) : null}
    </article>
  );
}

export function ActionItemsPanel({ tasks }: { tasks: MeetingTask[] }) {
  const commitments = tasks.filter((task) => task.task_type !== "unassigned_work");
  const unassignedWork = tasks.filter((task) => task.task_type === "unassigned_work");

  return (
    <div className="premium-card space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Action Items / Next Steps</h2>
        <p className="text-xs text-slate-500">
          Commitments, unassigned work, and follow-up steps detected for this topic.
        </p>
      </div>

      {tasks.length === 0 ? (
        <div className="premium-empty p-6 text-left">
          <p className="text-sm font-semibold text-slate-800">
            No clear action items found for this topic.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {commitments.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Commitments
              </h3>
              <div className="space-y-3">
                {commitments.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </section>
          ) : null}

          {unassignedWork.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Unassigned Work
              </h3>
              <div className="space-y-3">
                {unassignedWork.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
