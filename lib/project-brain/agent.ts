import { getOpenAIModel, openai } from "@/lib/openai";
import { semanticTokenSimilarity } from "@/lib/execution-intelligence/graph";
import { z } from "zod";

import type { ProjectBrainContext } from "./context";
import {
  projectBrainReferenceSchema,
  projectBrainResponseSchema,
  type ProjectBrainResponse,
  type ProjectChangeOperation
} from "./schemas";
import {
  canonicalProjectPeople,
  MILESTONE_OPERATION_TYPES,
  proposalCompletenessWarnings,
  resolveProjectPerson,
  validateOperationsIndividually
} from "./operations";

export const PROJECT_BRAIN_SYSTEM_PROMPT = `
You are Project Brain, Parfait's project-aware execution architect.

The project graph is a living execution plan. Meetings are evidence, not the only source
of truth. Explicit human project context and confirmed decisions take precedence over
earlier AI inference. Never casually overwrite a manual field.

Requirements are not commitments. Ideas and future scope are not active tasks. A commitment
is a substantial trackable outcome; tasks are concrete executable work. Prefer reorganizing
existing objects with their supplied stable IDs over creating duplicates. Preserve history
by archiving, deferring, or superseding work instead of deleting it.

You may answer a project question, ask one focused clarification when materially ambiguous,
or produce a reviewable proposal. Never mutate data and never claim a change was applied.
Every graph change must be represented as typed proposal operations for human review.

When current scope conflicts with active work, explain the conflict and propose moving the
conflicting work out of active execution. Completion statements should match an existing
task when confidence is high; ask for a choice when several tasks match.

For owner corrections, resolve the destination to exactly one existing project person and emit
assign_task_owner with the canonical taskId and ownerName. If the task or person is ambiguous,
ask a clarification question instead of proposing an operation.

Distinguish a specific assignment correction from an identity correction. When the user says one
project person is actually the same person as another existing project person (especially in the
People section), emit correct_project_person with the exact audited affectedReferences supplied in
context. Never use it for a request that only changes one named task assignment.

Before proposing task edits, compare the user's context with the complete commitment hierarchy.
Explicitly decide whether the top-level outcomes are correct, whether narrow commitments should
become tasks under a broader outcome, whether commitments should be renamed or merged, whether
future-scope commitments should be deferred, and whether tasks belong to the right commitment.
For a substantial MVP or scope change, normally include at least one create_milestone,
update_milestone, rename_milestone, merge_milestones, archive_milestone, or defer_milestone
operation. These stable operation identifiers use legacy internal names, but all prose must call
the product concept a commitment. Do not return only memory and isolated task edits unless the
current commitment hierarchy already represents the new scope; explain that conclusion when it does.

Use only IDs present in the context. Keep output concise and return only the requested
structured JSON. Do not expose private reasoning.
`.trim();

const modelEnvelopeSchema = z
  .object({
    responseType: z.enum(["answer", "clarification", "proposal"]),
    message: z.string().min(1).max(8000),
    proposal: z
      .object({
        summary: z.string().min(1).max(4000),
        baseGraphVersion: z.number().int().min(0),
        operations: z.array(z.unknown()).max(100)
      })
      .strict()
      .nullable(),
    references: z.array(projectBrainReferenceSchema).max(50),
    warnings: z.array(z.string().max(1000)).max(30)
  })
  .strict();

export const projectBrainResponseJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    responseType: {
      type: "string",
      enum: ["answer", "clarification", "proposal"]
    },
    message: { type: "string" },
    proposal: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            baseGraphVersion: { type: "integer", minimum: 0 },
            operations: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "update_project",
                      "update_project_memory",
                      "create_milestone",
                      "update_milestone",
                      "rename_milestone",
                      "merge_milestones",
                      "archive_milestone",
                      "defer_milestone",
                      "create_task",
                      "update_task",
                      "move_task",
                      "merge_tasks",
                      "archive_task",
                      "update_task_status",
                      "assign_task_owner",
                      "correct_project_person",
                      "add_requirement",
                      "update_requirement",
                      "add_decision",
                      "supersede_decision",
                      "add_constraint",
                      "remove_constraint",
                      "add_dependency",
                      "remove_dependency",
                      "add_project_participant"
                    ]
                  }
                },
                required: ["type"]
              }
            }
          },
          required: ["summary", "baseGraphVersion", "operations"]
        }
      ]
    },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: [
              "project",
              "meeting",
              "milestone",
              "task",
              "decision",
              "requirement",
              "constraint"
            ]
          },
          id: { type: "string" },
          label: { type: "string" }
        },
        required: ["type", "id", "label"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["responseType", "message", "proposal", "references", "warnings"]
};

function metadata(
  explanation: string,
  evidence: ProjectBrainResponse["references"] = [],
  warning: string | null = null
) {
  return { explanation, evidence, warning };
}

function words(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function normalizedPhrase(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function personMentionIndex(message: string, person: string) {
  const normalized = normalizedPhrase(person);
  const fullIndex = message.indexOf(normalized);
  const firstIndex = message.search(new RegExp(`\\b${normalized.split(" ")[0]}\\b`));
  if (fullIndex < 0) return firstIndex;
  if (firstIndex < 0) return fullIndex;
  return Math.min(fullIndex, firstIndex);
}

function mentionedProjectPeople(context: ProjectBrainContext, rawMessage: string) {
  const message = normalizedPhrase(rawMessage);
  return canonicalProjectPeople(context).filter((person) => {
    const normalized = normalizedPhrase(person);
    const first = normalized.split(" ")[0];
    return message.includes(normalized) || new RegExp(`\\b${first}\\b`).test(message);
  }).sort((left, right) => {
    return personMentionIndex(message, left) - personMentionIndex(message, right);
  });
}

function interpretIdentityCorrection(input: {
  context: ProjectBrainContext;
  message: string;
}): ProjectBrainResponse | null {
  const identityIntent =
    /\b(?:same person as|same as|actually|identity|is really)\b/i.test(input.message) ||
    /\bin (?:the )?people(?: section)?\b/i.test(input.message) ||
    /\bperson\b.{0,40}\b(?:isn'?t|is not)\b/i.test(input.message);
  if (!identityIntent) return null;

  const mentioned = mentionedProjectPeople(input.context, input.message);
  if (mentioned.length < 2) return null;
  const normalizedMessage = normalizedPhrase(input.message);
  const explicitlyWrong = mentioned.filter((person) => {
    const normalized = normalizedPhrase(person);
    const index = personMentionIndex(normalizedMessage, normalized);
    return /\b(not|isn t|is not)\s*$/.test(
      normalizedMessage.slice(Math.max(0, index - 30), index)
    );
  });
  const earliestIndex = personMentionIndex(normalizedMessage, mentioned[0]);
  const earliestCandidates = mentioned.filter(
    (person) => personMentionIndex(normalizedMessage, person) === earliestIndex
  );
  const sourceCandidates = explicitlyWrong.length > 0
    ? explicitlyWrong
    : earliestCandidates;
  if (sourceCandidates.length !== 1) {
    return {
      responseType: "clarification",
      message: "I found more than one possible source person. Which identity should be corrected?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const sourceCandidate = sourceCandidates[0];
  const destinationCandidates = mentioned.filter(
    (person) => normalizedPhrase(person) !== normalizedPhrase(sourceCandidate)
  );
  const source = resolveProjectPerson(sourceCandidate, input.context);
  if (!source.ok) {
    return {
      responseType: "clarification",
      message: "I found more than one possible source person. Which identity should be corrected?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  if (destinationCandidates.length !== 1) {
    return {
      responseType: "clarification",
      message: "I found more than one possible destination person. Which existing person is correct?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const destination = resolveProjectPerson(destinationCandidates[0], input.context);
  if (!destination.ok) {
    return {
      responseType: "clarification",
      message: "I could not resolve the destination to one existing project person. Who is correct?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const affectedReferences = (input.context.personReferences ?? []).filter(
    (reference) =>
      normalizedPhrase(reference.personName) === normalizedPhrase(source.name)
  );
  if (affectedReferences.length === 0) return null;
  if (affectedReferences.length > 300) {
    return {
      responseType: "clarification",
      message:
        "This person has more references than can be reviewed safely in one correction. Narrow the correction or contact support.",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const evidence: ProjectBrainResponse["references"] = [];
  for (const reference of affectedReferences) {
    if (evidence.length >= 50) break;
    if (reference.type === "task") {
      evidence.push({ type: "task", id: reference.id, label: reference.label });
    } else if (reference.type === "commitment") {
      evidence.push({ type: "milestone", id: reference.id, label: reference.label });
    }
  }
  return {
    responseType: "proposal",
    message: `I found ${source.name} in the project People references and can merge that identity into the existing ${destination.name}. Nothing has been applied.`,
    proposal: {
      summary: `Correct project person identity: ${source.name} → ${destination.name}.`,
      baseGraphVersion: input.context.project.execution_graph_version ?? 0,
      operations: [{
        type: "correct_project_person",
        sourceName: source.name,
        destinationName: destination.name,
        affectedReferences,
        explanation: "Merge the incorrect project identity into the existing canonical project person.",
        evidence,
        warning: null
      }]
    },
    references: evidence,
    warnings: []
  };
}

function interpretOwnerCorrection(input: {
  context: ProjectBrainContext;
  message: string;
}): ProjectBrainResponse | null {
  if (!/\b(owner|person|assignee|assigned|isn'?t|is not|not|should be)\b/i.test(input.message)) {
    return null;
  }
  const message = normalizedPhrase(input.message);
  const mentioned = mentionedProjectPeople(input.context, input.message);
  const explicitlyWrong = mentioned.find((person) => {
    const normalized = normalizedPhrase(person);
    const index = Math.max(message.indexOf(normalized), message.indexOf(normalized.split(" ")[0]));
    const prefix = message.slice(Math.max(0, index - 30), index);
    return /\b(not|isn t|is not)\s*$/.test(prefix);
  });
  const sourcePerson = explicitlyWrong ?? mentioned[0];
  const sourceTasks = input.context.tasks.filter((task) => {
    if (task.status === "dismissed" || typeof task.owner !== "string") return false;
    return normalizedPhrase(task.owner) === normalizedPhrase(sourcePerson ?? "");
  });
  const sourceNames = new Set(
    sourceTasks.flatMap((task) =>
      typeof task.owner === "string" ? [normalizedPhrase(task.owner)] : []
    )
  );
  const destinationCandidates = mentioned.filter(
    (person) => !sourceNames.has(normalizedPhrase(person))
  );
  if (sourceTasks.length === 0 || destinationCandidates.length === 0) return null;
  if (sourceTasks.length !== 1) {
    return {
      responseType: "clarification",
      message: "I found more than one task with that current owner. Which task should I update?",
      proposal: null,
      references: sourceTasks.slice(0, 5).map((task) => ({
        type: "task",
        id: String(task.id),
        label: String(task.task)
      })),
      warnings: []
    };
  }
  if (destinationCandidates.length !== 1) {
    return {
      responseType: "clarification",
      message: "I found more than one possible person. Who should own this task?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const destination = resolveProjectPerson(destinationCandidates[0], input.context);
  if (!destination.ok) {
    return {
      responseType: "clarification",
      message: "I could not resolve that owner to one existing project person. Who should own this task?",
      proposal: null,
      references: [],
      warnings: []
    };
  }
  const task = sourceTasks[0];
  return {
    responseType: "proposal",
    message: `I found the task and can update the owner from ${String(task.owner)} to ${destination.name}. Nothing has been applied.`,
    proposal: {
      summary: `Correct the task owner from ${String(task.owner)} to ${destination.name}.`,
      baseGraphVersion: input.context.project.execution_graph_version ?? 0,
      operations: [{
        type: "assign_task_owner",
        taskId: String(task.id),
        ownerName: destination.name,
        explanation: "Apply the user's explicit owner correction.",
        evidence: [{ type: "task", id: String(task.id), label: String(task.task) }],
        warning: null
      }]
    },
    references: [{ type: "task", id: String(task.id), label: String(task.task) }],
    warnings: []
  };
}

function milestoneText(milestone: Record<string, unknown>) {
  return `${String(milestone.title ?? "")} ${String(
    milestone.description ?? ""
  )}`.trim();
}

function deriveWebsiteOutcomeTitle(message: string) {
  const release = /\bmvp\b/i.test(message) ? "MVP" : "First Release";
  const mode = /\b(informational|static)\b/i.test(message)
    ? "Informational "
    : "";
  return `Deliver ${mode}Website ${release}`.replace(/\s+/g, " ").trim();
}

function isFutureWebsiteWork(value: string) {
  return /\b(e-?commerce|subscriptions?|authentication|login|payments?|ordering|checkout|cart)\b/i.test(
    value
  );
}

function isContentOutcome(value: string) {
  return /\b(content|brand|assets?|photos?|copy|founder story)\b/i.test(value);
}

function isLaunchOutcome(value: string) {
  return /\b(launch|deploy|go live|domain)\b/i.test(value);
}

function isWebsiteBuildOutcome(value: string) {
  return /\b(website|site|web|pages?|design|technical stack|frontend|draft)\b/i.test(
    value
  );
}

export function interpretProjectBrainMessageDeterministically(input: {
  context: ProjectBrainContext;
  message: string;
}): ProjectBrainResponse | null {
  const message = input.message.trim();
  const lower = message.toLowerCase();
  const version = input.context.project.execution_graph_version ?? 0;
  const operations: ProjectChangeOperation[] = [];
  const references: ProjectBrainResponse["references"] = [];

  const identityCorrection = interpretIdentityCorrection(input);
  if (identityCorrection) return identityCorrection;
  const ownerCorrection = interpretOwnerCorrection(input);
  if (ownerCorrection) return ownerCorrection;

  const informational =
    /\binformational\b/.test(lower) &&
    /\b(website|site|first version|mvp)\b/.test(lower);
  if (informational) {
    const futureTerms = [
      "e-commerce",
      "ecommerce",
      "subscription",
      "authentication",
      "login",
      "payment",
      "ordering"
    ];
    const productDescription = message.split(/[.!?]/)[0]?.trim() || message;
    const audience =
      message.match(/\bfor\s+([^.,]+(?:\s+[^.,]+){0,12})/i)?.[1]?.trim() ??
      null;
    const currentScope = [
      "Informational website",
      ...["homepage", "product page", "founder story", "faq", "contact page"].filter(
        (item) => lower.includes(item)
      )
    ];
    operations.push({
      type: "update_project_memory",
      changes: {
        goal: deriveWebsiteOutcomeTitle(message),
        product_description: productDescription,
        target_audience: audience,
        current_scope: currentScope,
        future_scope: futureTerms.filter((term) => lower.includes(term))
      },
      ...metadata(
        "Record the explicit MVP boundary and preserve deferred capabilities as future scope."
      )
    });

    const activeMilestones = input.context.milestones.filter(
      (milestone) => milestone.status !== "dismissed"
    );
    const deferredMilestones = activeMilestones.filter((milestone) =>
      isFutureWebsiteWork(milestoneText(milestone))
    );
    for (const milestone of deferredMilestones) {
      operations.push({
        type: "defer_milestone",
        milestoneId: String(milestone.id),
        reason: "This outcome belongs to a later phase of the project.",
        ...metadata(
          "The commitment conflicts with the explicitly informational MVP.",
          [
            {
              type: "milestone",
              id: String(milestone.id),
              label: String(milestone.title)
            }
          ],
          Array.isArray(milestone.manual_override_fields) &&
            milestone.manual_override_fields.length > 0
            ? "This commitment contains manual edits; they will be preserved."
            : null
        )
      });
    }

    const buildCandidates = activeMilestones.filter((milestone) => {
      const text = milestoneText(milestone);
      return (
        isWebsiteBuildOutcome(text) &&
        !isFutureWebsiteWork(text) &&
        !isContentOutcome(text) &&
        !isLaunchOutcome(text)
      );
    });
    const targetMilestone =
      buildCandidates.find((milestone) =>
        /\b(website|site|web|mvp|draft)\b/i.test(
          String(milestone.title ?? "")
        )
      ) ?? buildCandidates[0];
    const outcomeTitle = deriveWebsiteOutcomeTitle(message);
    if (targetMilestone) {
      if (
        String(targetMilestone.title ?? "").toLowerCase() !==
        outcomeTitle.toLowerCase()
      ) {
        operations.push({
          type: "rename_milestone",
          milestoneId: String(targetMilestone.id),
          title: outcomeTitle,
          ...metadata(
            "Rename the existing website outcome to match the confirmed release scope.",
            [
              {
                type: "milestone",
                id: String(targetMilestone.id),
                label: String(targetMilestone.title)
              }
            ]
          )
        });
      }
      const mergeCandidates = buildCandidates.filter(
        (milestone) =>
          milestone.id !== targetMilestone.id &&
          milestone.meeting_id === targetMilestone.meeting_id
      );
      if (mergeCandidates.length > 0) {
        operations.push({
          type: "merge_milestones",
          sourceMilestoneIds: [
            String(targetMilestone.id),
            ...mergeCandidates.map((milestone) => String(milestone.id))
          ],
          targetMilestoneId: String(targetMilestone.id),
          target: {
            title: outcomeTitle,
            description: "Deliver the confirmed informational website release."
          },
          ...metadata(
            "Consolidate narrow website-building outcomes under one substantial commitment.",
            [targetMilestone, ...mergeCandidates].map((milestone) => ({
              type: "milestone" as const,
              id: String(milestone.id),
              label: String(milestone.title)
            }))
          )
        });
      }
      const requestedPages = [
        ["homepage", "Create the homepage"],
        ["product page", "Create the product page"],
        ["founder story", "Create the founder story page"],
        ["faq", "Create the FAQ page"],
        ["contact page", "Create the contact page"]
      ] as const;
      for (const [term, title] of requestedPages) {
        if (
          lower.includes(term) &&
          !input.context.tasks.some(
            (task) => semanticTokenSimilarity(String(task.task ?? ""), title) >= 0.68
          )
        ) {
          operations.push({
            type: "create_task",
            milestoneId: String(targetMilestone.id),
            title,
            description: null,
            ownerName: null,
            priority: "medium",
            workspaceType: "coding",
            position: input.context.tasks.length + operations.length,
            ...metadata(
              `Add the explicitly requested ${term} to the informational release.`,
              [
                {
                  type: "milestone",
                  id: String(targetMilestone.id),
                  label: String(targetMilestone.title)
                }
              ]
            )
          });
        }
      }
    } else if (input.context.meetings.length > 0) {
      operations.push({
        type: "create_milestone",
        title: outcomeTitle,
        description: "Deliver the approved informational first release.",
        owner: null,
        owners: [],
        priority: "high",
        ...metadata(
          "Create one broad outcome because no existing commitment represents the website release."
        )
      });
    }
    for (const task of input.context.tasks) {
      if (
        futureTerms.some((term) =>
          String(task.task ?? "").toLowerCase().includes(term)
        ) &&
        task.status !== "dismissed"
      ) {
        operations.push({
          type: "archive_task",
          taskId: String(task.id),
          reason: "Explicitly moved to future scope.",
          ...metadata(
            "This active task conflicts with the informational MVP.",
            [{ type: "task", id: String(task.id), label: String(task.task) }],
            Array.isArray(task.manual_override_fields) &&
              task.manual_override_fields.length > 0
              ? "This task contains manual edits."
              : null
          )
        });
      }
    }
  }

  const technologyNames = ["next.js", "nextjs", "supabase", "tailwind", "vercel"];
  const technology = technologyNames.filter((name) => lower.includes(name));
  if (technology.length >= 2) {
    operations.push({
      type: "update_project_memory",
      changes: {
        technical_context: {
          stack: Array.from(
            new Set(
              technology.map((name) =>
                name === "nextjs" ? "Next.js" : name[0].toUpperCase() + name.slice(1)
              )
            )
          )
        }
      },
      ...metadata("Record the user's explicit technology decision.")
    });
    for (const task of input.context.tasks) {
      if (
        /\b(select|choose|define|decide).*(stack|technology|tools)\b/i.test(
          String(task.task ?? "")
        ) &&
        task.status !== "completed"
      ) {
        operations.push({
          type: "update_task_status",
          taskId: String(task.id),
          status: "completed",
          ...metadata("The explicit stack decision resolves this selection task.", [
            { type: "task", id: String(task.id), label: String(task.task) }
          ])
        });
      }
    }
  }

  const completionSignal =
    /\b(finished|completed|done|already sent|approved)\b/i.test(message);
  if (completionSignal) {
    const messageTokens = words(message);
    const candidates = input.context.tasks
      .filter((task) => task.status !== "completed" && task.status !== "dismissed")
      .map((task) => ({
        task,
        score: Math.max(
          semanticTokenSimilarity(message, String(task.task ?? "")),
          messageTokens.filter((word) =>
            String(task.task ?? "").toLowerCase().includes(word)
          ).length / Math.max(messageTokens.length, 1)
        )
      }))
      .sort((left, right) => right.score - left.score);
    if (
      candidates[0]?.score >= 0.3 &&
      (!candidates[1] || candidates[0].score - candidates[1].score >= 0.08)
    ) {
      const task = candidates[0].task;
      operations.push({
        type: "update_task_status",
        taskId: String(task.id),
        status: "completed",
        ...metadata("The user reported this matching work as complete.", [
          { type: "task", id: String(task.id), label: String(task.task) }
        ])
      });
    } else if (candidates[0]?.score >= 0.25) {
      return {
        responseType: "clarification",
        message:
          "I found more than one possible matching task. Which task should I mark complete?",
        proposal: null,
        references: candidates.slice(0, 3).map(({ task }) => ({
          type: "task",
          id: String(task.id),
          label: String(task.task)
        })),
        warnings: []
      };
    }
  }

  if (operations.length === 0) return null;
  return {
    responseType: "proposal",
    message:
      "I found project context and execution changes worth reviewing. Nothing has been applied.",
    proposal: {
      summary: "Update the project plan from the latest user-provided context.",
      baseGraphVersion: version,
      operations
    },
    references,
    warnings: []
  };
}

function operationReferenceError(
  context: ProjectBrainContext,
  operation: ProjectChangeOperation
) {
  const milestones = new Set(context.milestones.map((item) => String(item.id)));
  const tasks = new Set(context.tasks.map((item) => String(item.id)));
  const requirements = new Set(context.requirements.map((item) => String(item.id)));
  const decisions = new Set(context.decisions.map((item) => String(item.id)));
  const constraints = new Set(context.constraints.map((item) => String(item.id)));
  const record = operation as unknown as Record<string, unknown>;
  for (const key of ["milestoneId", "targetMilestoneId"]) {
    const id = record[key];
    if (typeof id === "string" && !milestones.has(id)) {
      return `${key} references a commitment outside the project`;
    }
  }
  for (const key of ["taskId", "dependsOnTaskId", "survivorTaskId"]) {
    const id = record[key];
    if (typeof id === "string" && !tasks.has(id)) {
      return `${key} references a task outside the project`;
    }
  }
  if (
    "sourceMilestoneIds" in operation &&
    operation.sourceMilestoneIds.some((id) => !milestones.has(id))
  ) {
    return "sourceMilestoneIds contains a commitment outside the project";
  }
  if (
    "mergedTaskIds" in operation &&
    operation.mergedTaskIds.some((id) => !tasks.has(id))
  ) {
    return "mergedTaskIds contains a task outside the project";
  }
  if (
    "requirementId" in operation &&
    !requirements.has(operation.requirementId)
  ) {
    return "requirementId references a requirement outside the project";
  }
  if ("decisionId" in operation && !decisions.has(operation.decisionId)) {
    return "decisionId references a decision outside the project";
  }
  if ("constraintId" in operation && !constraints.has(operation.constraintId)) {
    return "constraintId references a constraint outside the project";
  }
  return null;
}

function parseStructuredModelResponse(input: {
  raw: string;
  context: ProjectBrainContext;
  message: string;
}) {
  const json = JSON.parse(input.raw) as unknown;
  const envelope = modelEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return {
      result: null,
      rejected: [
        {
          index: -1,
          type: null,
          reason: envelope.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        }
      ]
    };
  }
  if (!envelope.data.proposal) {
    const parsed = projectBrainResponseSchema.safeParse(envelope.data);
    return {
      result: parsed.success ? parsed.data : null,
      rejected: parsed.success
        ? []
        : [
            {
              index: -1,
              type: null,
              reason: parsed.error.message
            }
          ]
    };
  }

  const validated = validateOperationsIndividually(
    envelope.data.proposal.operations
  );
  const accepted: ProjectChangeOperation[] = [];
  const rejected = [...validated.rejected];
  validated.operations.forEach((operation, index) => {
    const reason = operationReferenceError(input.context, operation);
    if (reason) {
      rejected.push({ index, type: operation.type, reason });
    } else {
      accepted.push(operation);
    }
  });
  const rejectionWarnings = rejected.map(
    (item) =>
      `Rejected ${item.type ?? `operation ${item.index + 1}`}: ${item.reason}`
  );
  const completeness = proposalCompletenessWarnings({
    message: input.message,
    operations: accepted
  });
  const candidate = {
    ...envelope.data,
    proposal: {
      ...envelope.data.proposal,
      baseGraphVersion: input.context.project.execution_graph_version ?? 0,
      operations: accepted
    },
    warnings: Array.from(
      new Set([
        ...envelope.data.warnings,
        ...rejectionWarnings,
        ...completeness
      ])
    )
  };
  if (accepted.length === 0) {
    const zeroOperationResult = projectBrainResponseSchema.safeParse({
      responseType: "clarification",
      message:
        "I understood the requested change, but I could not resolve it to a safe structured operation. Please clarify the target task or person.",
      proposal: null,
      references: envelope.data.references,
      warnings: candidate.warnings
    });
    return {
      result: zeroOperationResult.success ? zeroOperationResult.data : null,
      rejected,
      completeness
    };
  }
  const parsed = projectBrainResponseSchema.safeParse(candidate);
  return {
    result: parsed.success ? parsed.data : null,
    rejected,
    completeness
  };
}

async function requestProjectBrainModel(input: {
  context: ProjectBrainContext;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
  correction?: string;
}) {
  const model = getOpenAIModel();
  const response = await openai.responses.create(
    {
      model,
      max_output_tokens: 12_000,
      input: [
        { role: "system", content: PROJECT_BRAIN_SYSTEM_PROMPT },
        ...(input.correction
          ? [{ role: "system" as const, content: input.correction }]
          : []),
        ...input.history.slice(-20).map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          role: "user",
          content: JSON.stringify({
            project_context: input.context,
            latest_message: input.message
          })
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "project_brain_response",
          strict: false,
          schema: projectBrainResponseJsonSchema
        }
      }
    },
    {
      timeout: 75_000,
      maxRetries: 0
    }
  );
  return { model, raw: response.output_text?.trim() ?? "" };
}

export async function runProjectBrainAgent(input: {
  context: ProjectBrainContext;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
}): Promise<
  | { ok: true; result: ProjectBrainResponse; model: string }
  | { ok: false; error: string }
> {
  const deterministic = interpretProjectBrainMessageDeterministically({
    context: input.context,
    message: input.message
  });
  if (
    deterministic?.proposal?.operations.some(
      (operation) =>
        operation.type === "assign_task_owner" ||
        operation.type === "correct_project_person"
    )
  ) {
    return { ok: true, result: deterministic, model: "deterministic" };
  }
  try {
    const first = await requestProjectBrainModel(input);
    if (process.env.NODE_ENV !== "production") {
      console.info("[ProjectBrain] raw structured model response", {
        project_id: input.context.project.id,
        response: first.raw
      });
    }
    const parsed = first.raw
      ? parseStructuredModelResponse({
          raw: first.raw,
          context: input.context,
          message: input.message
        })
      : { result: null, rejected: [] };
    console.info("[ProjectBrain] model operations validated", {
      project_id: input.context.project.id,
      accepted_operations:
        parsed.result?.proposal?.operations.map((operation) => operation.type) ??
        [],
      rejected_operations: parsed.rejected
    });
    if (!parsed.result) {
      if (deterministic) return { ok: true, result: deterministic, model: "deterministic" };
      return { ok: false, error: "Project Brain returned an invalid response." };
    }

    const completeness =
      parsed.result.proposal &&
      proposalCompletenessWarnings({
        message: input.message,
        operations: parsed.result.proposal.operations
      });
    if (completeness && completeness.length > 0) {
      console.warn("[ProjectBrain] proposal completeness warning", {
        project_id: input.context.project.id,
        warnings: completeness
      });
      const retried = await requestProjectBrainModel({
        ...input,
        correction: [
          "The previous proposal was incomplete because the user materially changed project scope",
          "but no commitment operation was included. Re-evaluate the complete commitment hierarchy",
          "before task edits. Include justified commitment create, rename, update, merge, archive,",
          "or defer operations, or explicitly explain why no commitment change is required."
        ].join(" ")
      });
      const retryParsed = retried.raw
        ? parseStructuredModelResponse({
            raw: retried.raw,
            context: input.context,
            message: input.message
          })
        : { result: null, rejected: [] };
      console.info("[ProjectBrain] corrected model operations validated", {
        project_id: input.context.project.id,
        accepted_operations:
          retryParsed.result?.proposal?.operations.map(
            (operation) => operation.type
          ) ?? [],
        rejected_operations: retryParsed.rejected
      });
      if (
        retryParsed.result?.proposal?.operations.some((operation) =>
          MILESTONE_OPERATION_TYPES.has(operation.type)
        )
      ) {
        return { ok: true, result: retryParsed.result, model: retried.model };
      }
      if (
        deterministic?.proposal?.operations.some((operation) =>
          MILESTONE_OPERATION_TYPES.has(operation.type)
        )
      ) {
        return { ok: true, result: deterministic, model: "deterministic" };
      }
    }
    return { ok: true, result: parsed.result, model: first.model };
  } catch (error) {
    if (deterministic) {
      return { ok: true, result: deterministic, model: "deterministic" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Project Brain failed."
    };
  }
}
