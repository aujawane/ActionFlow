import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  interpretProjectBrainMessageDeterministically,
  PROJECT_BRAIN_SYSTEM_PROMPT
} from "../lib/project-brain/agent";
import {
  buildMeetingProjectMemoryContext,
  type ProjectBrainContext
} from "../lib/project-brain/context";
import {
  canonicalProjectPeople,
  collectProjectPersonReferences,
  normalizeOperationsForApply,
  proposalCompletenessWarnings,
  resolveProjectPerson,
  requiresMilestonePlanning,
  validateAndCanonicalizeOperationOwners,
  validateAndCanonicalizePersonCorrection,
  validateOperationsIndividually
} from "../lib/project-brain/operations";
import {
  projectBrainResponseSchema,
  projectProposalReviewSchema
} from "../lib/project-brain/schemas";

const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000001";
const authTaskId = "30000000-0000-4000-8000-000000000002";
const stackTaskId = "30000000-0000-4000-8000-000000000003";
const participantId = "80000000-0000-4000-8000-000000000001";

function context(overrides: Partial<ProjectBrainContext> = {}): ProjectBrainContext {
  return {
    project: {
      id: projectId,
      name: "Jamileh",
      description: null,
      goal: null,
      status: "active",
      owner_id: "40000000-0000-4000-8000-000000000001",
      execution_graph_version: 12,
      created_at: "2026-07-27T00:00:00Z",
      updated_at: "2026-07-27T00:00:00Z"
    },
    memory: null,
    requirements: [],
    decisions: [],
    constraints: [],
    participants: [],
    milestones: [
      {
        id: milestoneId,
        meeting_id: "50000000-0000-4000-8000-000000000001",
        title: "Define technical stack",
        status: "pending",
        manual_override_fields: []
      }
    ],
    tasks: [
      {
        id: taskId,
        commitment_id: milestoneId,
        task: "Send product photos",
        status: "pending",
        manual_override_fields: []
      },
      {
        id: authTaskId,
        commitment_id: milestoneId,
        task: "Implement authentication and login",
        status: "pending",
        manual_override_fields: ["task"]
      },
      {
        id: stackTaskId,
        commitment_id: milestoneId,
        task: "Choose the technology stack",
        status: "pending",
        manual_override_fields: []
      }
    ],
    meetings: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        title: "Kickoff",
        summary: "Website kickoff"
      }
    ],
    recentChanges: [],
    progress: { completed: 0, total: 3, percent: 0 },
    staleMilestoneIds: new Set(),
    staleTaskIds: new Set(),
    ...overrides
  };
}

test("Project Brain Jamileh context produces a reviewable informational MVP proposal", () => {
  const designMilestoneId = "20000000-0000-4000-8000-000000000002";
  const commerceMilestoneId = "20000000-0000-4000-8000-000000000003";
  const result = interpretProjectBrainMessageDeterministically({
    context: context({
      milestones: [
        ...context().milestones,
        {
          id: designMilestoneId,
          meeting_id: "50000000-0000-4000-8000-000000000001",
          title: "Deliver first website draft",
          status: "pending",
          manual_override_fields: []
        },
        {
          id: commerceMilestoneId,
          meeting_id: "50000000-0000-4000-8000-000000000001",
          title: "Implement authentication and payment processing",
          status: "pending",
          manual_override_fields: []
        }
      ]
    }),
    message:
      "Jamileh sells digestible protein bars for people who have difficulty with common protein products. We are building an informational first version of the website with a homepage, product page, founder story, FAQ, and contact page. E-commerce, subscriptions, login, and payments should come later. Use Next.js, Tailwind, Supabase, and Vercel."
  });
  assert.equal(result?.responseType, "proposal");
  assert.equal(result?.proposal?.baseGraphVersion, 12);
  const types = result?.proposal?.operations.map((operation) => operation.type) ?? [];
  assert.ok(types.includes("update_project_memory"));
  assert.ok(types.includes("rename_milestone"));
  assert.ok(types.includes("merge_milestones"));
  assert.ok(types.includes("defer_milestone"));
  assert.ok(types.includes("create_task"));
  assert.ok(types.includes("archive_task"));
  assert.ok(types.includes("update_task_status"));
  assert.match(result?.message ?? "", /Nothing has been applied/i);
  const authArchive = result?.proposal?.operations.find(
    (operation) =>
      operation.type === "archive_task" && operation.taskId === authTaskId
  );
  assert.match(authArchive?.warning ?? "", /manual edits/i);
});

test("technology context resolves an existing stack task without creating a duplicate", () => {
  const stackTask = {
    ...context().tasks[0],
    task: "Choose the technology stack"
  };
  const result = interpretProjectBrainMessageDeterministically({
    context: context({ tasks: [stackTask] }),
    message: "We are using Next.js, Supabase, Tailwind, and Vercel."
  });
  assert.equal(result?.responseType, "proposal");
  assert.deepEqual(
    result?.proposal?.operations.map((operation) => operation.type),
    ["update_project_memory", "update_task_status"]
  );
});

test("completed-work statements propose completion for one strong task match", () => {
  const result = interpretProjectBrainMessageDeterministically({
    context: context({ tasks: [context().tasks[0]] }),
    message: "Jamileh already sent me the product photos."
  });
  assert.equal(result?.responseType, "proposal");
  assert.deepEqual(result?.proposal?.operations[0], {
    type: "update_task_status",
    taskId,
    status: "completed",
    explanation: "The user reported this matching work as complete.",
    evidence: [{ type: "task", id: taskId, label: "Send product photos" }],
    warning: null
  });
});

test("task owner correction produces one canonical, reviewable operation", () => {
  const result = interpretProjectBrainMessageDeterministically({
    context: context({
      participants: [
        { participant_name: "Didier" },
        { participant_name: "Aditya Ujawane" }
      ],
      tasks: [{
        ...context().tasks[0],
        task: "Clarify the enterprise Codex account and subscription approach",
        owner: "Didier"
      }]
    }),
    message: "Change the owner of task Clarify the enterprise Codex account from Didier to Aditya Ujawane."
  });
  assert.equal(result?.responseType, "proposal");
  assert.equal(result?.proposal?.operations.length, 1);
  assert.deepEqual(result?.proposal?.operations[0], {
    type: "assign_task_owner",
    taskId,
    ownerName: "Aditya Ujawane",
    explanation: "Apply the user's explicit owner correction.",
    evidence: [{
      type: "task",
      id: taskId,
      label: "Clarify the enterprise Codex account and subscription approach"
    }],
    warning: null
  });
});

test("same-person language produces one project identity correction without requiring a task target", () => {
  const sourceTask = {
    ...context().tasks[0],
    task: "Clarify the enterprise Codex account and subscription approach",
    owner: "Didier",
    owners: ["Didier"]
  };
  const projectParticipants = [{
    id: participantId,
    participant_name: "Aditya Ujawane"
  }];
  const personReferences = collectProjectPersonReferences({
    tasks: [sourceTask],
    commitments: context().milestones,
    projectParticipants
  });
  const identityContext = context({
    tasks: [sourceTask],
    participants: [
      { participant_name: "Didier", source_type: "execution_owner" },
      ...projectParticipants
    ],
    personReferences
  });
  const result = interpretProjectBrainMessageDeterministically({
    context: identityContext,
    message: "In People, Didier is the same as Aditya Ujawane."
  });
  assert.equal(result?.responseType, "proposal");
  assert.equal(result?.proposal?.operations.length, 1);
  const operation = result?.proposal?.operations[0];
  assert.equal(operation?.type, "correct_project_person");
  if (operation?.type !== "correct_project_person") return;
  assert.equal(operation.sourceName, "Didier");
  assert.equal(operation.destinationName, "Aditya Ujawane");
  assert.equal(operation.affectedReferences.length, 1);
  assert.deepEqual(operation.affectedReferences[0], {
    type: "task",
    id: taskId,
    label: "Clarify the enterprise Codex account and subscription approach",
    personName: "Didier",
    fields: ["owner", "owners"]
  });
  const validation = validateAndCanonicalizePersonCorrection(operation, identityContext);
  assert.equal(validation.ok, true);
});

test("identity correction asks for clarification when source or destination is ambiguous", () => {
  const ambiguousSource = interpretProjectBrainMessageDeterministically({
    context: context({
      participants: [
        { participant_name: "Chris Lauer" },
        { participant_name: "Chris Smith" },
        { participant_name: "Aditya Ujawane" }
      ]
    }),
    message: "Chris is the same as Aditya Ujawane."
  });
  assert.equal(ambiguousSource?.responseType, "clarification");
  assert.match(ambiguousSource?.message ?? "", /source person/i);

  const ambiguousDestination = interpretProjectBrainMessageDeterministically({
    context: context({
      participants: [
        { participant_name: "Didier" },
        { participant_name: "Aditya Ujawane" },
        { participant_name: "Aditya Rao" }
      ]
    }),
    message: "Didier is the same as Aditya."
  });
  assert.equal(ambiguousDestination?.responseType, "clarification");
  assert.match(ambiguousDestination?.message ?? "", /destination person/i);
});

test("identity correction refuses a reference set larger than one review operation", () => {
  const personReferences = Array.from({ length: 301 }, (_, index) => ({
    type: "task" as const,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    label: `Task ${index + 1}`,
    personName: "Didier",
    fields: ["owner" as const]
  }));
  const result = interpretProjectBrainMessageDeterministically({
    context: context({
      participants: [
        { participant_name: "Didier" },
        { participant_name: "Aditya Ujawane" }
      ],
      personReferences
    }),
    message: "Didier is the same as Aditya Ujawane."
  });
  assert.equal(result?.responseType, "clarification");
  assert.match(result?.message ?? "", /more references than can be reviewed safely/i);
});

test("owner resolution rejects unknown and ambiguous destination people", () => {
  const ownerContext = context({
    participants: [
      { participant_name: "Aditya Ujawane" },
      { participant_name: "Aditya Rao" }
    ]
  });
  assert.equal(resolveProjectPerson("Aditya", ownerContext).ok, false);
  assert.equal(resolveProjectPerson("Unknown Person", ownerContext).ok, false);
  const invalid = validateAndCanonicalizeOperationOwners([{
    type: "assign_task_owner",
    taskId,
    ownerName: "Unknown Person",
    explanation: "Change owner.",
    evidence: [],
    warning: null
  }], ownerContext);
  assert.equal(invalid.ok, false);
});

test("person resolution prefers canonical individuals over a combined extraction label", () => {
  const people = canonicalProjectPeople(context({
    participants: [
      { participant_name: "Craig Lauer" },
      { participant_name: "Laura Wetherhold" },
      { participant_name: "Craig Lauer and Laura Wetherhold" }
    ]
  }));
  assert.deepEqual(people, ["Craig Lauer", "Laura Wetherhold"]);
});

test("generic project questions do not deterministically create proposals", () => {
  assert.equal(
    interpretProjectBrainMessageDeterministically({
      context: context(),
      message: "What is the next best task?"
    }),
    null
  );
});

test("major scope changes require outcome-level milestone planning", () => {
  assert.equal(
    requiresMilestonePlanning(
      "Change the MVP to an informational website and move payments to a later phase."
    ),
    true
  );
  assert.deepEqual(
    proposalCompletenessWarnings({
      message:
        "Reorganize the milestones for an informational MVP and defer payments.",
      operations: [
        {
          type: "update_project_memory",
          changes: { current_scope: ["Informational website"] },
          explanation: "Update scope.",
          evidence: [],
          warning: null
        }
      ]
    }),
    ["Scope changed substantially, but no commitment operations were generated."]
  );
  assert.deepEqual(
    proposalCompletenessWarnings({
      message:
        "Reorganize the milestones for an informational MVP and defer payments.",
      operations: [
        {
          type: "rename_milestone",
          milestoneId,
          title: "Deliver Informational Website MVP",
          explanation: "Represent the new outcome.",
          evidence: [],
          warning: null
        }
      ]
    }),
    []
  );
});

test("rename and defer milestone operations normalize without being dropped", () => {
  const operations = normalizeOperationsForApply([
    {
      type: "rename_milestone",
      milestoneId,
      title: "Deliver Informational Website MVP",
      explanation: "Rename the outcome.",
      evidence: [],
      warning: null
    },
    {
      type: "defer_milestone",
      milestoneId,
      reason: "Later phase",
      explanation: "Move it out of current execution.",
      evidence: [],
      warning: null
    }
  ]);
  assert.deepEqual(
    operations.map((operation) => operation.type),
    ["update_milestone", "archive_milestone"]
  );
});

test("unsupported operations produce explicit rejection reasons", () => {
  const result = validateOperationsIndividually([
    {
      type: "delete_milestone",
      milestoneId,
      explanation: "Delete it",
      evidence: [],
      warning: null
    }
  ]);
  assert.equal(result.operations.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /Invalid discriminator value/i);
});

test("proposal schema rejects unsupported operations and invalid IDs", () => {
  assert.equal(
    projectProposalReviewSchema.safeParse({
      operations: [{ type: "delete_everything" }]
    }).success,
    false
  );
  assert.equal(
    projectProposalReviewSchema.safeParse({
      operations: [
        {
          type: "update_task_status",
          taskId: "not-an-id",
          status: "completed",
          explanation: "Done",
          evidence: [],
          warning: null
        }
      ]
    }).success,
    false
  );
});

test("response schema requires a proposal only for proposal responses", () => {
  assert.equal(
    projectBrainResponseSchema.safeParse({
      responseType: "answer",
      message: "No graph changes are needed.",
      proposal: null,
      references: [],
      warnings: []
    }).success,
    true
  );
  assert.equal(
    projectBrainResponseSchema.safeParse({
      responseType: "proposal",
      message: "Review this.",
      proposal: null,
      references: [],
      warnings: []
    }).success,
    false
  );
  assert.equal(projectProposalReviewSchema.safeParse({ operations: [] }).success, false);
});

test("approved memory exposes bounded re-analysis context and keeps future scope separate", () => {
  const result = buildMeetingProjectMemoryContext(
    context({
      memory: {
        goal: "Launch an informational website",
        summary: "Digestible protein bar brand",
        current_scope: ["Informational website"],
        future_scope: ["Payments", "Subscriptions"],
        technical_context: { framework: "Next.js" },
        confirmed_fields: { goal: true }
      },
      constraints: [
        {
          id: "60000000-0000-4000-8000-000000000001",
          title: "No e-commerce in MVP",
          status: "active",
          manually_confirmed: true
        }
      ],
      decisions: [
        {
          id: "70000000-0000-4000-8000-000000000001",
          title: "Use Vercel",
          status: "active",
          manually_confirmed: true
        }
      ]
    })
  );
  assert.deepEqual(result?.future_scope, ["Payments", "Subscriptions"]);
  assert.deepEqual(result?.current_scope, ["Informational website"]);
  assert.equal(
    typeof result?.confirmed_fields === "object" &&
      result.confirmed_fields !== null &&
      "goal" in result.confirmed_fields,
    true
  );
});

test("Project Brain prompt forbids direct mutation and protects future scope", () => {
  assert.match(PROJECT_BRAIN_SYSTEM_PROMPT, /Never mutate data/i);
  assert.match(PROJECT_BRAIN_SYSTEM_PROMPT, /future scope are not active tasks/i);
  assert.match(PROJECT_BRAIN_SYSTEM_PROMPT, /manual field/i);
  assert.doesNotMatch(PROJECT_BRAIN_SYSTEM_PROMPT, /milestone hierarchy/i);
  assert.match(PROJECT_BRAIN_SYSTEM_PROMPT, /commitment hierarchy/i);
});

test("migration defines durable storage, RLS, versioning, atomic apply, and audit", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260727130000_project_brain_phase1.sql",
      import.meta.url
    ),
    "utf8"
  );
  for (const table of [
    "project_memory",
    "project_requirements",
    "project_decisions",
    "project_constraints",
    "project_chat_threads",
    "project_chat_messages",
    "project_change_proposals",
    "project_change_events"
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /execution_graph_version bigint not null default 0/);
  assert.match(sql, /create or replace function public\.apply_project_change_proposal/);
  assert.match(sql, /for update/);
  assert.match(sql, /proposal_row\.base_graph_version/);
  assert.match(sql, /grant execute on function public\.apply_project_change_proposal[\s\S]*service_role/);
  assert.match(sql, /insert into public\.project_change_events/);
  assert.match(sql, /project_change_proposals_owner_select/);
  assert.doesNotMatch(sql, /create policy "project_change_proposals_owner_all"/);
  assert.match(sql, /meeting_tasks_preserve_manual_parent/);
  assert.match(sql, /move_task_dependency_conflict/);
  assert.match(sql, /cross_meeting_milestone_merge_not_supported/);
  assert.match(sql, /execution_classification = case[\s\S]*future_consideration/);
  assert.match(sql, /when changes \? 'goal' then changes->>'goal'/);
  for (const operation of [
    "create_milestone",
    "update_milestone",
    "merge_milestones",
    "archive_milestone",
    "create_task",
    "update_task",
    "move_task",
    "merge_tasks",
    "archive_task"
  ]) {
    assert.match(sql, new RegExp(`'${operation}'`));
  }
  assert.match(sql, /execution_graph_version = execution_graph_version \+ 1/);
  assert.match(sql, /status = 'superseded'/);
});

test("person correction migration atomically updates only audited identity references", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/20260814090000_add_project_person_correction_rpc.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(sql, /create or replace function public\.apply_project_person_correction/);
  assert.match(sql, /project_row\.owner_id <> p_actor_id/);
  assert.match(sql, /proposal_row\.base_graph_version/);
  assert.match(sql, /update public\.meeting_tasks/);
  assert.match(sql, /update public\.meeting_commitments/);
  assert.match(sql, /update public\.project_participants/);
  assert.match(sql, /update public\.commitment_participants/);
  assert.match(sql, /update public\.meeting_speaker_aliases/);
  assert.match(sql, /preserve_on_reanalysis = true/);
  assert.match(sql, /manual_override_fields/);
  assert.match(sql, /status = 'applied'/);
  assert.match(sql, /proposal_not_applicable/);
  assert.match(sql, /grant execute on function public\.apply_project_person_correction[\s\S]*service_role/);
  assert.doesNotMatch(sql, /update public\.transcript_segments/);
  assert.doesNotMatch(sql, /source_quote\s*=/);
});

test("apply endpoint canonicalizes aliases, logs selected operations, and refreshes project data", async () => {
  const route = await readFile(
    new URL(
      "../app/api/projects/[id]/brain/proposals/[proposalId]/apply/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(route, /normalizeOperationsForApply/);
  assert.match(route, /selected operations submitted/);
  assert.match(route, /operations passed to apply RPC/);
  assert.match(route, /proposal operations applied/);
  assert.match(route, /resulting_graph_version/);
  assert.match(route, /revalidatePath\(`\/projects\/\$\{id\}`\)/);
  assert.match(route, /validateAndCanonicalizeOperationOwners/);
  assert.match(route, /validateAndCanonicalizePersonCorrection/);
  assert.match(route, /apply_project_person_correction/);
  assert.match(route, /getOwnedProject/);
  assert.match(route, /revalidatePath\("\/dashboard"\)/);
});

test("workspace includes responsive chat, review controls, retry, memory, and accessible input", async () => {
  const [component, review] = await Promise.all([
    readFile(
      new URL("../components/project-brain-panel.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL(
        "../components/project-brain-operation-review.tsx",
        import.meta.url
      ),
      "utf8"
    )
  ]);
  assert.match(component, /Project Brain/);
  assert.match(component, /Review changes/);
  assert.match(component, /Approve selected & apply/);
  assert.match(component, /Retry/);
  assert.match(component, /Project Memory/);
  assert.match(component, /Shift\+Enter/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /lg:hidden/);
  assert.match(component, /resize-x/);
  assert.match(component, /Approve all/);
  assert.match(component, /Deselect all/);
  assert.match(component, /Reject proposal/);
  assert.match(component, /router\.refresh\(\)/);
  assert.doesNotMatch(component, /Current value/);
  assert.doesNotMatch(component, /Proposed value \(editable JSON\)/);
  assert.match(review, /Advanced technical details/);
  assert.match(component, /Invalid JSON syntax/);
  assert.match(review, /Tasks affected/);
  assert.match(review, /Manual edits preserved/);
  assert.match(review, /Affected commitment/);
  assert.match(review, /MEMORY_LABELS/);
  assert.match(review, /label="Owner"/);
  assert.match(review, /Correct Project Person Identity/);
  assert.match(review, /Affected references/);
  assert.match(review, /Transcript text, source quotes, evidence/);
  assert.match(component, /No applicable structured changes are available/);
});
