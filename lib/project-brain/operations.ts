import {
  projectChangeOperationSchema,
  type ProjectChangeOperation,
  type ProjectPersonReference
} from "./schemas";

export const MILESTONE_OPERATION_TYPES = new Set<ProjectChangeOperation["type"]>([
  "create_milestone",
  "update_milestone",
  "rename_milestone",
  "merge_milestones",
  "archive_milestone",
  "defer_milestone"
]);

export type ProjectBrainOperationGroup =
  | "Project Context"
  | "Commitments"
  | "Tasks"
  | "People"
  | "Requirements and Decisions"
  | "Dependencies";

export function operationGroup(
  operation: ProjectChangeOperation
): ProjectBrainOperationGroup {
  if (
    operation.type === "update_project" ||
    operation.type === "update_project_memory"
  ) {
    return "Project Context";
  }
  if (MILESTONE_OPERATION_TYPES.has(operation.type)) return "Commitments";
  if (
    operation.type === "create_task" ||
    operation.type === "update_task" ||
    operation.type === "move_task" ||
    operation.type === "merge_tasks" ||
    operation.type === "archive_task" ||
    operation.type === "update_task_status" ||
    operation.type === "assign_task_owner"
  ) {
    return "Tasks";
  }
  if (
    operation.type === "add_project_participant" ||
    operation.type === "correct_project_person"
  ) return "People";
  if (
    operation.type === "add_requirement" ||
    operation.type === "update_requirement" ||
    operation.type === "add_decision" ||
    operation.type === "supersede_decision" ||
    operation.type === "add_constraint" ||
    operation.type === "remove_constraint"
  ) {
    return "Requirements and Decisions";
  }
  return "Dependencies";
}

export function requiresMilestonePlanning(message: string) {
  return /\b(reorganize|restructure|consolidate|merge|rename)\b.{0,40}\b(milestones?|project|plan)\b|\b(change|clarify|update|reduce|expand)\b.{0,40}\b(mvp|scope|phase|release)\b|\b(informational|static)\b.{0,30}\b(website|site|mvp)\b|\b(move|defer|later|future)\b.{0,40}\b(feature|scope|phase|e-?commerce|authentication|payments?|subscriptions?|ordering)\b/i.test(
    message
  );
}

export function proposalCompletenessWarnings(input: {
  message: string;
  operations: ProjectChangeOperation[];
}) {
  if (
    requiresMilestonePlanning(input.message) &&
    !input.operations.some((operation) =>
      MILESTONE_OPERATION_TYPES.has(operation.type)
    )
  ) {
    return [
      "Scope changed substantially, but no commitment operations were generated."
    ];
  }
  return [];
}

export function normalizeOperationsForApply(
  operations: ProjectChangeOperation[]
): ProjectChangeOperation[] {
  return operations.map((operation) => {
    if (operation.type === "rename_milestone") {
      return {
        type: "update_milestone",
        milestoneId: operation.milestoneId,
        changes: { title: operation.title },
        explanation: operation.explanation,
        evidence: operation.evidence,
        warning: operation.warning
      };
    }
    if (operation.type === "defer_milestone") {
      return {
        type: "archive_milestone",
        milestoneId: operation.milestoneId,
        reason: operation.reason,
        explanation: operation.explanation,
        evidence: operation.evidence,
        warning: operation.warning
      };
    }
    return operation;
  });
}

export type ProposalTargetValidation =
  | { ok: true }
  | { ok: false; reason: "stale_execution_target" | "outside_project"; message: string };

/**
 * Every operation that targets an existing milestone/task must reference a row that is actually
 * in the caller's current-generation context (ProjectBrainContext.milestones/tasks -- see
 * lib/project-brain/context.ts). A target id missing from that context is either (a) a row that
 * belongs to a superseded analysis generation -- context.ts excludes it deliberately and tracks it
 * in staleMilestoneIds/staleTaskIds precisely so this check can name it -- or (b) genuinely outside
 * the project. Never silently retarget a stale proposal to a different row; reject with a
 * diagnostic the caller can act on instead.
 */
export function validateProposalTargets(
  operations: unknown[],
  context: {
    milestones: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    staleMilestoneIds: Set<string>;
    staleTaskIds: Set<string>;
  }
): ProposalTargetValidation {
  const milestoneIds = new Set(context.milestones.map((item) => String(item.id)));
  const taskIds = new Set(context.tasks.map((item) => String(item.id)));
  for (const operation of operations) {
    const candidate = operation as Record<string, unknown>;
    for (const key of ["milestoneId", "targetMilestoneId"]) {
      const value = candidate[key];
      if (typeof value !== "string" || milestoneIds.has(value)) continue;
      if (context.staleMilestoneIds.has(value)) {
        return {
          ok: false,
          reason: "stale_execution_target",
          message: "This proposal references a commitment from a superseded analysis generation."
        };
      }
      return {
        ok: false,
        reason: "outside_project",
        message: "Proposal references a commitment outside this project."
      };
    }
    for (const key of ["taskId", "dependsOnTaskId", "survivorTaskId"]) {
      const value = candidate[key];
      if (typeof value !== "string" || taskIds.has(value)) continue;
      if (context.staleTaskIds.has(value)) {
        return {
          ok: false,
          reason: "stale_execution_target",
          message: "This proposal references a task from a superseded analysis generation."
        };
      }
      return {
        ok: false,
        reason: "outside_project",
        message: "Proposal references a task outside this project."
      };
    }
  }
  return { ok: true };
}

export function validateOperationsIndividually(values: unknown[]) {
  const operations: ProjectChangeOperation[] = [];
  const rejected: Array<{ index: number; type: string | null; reason: string }> =
    [];
  values.forEach((value, index) => {
    const parsed = projectChangeOperationSchema.safeParse(value);
    if (parsed.success) {
      operations.push(parsed.data);
      return;
    }
    const type =
      value && typeof value === "object" && !Array.isArray(value)
        ? String((value as { type?: unknown }).type ?? "") || null
        : null;
    rejected.push({
      index,
      type,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
    });
  });
  return { operations, rejected };
}

type PersonResolutionContext = {
  participants: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  personReferences?: ProjectPersonReference[];
};

function normalizedPersonName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Returns the project-scoped owner identities Brain may safely assign. Combined extraction
 * labels are ignored when their individual identities already exist; this avoids choosing a
 * raw "A and B" speaker label without redesigning the upstream identity model. */
export function canonicalProjectPeople(context: PersonResolutionContext) {
  const people = new Map<string, string>();
  for (const participant of context.participants) {
    const value = participant.participant_name;
    if (typeof value === "string" && value.trim()) {
      people.set(normalizedPersonName(value), value.trim());
    }
  }
  for (const item of [...context.milestones, ...context.tasks]) {
    for (const value of [
      item.owner,
      ...(Array.isArray(item.owners) ? item.owners : [])
    ]) {
      if (typeof value === "string" && value.trim()) {
        people.set(normalizedPersonName(value), value.trim());
      }
    }
  }
  for (const reference of context.personReferences ?? []) {
    if (reference.personName.trim()) {
      people.set(
        normalizedPersonName(reference.personName),
        reference.personName.trim()
      );
    }
  }
  return Array.from(people.entries())
    .filter(([key]) => {
      const parts = key.split(/\s+and\s+/);
      const individualKeys = Array.from(people.keys()).filter(
        (candidate) => candidate !== key && !candidate.includes(" and ")
      );
      return (
        parts.length === 1 ||
        !parts.every((part) =>
          individualKeys.some(
            (candidate) => candidate === part || candidate.startsWith(`${part} `)
          )
        )
      );
    })
    .map(([, value]) => value);
}

function matchingPersonFields(
  value: Record<string, unknown>,
  fields: ProjectPersonReference["fields"],
  name: string
) {
  const normalized = normalizedPersonName(name);
  return fields.filter((field) => {
    const candidate = value[field];
    return Array.isArray(candidate)
      ? candidate.some(
          (item) => typeof item === "string" && normalizedPersonName(item) === normalized
        )
      : typeof candidate === "string" && normalizedPersonName(candidate) === normalized;
  });
}

export function collectProjectPersonReferences(input: {
  tasks: Array<Record<string, unknown>>;
  commitments: Array<Record<string, unknown>>;
  projectParticipants?: Array<Record<string, unknown>>;
  commitmentParticipants?: Array<Record<string, unknown>>;
}) {
  const references: ProjectPersonReference[] = [];
  for (const task of input.tasks) {
    for (const name of [task.owner, ...(Array.isArray(task.owners) ? task.owners : [])]) {
      if (typeof name !== "string" || !name.trim()) continue;
      const fields = matchingPersonFields(task, ["owner", "owners"], name);
      if (
        references.some(
          (reference) => reference.type === "task" && reference.id === String(task.id) &&
            normalizedPersonName(reference.personName) === normalizedPersonName(name)
        )
      ) continue;
      references.push({
        type: "task",
        id: String(task.id),
        label: String(task.task ?? "Task"),
        personName: name.trim(),
        fields,
      });
    }
  }
  for (const commitment of input.commitments) {
    for (const name of [
      commitment.owner,
      ...(Array.isArray(commitment.owners) ? commitment.owners : []),
      commitment.lead_owner_name
    ]) {
      if (typeof name !== "string" || !name.trim()) continue;
      const fields = matchingPersonFields(
        commitment,
        ["owner", "owners", "lead_owner_name"],
        name
      );
      if (
        references.some(
          (reference) => reference.type === "commitment" &&
            reference.id === String(commitment.id) &&
            normalizedPersonName(reference.personName) === normalizedPersonName(name)
        )
      ) continue;
      references.push({
        type: "commitment",
        id: String(commitment.id),
        label: String(commitment.title ?? "Commitment"),
        personName: name.trim(),
        fields,
      });
    }
  }
  const namedRows = [
    ["project_participant", input.projectParticipants ?? [], "participant_name"],
    ["commitment_participant", input.commitmentParticipants ?? [], "participant_name"]
  ] as const;
  for (const [type, rows, field] of namedRows) {
    for (const row of rows) {
      const name = row[field];
      if (typeof name !== "string" || !name.trim()) continue;
      references.push({
        type,
        id: String(row.id),
        label: String(row.label ?? name),
        personName: name.trim(),
        fields: [field],
      });
    }
  }
  return references;
}

function referenceKey(reference: ProjectPersonReference) {
  return `${reference.type}:${reference.id}:${[...reference.fields].sort().join(",")}`;
}

export function validateAndCanonicalizePersonCorrection(
  operation: Extract<ProjectChangeOperation, { type: "correct_project_person" }>,
  context: PersonResolutionContext
):
  | { ok: true; operation: Extract<ProjectChangeOperation, { type: "correct_project_person" }> }
  | { ok: false; message: string } {
  const source = resolveProjectPerson(operation.sourceName, context);
  if (!source.ok) {
    return {
      ok: false,
      message: source.reason === "ambiguous"
        ? `Source person \"${operation.sourceName}\" is ambiguous.`
        : `Source person \"${operation.sourceName}\" was not found in this project.`
    };
  }
  const destination = resolveProjectPerson(operation.destinationName, context);
  if (!destination.ok) {
    return {
      ok: false,
      message: destination.reason === "ambiguous"
        ? `Destination person \"${operation.destinationName}\" is ambiguous.`
        : `Destination person \"${operation.destinationName}\" was not found in this project.`
    };
  }
  if (normalizedPersonName(source.name) === normalizedPersonName(destination.name)) {
    return { ok: false, message: "Source and destination already resolve to the same person." };
  }
  const audited = (context.personReferences ?? []).filter(
    (reference) =>
      normalizedPersonName(reference.personName) === normalizedPersonName(source.name)
  );
  const expectedKeys = audited.map(referenceKey).sort();
  const submittedKeys = operation.affectedReferences.map(referenceKey).sort();
  if (
    expectedKeys.length === 0 ||
    expectedKeys.length !== submittedKeys.length ||
    expectedKeys.some((key, index) => key !== submittedKeys[index])
  ) {
    return {
      ok: false,
      message: "The affected person references changed. Generate a fresh proposal."
    };
  }
  return {
    ok: true,
    operation: {
      ...operation,
      sourceName: source.name,
      destinationName: destination.name,
      affectedReferences: audited.map(({ type, id, label, personName, fields }) => ({
        type, id, label, personName, fields
      }))
    }
  };
}

export type ProjectPersonResolution =
  | { ok: true; name: string }
  | { ok: false; reason: "not_found" | "ambiguous"; matches: string[] };

export function resolveProjectPerson(
  requestedName: string,
  context: PersonResolutionContext
): ProjectPersonResolution {
  const requested = normalizedPersonName(requestedName);
  const people = canonicalProjectPeople(context);
  const exact = people.filter(
    (person) => normalizedPersonName(person) === requested
  );
  if (exact.length === 1) return { ok: true, name: exact[0] };

  const matches = people.filter((person) => {
    const candidate = normalizedPersonName(person);
    return (
      candidate.startsWith(`${requested} `) ||
      requested.startsWith(`${candidate} `) ||
      candidate.split(" ")[0] === requested
    );
  });
  if (matches.length === 1) return { ok: true, name: matches[0] };
  return {
    ok: false,
    reason: matches.length > 1 ? "ambiguous" : "not_found",
    matches
  };
}

/** Canonicalizes every requested owner against accessible project people. The apply route uses
 * this even for already-reviewed payloads so a client cannot introduce a new string identity. */
export function validateAndCanonicalizeOperationOwners(
  operations: ProjectChangeOperation[],
  context: PersonResolutionContext
):
  | { ok: true; operations: ProjectChangeOperation[] }
  | { ok: false; message: string } {
  const canonicalized: ProjectChangeOperation[] = [];
  for (const operation of operations) {
    let requested: string | null | undefined;
    if (operation.type === "assign_task_owner") requested = operation.ownerName;
    if (operation.type === "update_task" && "owner" in operation.changes) {
      requested = operation.changes.owner;
    }
    if (requested === undefined || requested === null) {
      canonicalized.push(operation);
      continue;
    }
    const resolution = resolveProjectPerson(requested, context);
    if (!resolution.ok) {
      return {
        ok: false,
        message:
          resolution.reason === "ambiguous"
            ? `Owner \"${requested}\" matches more than one project person.`
            : `Owner \"${requested}\" is not an existing person in this project.`
      };
    }
    if (operation.type === "assign_task_owner") {
      canonicalized.push({ ...operation, ownerName: resolution.name });
    } else if (operation.type === "update_task") {
      canonicalized.push({
        ...operation,
        changes: { ...operation.changes, owner: resolution.name }
      });
    } else {
      canonicalized.push(operation);
    }
  }
  return { ok: true, operations: canonicalized };
}
