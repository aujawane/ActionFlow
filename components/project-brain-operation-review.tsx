"use client";

import type {
  MeetingCommitment,
  MeetingTask,
  Project,
  ProjectMemory
} from "@/lib/types";
import {
  operationGroup,
  type ProjectBrainOperationGroup
} from "@/lib/project-brain/operations";
import type { ProjectChangeOperation } from "@/lib/project-brain/schemas";

const GROUP_ORDER: ProjectBrainOperationGroup[] = [
  "Project Context",
  "Commitments",
  "Tasks",
  "People",
  "Requirements and Decisions",
  "Dependencies"
];

const MEMORY_LABELS: Record<string, string> = {
  summary: "Project summary",
  goal: "Goal",
  product_description: "Product",
  target_audience: "Target audience",
  current_scope: "Current scope",
  future_scope: "Future scope",
  technical_context: "Technology",
  design_context: "Design direction",
  constraints: "Constraints",
  assumptions: "Assumptions",
  success_criteria: "Success criteria"
};

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function operationTitle(value: string) {
  if (value === "correct_project_person") return "Correct Project Person Identity";
  return titleCase(value.replaceAll("milestone", "commitment"));
}

function displayValue(value: unknown): React.ReactNode {
  if (value == null || value === "") {
    return <span className="text-slate-400">Not specified</span>;
  }
  if (Array.isArray(value)) {
    return value.length ? (
      <ul className="space-y-1">
        {value.map((item, index) => (
          <li key={`${String(item)}-${index}`}>• {String(item)}</li>
        ))}
      </ul>
    ) : (
      <span className="text-slate-400">None</span>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? (
      <div className="space-y-1">
        {entries.map(([key, item]) => (
          <div key={key}>
            <span className="font-medium">{titleCase(key)}:</span>{" "}
            {Array.isArray(item) ? item.join(", ") : String(item ?? "")}
          </div>
        ))}
      </div>
    ) : (
      <span className="text-slate-400">Not specified</span>
    );
  }
  return String(value);
}

function DiffBlock({
  label,
  current,
  proposed
}: {
  label: string;
  current: unknown;
  proposed: unknown;
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="text-xs font-semibold text-slate-800">{label}</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Current
          </p>
          <div className="mt-1 text-xs leading-5 text-slate-600">
            {displayValue(current)}
          </div>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">
            Proposed
          </p>
          <div className="mt-1 text-xs leading-5 text-slate-800">
            {displayValue(proposed)}
          </div>
        </div>
      </div>
    </div>
  );
}

type ReviewContext = {
  project: Project;
  memory: ProjectMemory | null;
  milestones: MeetingCommitment[];
  tasks: MeetingTask[];
};

function milestoneForTask(context: ReviewContext, task: MeetingTask | undefined) {
  return context.milestones.find(
    (milestone) => milestone.id === task?.commitment_id
  );
}

function operationDetails(
  operation: ProjectChangeOperation,
  context: ReviewContext
) {
  if (operation.type === "update_project_memory") {
    return (
      <div className="space-y-2">
        {Object.entries(operation.changes).map(([field, proposed]) => (
          <DiffBlock
            key={field}
            label={MEMORY_LABELS[field] ?? titleCase(field)}
            current={
              context.memory?.[field as keyof ProjectMemory] ??
              (field === "goal" ? context.project.goal : null)
            }
            proposed={proposed}
          />
        ))}
      </div>
    );
  }
  if (operation.type === "update_project") {
    return (
      <div className="space-y-2">
        {Object.entries(operation.changes).map(([field, proposed]) => (
          <DiffBlock
            key={field}
            label={titleCase(field)}
            current={context.project[field as keyof Project]}
            proposed={proposed}
          />
        ))}
      </div>
    );
  }
  if (operation.type === "create_milestone") {
    return (
      <DiffBlock
        label="Commitment"
        current={null}
        proposed={{
          title: operation.title,
          description: operation.description,
          priority: operation.priority,
          owner: operation.owner
        }}
      />
    );
  }
  if (
    operation.type === "update_milestone" ||
    operation.type === "rename_milestone"
  ) {
    const milestone = context.milestones.find(
      (item) => item.id === operation.milestoneId
    );
    const changes =
      operation.type === "rename_milestone"
        ? { title: operation.title }
        : operation.changes;
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold text-slate-900">
          {milestone?.title ?? "Commitment"}
        </p>
        {Object.entries(changes).map(([field, proposed]) => (
          <DiffBlock
            key={field}
            label={titleCase(field)}
            current={milestone?.[field as keyof MeetingCommitment]}
            proposed={proposed}
          />
        ))}
      </div>
    );
  }
  if (operation.type === "merge_milestones") {
    const sources = context.milestones.filter((milestone) =>
      operation.sourceMilestoneIds.includes(milestone.id)
    );
    const sourceIds = new Set(sources.map((milestone) => milestone.id));
    const affectedTasks = context.tasks.filter(
      (task) => task.commitment_id && sourceIds.has(task.commitment_id)
    );
    const people = Array.from(
      new Set(
        [...sources, ...affectedTasks].flatMap((item) => [
          item.owner,
          ...(Array.isArray(item.owners) ? item.owners : [])
        ]).filter((person): person is string => Boolean(person))
      )
    );
    const hasManualWork = [...sources, ...affectedTasks].some(
      (item) =>
        Array.isArray(item.manual_override_fields) &&
        item.manual_override_fields.length > 0
    );
    const completedTasks = affectedTasks.filter(
      (task) => task.status === "completed"
    ).length;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            From
          </p>
          <ul className="mt-2 space-y-1 text-xs text-slate-700">
            {sources.map((milestone) => (
              <li key={milestone.id}>• {milestone.title}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-brand-50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">
            Into
          </p>
          <p className="mt-2 text-sm font-semibold text-slate-900">
            {operation.target.title}
          </p>
        </div>
        <div className="text-xs text-slate-600">
          <span className="font-semibold">Tasks affected:</span>{" "}
          {affectedTasks.length}
        </div>
        <div className="text-xs text-slate-600">
          <span className="font-semibold">People involved:</span>{" "}
          {people.join(", ") || "Unassigned"}
        </div>
        <div className="text-xs text-slate-600">
          <span className="font-semibold">Manual edits preserved:</span> Yes
          {hasManualWork ? " · manual work detected" : ""}
        </div>
        <div className="text-xs text-slate-600">
          <span className="font-semibold">Completed work preserved:</span> Yes
          {completedTasks > 0 ? ` · ${completedTasks} completed task(s)` : ""}
        </div>
      </div>
    );
  }
  if (
    operation.type === "archive_milestone" ||
    operation.type === "defer_milestone"
  ) {
    const milestone = context.milestones.find(
      (item) => item.id === operation.milestoneId
    );
    return (
      <DiffBlock
        label={milestone?.title ?? "Commitment"}
        current={`${titleCase(milestone?.status ?? "active")} · ${
          milestone?.priority ?? "medium"
        } priority`}
        proposed="Future scope / Archived"
      />
    );
  }
  if (operation.type === "create_task") {
    const milestone = context.milestones.find(
      (item) => item.id === operation.milestoneId
    );
    return (
      <DiffBlock
        label="Task"
        current={null}
        proposed={{
          title: operation.title,
          commitment: milestone?.title ?? "Selected commitment",
          owner: operation.ownerName ?? "Unassigned",
          priority: operation.priority
        }}
      />
    );
  }
  if (operation.type === "move_task") {
    const task = context.tasks.find((item) => item.id === operation.taskId);
    const currentMilestone = milestoneForTask(context, task);
    const target = context.milestones.find(
      (item) => item.id === operation.targetMilestoneId
    );
    return (
      <DiffBlock
        label={task?.task ?? "Task"}
        current={currentMilestone?.title ?? "No commitment"}
        proposed={target?.title ?? "Selected commitment"}
      />
    );
  }
  if (operation.type === "merge_tasks") {
    const tasks = context.tasks.filter(
      (task) =>
        task.id === operation.survivorTaskId ||
        operation.mergedTaskIds.includes(task.id)
    );
    const survivor = tasks.find(
      (task) => task.id === operation.survivorTaskId
    );
    return (
      <DiffBlock
        label="Merge tasks"
        current={tasks.map((task) => task.task)}
        proposed={survivor?.task ?? "Surviving task"}
      />
    );
  }
  if (
    operation.type === "archive_task" ||
    operation.type === "update_task" ||
    operation.type === "update_task_status" ||
    operation.type === "assign_task_owner"
  ) {
    const task = context.tasks.find((item) => item.id === operation.taskId);
    const milestone = milestoneForTask(context, task);
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Task</p>
        <p className="text-sm font-semibold text-slate-950">{task?.task ?? "Task"}</p>
        {operation.type === "assign_task_owner" ? (
          <DiffBlock
            label="Owner"
            current={task?.owner ?? "Unassigned"}
            proposed={operation.ownerName ?? "Unassigned"}
          />
        ) : operation.type === "update_task" ? (
          <div className="space-y-2">
            {Object.entries(operation.changes).map(([field, proposed]) => {
              const currentField = field === "description" ? "workspace_summary" : field;
              return (
                <DiffBlock
                  key={field}
                  label={field === "task" ? "Title" : titleCase(field)}
                  current={task?.[currentField as keyof MeetingTask]}
                  proposed={proposed}
                />
              );
            })}
          </div>
        ) : (
          <DiffBlock
            label={operation.type === "update_task_status" ? "Status" : "Execution state"}
            current={titleCase(task?.status ?? "active")}
            proposed={
              operation.type === "update_task_status"
                ? titleCase(operation.status)
                : "Future scope / Archived"
            }
          />
        )}
        <p className="text-xs text-slate-500">
          <span className="font-semibold">Affected commitment:</span>{" "}
          {milestone?.title ?? "No commitment"}
        </p>
      </div>
    );
  }
  if (
    operation.type === "add_requirement" ||
    operation.type === "update_requirement"
  ) {
    return (
      <DiffBlock
        label="Requirement"
        current={
          operation.type === "update_requirement"
            ? "Existing requirement"
            : null
        }
        proposed={{
          title: operation.title,
          description: operation.description,
          category: operation.category,
          status: operation.status
        }}
      />
    );
  }
  if (
    operation.type === "add_decision" ||
    operation.type === "supersede_decision"
  ) {
    return (
      <DiffBlock
        label="Decision"
        current={
          operation.type === "supersede_decision"
            ? "Existing decision"
            : null
        }
        proposed={{
          title: operation.title,
          description: operation.description
        }}
      />
    );
  }
  if (
    operation.type === "add_constraint" ||
    operation.type === "remove_constraint"
  ) {
    return (
      <DiffBlock
        label="Constraint"
        current={
          operation.type === "remove_constraint"
            ? "Active constraint"
            : null
        }
        proposed={
          operation.type === "remove_constraint"
            ? "Removed"
            : {
                title: operation.title,
                description: operation.description,
                category: operation.category
              }
        }
      />
    );
  }
  if (operation.type === "add_project_participant") {
    return (
      <DiffBlock
        label="Project participant"
        current={null}
        proposed={{
          name: operation.participantName,
          role: operation.role
        }}
      />
    );
  }
  if (operation.type === "correct_project_person") {
    const labels: Record<(typeof operation.affectedReferences)[number]["type"], string> = {
      task: "Task assignment",
      commitment: "Commitment assignment",
      project_participant: "Project participant",
      commitment_participant: "Commitment participant"
    };
    return (
      <div className="space-y-3">
        <DiffBlock
          label="Person"
          current={operation.sourceName}
          proposed={operation.destinationName}
        />
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-800">
            Affected references: {operation.affectedReferences.length}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {operation.affectedReferences.map((reference) => (
              <li key={`${reference.type}-${reference.id}`}>
                • {labels[reference.type]} · {reference.label} ({reference.fields.map(titleCase).join(", ")})
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-500">
          Transcript text, source quotes, evidence, task IDs, and commitment IDs are unchanged.
        </p>
      </div>
    );
  }
  if (
    operation.type === "add_dependency" ||
    operation.type === "remove_dependency"
  ) {
    const task = context.tasks.find((item) => item.id === operation.taskId);
    const dependency = context.tasks.find(
      (item) => item.id === operation.dependsOnTaskId
    );
    return (
      <DiffBlock
        label={operation.type === "add_dependency" ? "Add blocker" : "Remove blocker"}
        current={
          operation.type === "add_dependency"
            ? `${task?.task ?? "Task"} has no selected blocker`
            : `${task?.task ?? "Task"} depends on ${
                dependency?.task ?? "selected task"
              }`
        }
        proposed={
          operation.type === "add_dependency"
            ? `${task?.task ?? "Task"} depends on ${
                dependency?.task ?? "selected task"
              }`
            : `${task?.task ?? "Task"} no longer depends on ${
                dependency?.task ?? "selected task"
              }`
        }
      />
    );
  }

  const record = operation as unknown as Record<string, unknown>;
  const visible = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        !["type", "explanation", "evidence", "warning"].includes(key) &&
        !key.toLowerCase().endsWith("id") &&
        !key.toLowerCase().endsWith("ids")
    )
  );
  return (
    <DiffBlock
      label={titleCase(String(record.type ?? "change"))}
      current={null}
      proposed={visible}
    />
  );
}

export function ProjectBrainOperationReview({
  operations,
  enabled,
  drafts,
  errors,
  context,
  onToggle,
  onDraftChange
}: {
  operations: ProjectChangeOperation[];
  enabled: boolean[];
  drafts: string[];
  errors: Array<string | null>;
  context: ReviewContext;
  onToggle: (index: number, enabled: boolean) => void;
  onDraftChange: (index: number, value: string) => void;
}) {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operationGroup(operation) === group)
  })).filter(({ items }) => items.length > 0);

  return (
    <div className="space-y-6">
      {groups.map(({ group, items }) => (
        <section key={group}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-950">{group}</h3>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
              {items.length}
            </span>
          </div>
          <div className="space-y-3">
            {items.map(({ operation, index }) => (
              <article
                key={`${operation.type}-${index}`}
                className="rounded-2xl border border-slate-200 p-4"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={enabled[index]}
                    onChange={(event) => onToggle(index, event.target.checked)}
                    aria-label={`Include ${operationTitle(operation.type)}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-950">
                      {operationTitle(operation.type)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      {operation.explanation}
                    </p>
                    <div className="mt-3">
                      {operationDetails(operation, context)}
                    </div>
                    {operation.evidence.length > 0 ? (
                      <div className="mt-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          Evidence
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-slate-600">
                          {operation.evidence.map((item) => (
                            <li key={`${item.type}-${item.id}`}>• {item.label}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {operation.warning ? (
                      <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {operation.warning}
                      </p>
                    ) : null}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-semibold text-slate-500">
                        Advanced technical details
                      </summary>
                      <p className="mt-2 text-xs text-slate-500">
                        Advanced: edit the underlying change directly. Changes are validated
                        before approval.
                      </p>
                      <textarea
                        className="premium-input mt-2 min-h-40 font-mono text-xs"
                        value={drafts[index]}
                        disabled={!enabled[index]}
                        onChange={(event) =>
                          onDraftChange(index, event.target.value)
                        }
                        aria-label={`Technical JSON for ${titleCase(
                          operation.type
                        )}`}
                      />
                      {errors[index] ? (
                        <p className="mt-1 text-xs text-rose-700" role="alert">
                          {errors[index]}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-emerald-700">
                          Valid operation
                        </p>
                      )}
                    </details>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
