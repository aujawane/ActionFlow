import { z } from "zod";

import { isCommittedWork } from "@/lib/execution-display";
import { isTaskCurrentGeneration } from "@/lib/execution-generation";
import { getOpenAIModel, openai } from "@/lib/openai";
import { getSuggestedSteps } from "@/lib/task-workspace";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingCommitment, MeetingTask, TaskDependency } from "@/lib/types";

/** AI dependency inference is enrichment on top of the already-persisted, canonical current
 * commitment/task graph (see Execution Intelligence V4) -- it never touches extraction, owner
 * resolution, task consolidation, or Future Scope classification. This module only decides which
 * `task_dependencies` edges to propose and validates them before anything is written. */

// ============================================================
// Confidence policy
// ============================================================

/** Conservative on purpose: a missed dependency (false negative) just means the user still has
 * the manual selector; a wrongly-applied one (false positive) actively blocks real work. Only
 * near-certain, evidence-grounded relationships clear this bar. */
export const DEPENDENCY_CONFIDENCE_THRESHOLD = 0.85;

// ============================================================
// Structured output schema (OpenAI Responses API json_schema convention -- see
// lib/task-categorization.ts for the established pattern this mirrors).
// ============================================================

export type DependencyRelationship = "hard_dependency" | "ordering_preference" | "independent";

const dependencyCandidateSchema = z
  .object({
    task_id: z.string(),
    depends_on_task_id: z.string(),
    relationship: z.enum(["hard_dependency", "ordering_preference", "independent"]),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    evidence: z.string()
  })
  .strict();

export type DependencyCandidate = z.infer<typeof dependencyCandidateSchema>;

export const dependencyInferenceResultSchema = z
  .object({
    dependencies: z.array(dependencyCandidateSchema)
  })
  .strict();

const dependencyInferenceJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          depends_on_task_id: { type: "string" },
          relationship: {
            type: "string",
            enum: ["hard_dependency", "ordering_preference", "independent"]
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          evidence: { type: "string" }
        },
        required: [
          "task_id",
          "depends_on_task_id",
          "relationship",
          "confidence",
          "reason",
          "evidence"
        ]
      }
    }
  },
  required: ["dependencies"]
};

const SYSTEM_PROMPT = [
  "You infer TRUE EXECUTION BLOCKING DEPENDENCIES between tasks that belong to the same",
  "commitment, for a productivity app called Parfait.",
  "",
  "Definition: task B depends on task A only if B cannot reasonably be started or completed",
  "until A is done -- a genuine blocking prerequisite, not a scheduling preference.",
  "Ask yourself: \"Can task B reasonably be executed before task A is completed?\" If yes, even",
  "if A would normally happen first, this is NOT a dependency -- omit it.",
  "",
  "Rules:",
  "- Only report relationship \"hard_dependency\" in the output array. Never include",
  "  \"ordering_preference\" or \"independent\" pairs -- omit them entirely rather than listing them.",
  "- A task's owner does not, by itself, create or rule out a dependency. Same-owner tasks are",
  "  not automatically dependent; different-owner tasks are not automatically independent.",
  "- A task's due date does not, by itself, create a dependency. An earlier due date is not a",
  "  prerequisite.",
  "- Ground every dependency in the task titles/descriptions/evidence provided. You do not need",
  "  an exact quote if the semantic task structure itself makes the relationship unambiguous",
  "  (e.g. \"create the account\" before \"build the website using that account\"), but it must be",
  "  logically supported, not just superficially plausible.",
  "- If you are not confident a task is a genuine blocker, omit it. False negatives (a missed",
  "  dependency) are far better than false positives (an invented blocker) -- the user can always",
  "  add a dependency manually, but a wrong one actively blocks real work.",
  "- confidence must be your calibrated genuine certainty this is a real blocking relationship.",
  "  Only use 0.85 or higher when you are near-certain.",
  "- task_id and depends_on_task_id must be exactly one of the candidate task ids provided below.",
  "  Never invent an id, and never reference a task outside the provided candidates.",
  "- Never report a task depending on itself.",
  "- Never report the same (task_id, depends_on_task_id) pair more than once.",
  "- A task should normally have at most one direct dependency; if several tasks are all",
  "  legitimate prerequisites, report only the single most direct/immediate blocker.",
  "",
  "Return only the JSON object described by the schema. If no genuine dependencies exist,",
  "return an empty dependencies array -- that is a normal, expected result."
].join("\n");

// ============================================================
// Input context
// ============================================================

type AcceptanceCriterion = { ref?: string; title: string };

/** V4 stores acceptance criteria in commitment.metadata (see execution-graph-v4.ts and
 * components/commitments-panel.tsx's identical extraction); other engines simply have none. */
function extractAcceptanceCriteria(commitment: MeetingCommitment): AcceptanceCriterion[] {
  const metadata = commitment.metadata as { acceptance_criteria?: unknown } | null;
  const raw = metadata?.acceptance_criteria;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is AcceptanceCriterion =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { title?: unknown }).title === "string"
  );
}

export function buildDependencyInferenceContext(input: {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  meetingContextByTopicId?: Map<string, string>;
}) {
  const topicIds = new Set(
    input.tasks.map((task) => task.topic_id).filter((id): id is string => Boolean(id))
  );
  const meetingContext = Array.from(topicIds)
    .map((topicId) => input.meetingContextByTopicId?.get(topicId))
    .filter((context): context is string => Boolean(context && context.trim()))
    // Targeted topic excerpts only -- never the full transcript. Deduplicated per topic so a
    // shared topic across several tasks is not repeated once per task.
    .slice(0, 6);

  return {
    commitment: {
      id: input.commitment.id,
      title: input.commitment.title,
      description: input.commitment.description ?? "",
      acceptance_criteria: extractAcceptanceCriteria(input.commitment).map((item) => item.title)
    },
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.task,
      description: task.workspace_summary ?? "",
      suggested_next_steps: getSuggestedSteps(task.suggested_steps),
      owner: task.owner ?? "Unassigned",
      due_date: task.due_date ?? null,
      status: task.status,
      source_quote: task.source_quote ?? ""
    })),
    meeting_context: meetingContext
  };
}

// ============================================================
// Model call
// ============================================================

export async function inferTaskDependenciesWithOpenAI(input: {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  meetingContextByTopicId?: Map<string, string>;
}): Promise<
  | { ok: true; candidates: DependencyCandidate[] }
  | { ok: false; error: string; details?: string }
> {
  if (input.tasks.length < 2) {
    // Nothing can depend on anything else with fewer than two candidate tasks.
    return { ok: true, candidates: [] };
  }

  const context = buildDependencyInferenceContext(input);

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Infer hard execution dependencies among these candidate tasks and return the required JSON.\n\n${JSON.stringify(context)}`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_dependency_inference",
          strict: true,
          schema: dependencyInferenceJsonSchema
        }
      }
    });

    const rawText = response.output_text?.trim();
    if (!rawText) {
      return { ok: false, error: "Empty dependency inference response." };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: "Invalid dependency inference JSON." };
    }

    const validated = dependencyInferenceResultSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: "Dependency inference schema mismatch.",
        details: validated.error.message
      };
    }

    return { ok: true, candidates: validated.data.dependencies };
  } catch (error) {
    return {
      ok: false,
      error: "Failed to infer task dependencies.",
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

// ============================================================
// Server-side validation -- the model's output is never trusted directly. Deterministic, no LLM
// involvement, fully unit-testable.
// ============================================================

export type DependencyRejectReason =
  | "not_hard_dependency"
  | "unknown_task_id"
  | "self_dependency"
  | "duplicate_candidate"
  | "below_confidence_threshold"
  | "stale_generation"
  | "not_eligible_status"
  | "locked_task"
  | "would_create_cycle"
  | "superseded_by_higher_confidence";

export type ValidatedDependency = {
  task_id: string;
  depends_on_task_id: string;
  confidence: number;
  reason: string;
};

export type RejectedDependency = {
  candidate: DependencyCandidate;
  reason: DependencyRejectReason;
};

export type DependencyValidationResult = {
  accepted: ValidatedDependency[];
  rejected: RejectedDependency[];
};

type DependencyEdge = { task_id: string; depends_on_task_id: string };

/** Mirrors public.reject_task_dependency_cycle's recursive-reachability check exactly, so an
 * edge this function accepts is guaranteed to also pass the DB trigger -- deterministic,
 * independent of the LLM. Returns true if adding `candidate` to `edges` would create a cycle. */
export function wouldCreateCycle(edges: DependencyEdge[], candidate: DependencyEdge): boolean {
  if (candidate.task_id === candidate.depends_on_task_id) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.task_id) ?? [];
    list.push(edge.depends_on_task_id);
    adjacency.set(edge.task_id, list);
  }
  const visited = new Set<string>();
  const stack = [candidate.depends_on_task_id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === candidate.task_id) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

/** A task is eligible to appear as either side of an inferred edge only if it is current
 * generation, active/committed work (not Future Scope), and not dismissed. Completed tasks
 * remain eligible as a `depends_on_task_id` (prerequisite) target -- a dependent task should
 * stop being blocked once its prerequisite completes, not be excluded from having one. */
function isEligibleDependencyTask(
  task: MeetingTask,
  currentGeneration: number | null | undefined
): { eligible: true } | { eligible: false; reason: DependencyRejectReason } {
  if (!isTaskCurrentGeneration(task, currentGeneration)) {
    return { eligible: false, reason: "stale_generation" };
  }
  if (task.status === "dismissed" || !isCommittedWork(task)) {
    return { eligible: false, reason: "not_eligible_status" };
  }
  return { eligible: true };
}

export function validateDependencyCandidates(input: {
  candidates: DependencyCandidate[];
  /** The full candidate task pool this inference run was scoped to (one commitment's children).
   * Any id outside this set is treated as unknown/hallucinated, never looked up elsewhere. */
  tasks: MeetingTask[];
  currentGeneration?: number | null;
  /** task_ids whose own outgoing dependency set a human has already touched -- see
   * manual_override_fields on meeting_tasks. AI never overwrites these, but they remain valid
   * `depends_on_task_id` targets for other tasks. */
  lockedTaskIds?: Set<string>;
  /** Pre-existing edges (this commitment's current task_dependencies rows) used as the cycle-
   * detection baseline, so a new edge can never close a loop through already-persisted edges. */
  existingEdges?: DependencyEdge[];
  confidenceThreshold?: number;
}): DependencyValidationResult {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const lockedTaskIds = input.lockedTaskIds ?? new Set<string>();
  const threshold = input.confidenceThreshold ?? DEPENDENCY_CONFIDENCE_THRESHOLD;

  const accepted: ValidatedDependency[] = [];
  const rejected: RejectedDependency[] = [];
  const runningEdges: DependencyEdge[] = [...(input.existingEdges ?? [])];
  const seenPairs = new Set<string>();
  const bestByTaskId = new Map<string, DependencyCandidate>();
  const rejectedEarly: RejectedDependency[] = [];

  for (const candidate of input.candidates) {
    if (candidate.relationship !== "hard_dependency") {
      rejectedEarly.push({ candidate, reason: "not_hard_dependency" });
      continue;
    }
    if (candidate.task_id === candidate.depends_on_task_id) {
      rejectedEarly.push({ candidate, reason: "self_dependency" });
      continue;
    }
    const pairKey = `${candidate.task_id}::${candidate.depends_on_task_id}`;
    if (seenPairs.has(pairKey)) {
      rejectedEarly.push({ candidate, reason: "duplicate_candidate" });
      continue;
    }
    seenPairs.add(pairKey);

    if (candidate.confidence < threshold) {
      rejectedEarly.push({ candidate, reason: "below_confidence_threshold" });
      continue;
    }

    const dependentTask = tasksById.get(candidate.task_id);
    const prerequisiteTask = tasksById.get(candidate.depends_on_task_id);
    if (!dependentTask || !prerequisiteTask) {
      rejectedEarly.push({ candidate, reason: "unknown_task_id" });
      continue;
    }

    const dependentEligibility = isEligibleDependencyTask(dependentTask, input.currentGeneration);
    if (!dependentEligibility.eligible) {
      rejectedEarly.push({ candidate, reason: dependentEligibility.reason });
      continue;
    }
    const prerequisiteEligibility = isEligibleDependencyTask(
      prerequisiteTask,
      input.currentGeneration
    );
    if (!prerequisiteEligibility.eligible) {
      rejectedEarly.push({ candidate, reason: prerequisiteEligibility.reason });
      continue;
    }

    if (lockedTaskIds.has(candidate.task_id)) {
      rejectedEarly.push({ candidate, reason: "locked_task" });
      continue;
    }

    // v1 keeps at most one AI-authored dependency per task (matches the single-select manual
    // picker) -- keep only the highest-confidence surviving candidate per task_id.
    const currentBest = bestByTaskId.get(candidate.task_id);
    if (currentBest) {
      if (candidate.confidence > currentBest.confidence) {
        rejectedEarly.push({ candidate: currentBest, reason: "superseded_by_higher_confidence" });
        bestByTaskId.set(candidate.task_id, candidate);
      } else {
        rejectedEarly.push({ candidate, reason: "superseded_by_higher_confidence" });
      }
      continue;
    }
    bestByTaskId.set(candidate.task_id, candidate);
  }

  rejected.push(...rejectedEarly);

  // Apply cycle detection deterministically, highest confidence first, against a running edge
  // set that grows as edges are accepted -- so two otherwise-valid candidates that would only
  // cycle together (not individually) are still caught.
  const survivors = Array.from(bestByTaskId.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
  for (const candidate of survivors) {
    const edge: DependencyEdge = {
      task_id: candidate.task_id,
      depends_on_task_id: candidate.depends_on_task_id
    };
    if (wouldCreateCycle(runningEdges, edge)) {
      rejected.push({ candidate, reason: "would_create_cycle" });
      continue;
    }
    runningEdges.push(edge);
    accepted.push({
      task_id: candidate.task_id,
      depends_on_task_id: candidate.depends_on_task_id,
      confidence: candidate.confidence,
      reason: candidate.reason.trim()
    });
  }

  return { accepted, rejected };
}

// ============================================================
// Persistence -- reuses the existing service-role-only replace_task_dependencies RPC (the same
// atomic, cycle-checked function the manual dependency picker calls). AI writes never set
// manual_override_fields/preserve_on_reanalysis; only a human action does that (see
// app/api/tasks/[id]/dependencies/route.ts).
// ============================================================

export type DependencyInferenceDiagnostics = {
  commitmentId: string;
  candidateTaskCount: number;
  proposedEdgeCount: number;
  acceptedEdgeCount: number;
  rejectedInvalidCount: number;
  rejectedCycleCount: number;
  lockedTaskCount: number;
};

function isDependenciesLocked(task: MeetingTask): boolean {
  return (
    Array.isArray(task.manual_override_fields) &&
    task.manual_override_fields.includes("dependencies")
  );
}

/** The single reusable unit both the post-analysis best-effort pass (lib/task-dependency-
 * inference-batch.ts) and the manual "Re-evaluate dependencies" action call. Scoped to exactly
 * one commitment's own child tasks -- v1 does not infer across commitments or for standalone
 * tasks (see AUDIT notes / final report: conservative scope, matches the existing manual
 * dependency picker's own same-commitment constraint in the PUT route). */
export async function inferAndApplyDependenciesForCommitment(input: {
  commitment: MeetingCommitment;
  tasks: MeetingTask[];
  existingDependencies: TaskDependency[];
  meetingContextByTopicId?: Map<string, string>;
  currentGeneration?: number | null;
}): Promise<
  | { ok: true; diagnostics: DependencyInferenceDiagnostics; dependencies: TaskDependency[] }
  | { ok: false; error: string; details?: string; diagnostics: DependencyInferenceDiagnostics }
> {
  const eligibleTasks = input.tasks.filter(
    (task) => isEligibleDependencyTask(task, input.currentGeneration).eligible
  );
  const lockedTaskIds = new Set(eligibleTasks.filter(isDependenciesLocked).map((task) => task.id));
  const existingEdges: DependencyEdge[] = input.existingDependencies
    .filter(
      (dependency) =>
        input.tasks.some((task) => task.id === dependency.task_id) &&
        input.tasks.some((task) => task.id === dependency.depends_on_task_id)
    )
    .map((dependency) => ({
      task_id: dependency.task_id,
      depends_on_task_id: dependency.depends_on_task_id
    }));

  const baseDiagnostics: DependencyInferenceDiagnostics = {
    commitmentId: input.commitment.id,
    candidateTaskCount: eligibleTasks.length,
    proposedEdgeCount: 0,
    acceptedEdgeCount: 0,
    rejectedInvalidCount: 0,
    rejectedCycleCount: 0,
    lockedTaskCount: lockedTaskIds.size
  };

  const inference = await inferTaskDependenciesWithOpenAI({
    commitment: input.commitment,
    tasks: eligibleTasks,
    meetingContextByTopicId: input.meetingContextByTopicId
  });
  if (!inference.ok) {
    return { ok: false, error: inference.error, details: inference.details, diagnostics: baseDiagnostics };
  }

  const validation = validateDependencyCandidates({
    candidates: inference.candidates,
    tasks: eligibleTasks,
    currentGeneration: input.currentGeneration,
    lockedTaskIds,
    existingEdges
  });

  const diagnostics: DependencyInferenceDiagnostics = {
    ...baseDiagnostics,
    proposedEdgeCount: inference.candidates.length,
    acceptedEdgeCount: validation.accepted.length,
    rejectedInvalidCount: validation.rejected.filter((item) => item.reason !== "would_create_cycle")
      .length,
    rejectedCycleCount: validation.rejected.filter((item) => item.reason === "would_create_cycle")
      .length
  };

  console.info("[task-dependency-inference] commitment evaluated", diagnostics);

  const acceptedByTaskId = new Map(validation.accepted.map((edge) => [edge.task_id, edge]));

  // Every non-locked, eligible task in this commitment gets its dependency set fully recomputed
  // from this run's result (an AI-authored set with nothing accepted this time is correctly
  // cleared) -- locked tasks are skipped entirely, left exactly as the human set them.
  for (const task of eligibleTasks) {
    if (lockedTaskIds.has(task.id)) continue;
    const accepted = acceptedByTaskId.get(task.id);
    const { error } = await supabaseAdmin.rpc("replace_task_dependencies", {
      p_task_id: task.id,
      p_depends_on_task_ids: accepted ? [accepted.depends_on_task_id] : []
    });
    if (error) {
      console.warn("[task-dependency-inference] Failed to persist dependency", {
        task_id: task.id,
        error: error.message
      });
    }
  }

  const { data: refreshed, error: refreshError } = await supabaseAdmin
    .from("task_dependencies")
    .select("*")
    .in("task_id", input.tasks.map((task) => task.id));
  if (refreshError) {
    return {
      ok: false,
      error: "Dependencies were applied but could not be reloaded.",
      details: refreshError.message,
      diagnostics
    };
  }

  return { ok: true, diagnostics, dependencies: (refreshed ?? []) as TaskDependency[] };
}
