import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { consolidateExecutionGraph } from "../lib/execution-intelligence/consolidation";
import { resolveAssigneesAndDueDates } from "../lib/execution-intelligence/resolution";
import { GLOBAL_SYNTHESIS_PROMPT } from "../lib/execution-intelligence/prompts";
import { linkTasksToCommitments } from "../lib/execution-intelligence/linking";
import type {
  CommitmentCandidate,
  TaskCandidate
} from "../lib/execution-intelligence/schemas";
import {
  deriveCommitmentPeople,
  groupCommitmentTasksByOwner
} from "../lib/project-execution";
import type {
  CommitmentParticipant,
  MeetingCommitment,
  MeetingTask
} from "../lib/types";
import { ANALYSIS_STAGE_ORDER } from "../lib/meeting-analysis/jobs";

const segment = "11111111-1111-4111-8111-111111111111";

function commitment(
  client_ref: string,
  title: string,
  overrides: Partial<CommitmentCandidate> = {}
): CommitmentCandidate {
  return {
    client_ref,
    topic_id: null,
    title,
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: title,
    source_segment_ids: [segment],
    evidence_source: "transcript",
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    consolidated_from_refs: [],
    ...overrides
  };
}

function candidateTask(
  client_ref: string,
  title: string,
  overrides: Partial<TaskCandidate> = {}
): TaskCandidate {
  return {
    client_ref,
    commitment_ref: "website",
    topic_id: null,
    title,
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    confidence: 0.9,
    source_quote: title,
    source_segment_ids: [segment],
    evidence_source: "transcript",
    inferred: false,
    task_type: "commitment",
    workspace_type: "other",
    suggested_steps: [],
    execution_classification: "committed",
    consolidated_from_refs: [],
    ...overrides
  };
}

function storedCommitment(): MeetingCommitment {
  return {
    id: "commitment-1",
    meeting_id: "meeting-1",
    topic_id: null,
    title: "Deliver the website",
    description: null,
    owner: "Aditya",
    owners: ["Aditya"],
    lead_owner_name: "Aditya",
    due_date: null,
    due_date_text: null,
    priority: "high",
    status: "in_progress",
    confidence: 0.9,
    source_quote: "We will deliver it",
    source_segment_ids: [segment],
    type: "personal",
    completion_state: "in_progress",
    execution_classification: "committed",
    metadata: {},
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z"
  };
}

function storedTask(
  id: string,
  owner: string | null,
  position: number
): MeetingTask {
  return {
    id,
    meeting_id: "meeting-1",
    topic_id: null,
    commitment_id: "commitment-1",
    task: `Task ${id}`,
    owner,
    owners: owner ? [owner] : [],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: "evidence",
    confidence: 0.9,
    status: "pending",
    workspace_type: "other",
    workspace_summary: null,
    execution_classification: "committed",
    position,
    created_at: "2026-07-27T00:00:00Z"
  };
}

test("narrow actions, requirements, and future ideas are demoted from commitments", () => {
  const result = consolidateExecutionGraph({
    commitments: [
      commitment("website", "Deliver the first working version of the website"),
      commitment("stack", "Select the technology stack"),
      commitment("pastel", "Use pastel green and violet", {
        owner: null,
        owners: [],
        execution_classification: "requirement"
      }),
      commitment("chatbot", "Add chatbot integration later", {
        owner: null,
        owners: [],
        execution_classification: "future_consideration"
      })
    ],
    tasks: []
  });

  assert.deepEqual(
    result.graph.commitments.map((item) => item.client_ref),
    ["website"]
  );
  assert.equal(result.graph.tasks.length, 3);
  assert.equal(
    result.graph.tasks.find((item) => item.client_ref.includes("pastel"))
      ?.execution_classification,
    "requirement"
  );
  assert.equal(
    result.graph.tasks.find((item) => item.client_ref.includes("chatbot"))
      ?.execution_classification,
    "future_consideration"
  );
});

test("durable analysis runs one global synthesis checkpoint before persistence", () => {
  assert.ok(
    ANALYSIS_STAGE_ORDER.indexOf("synthesis") >
      ANALYSIS_STAGE_ORDER.indexOf("final_verification")
  );
  assert.ok(
    ANALYSIS_STAGE_ORDER.indexOf("synthesis") <
      ANALYSIS_STAGE_ORDER.indexOf("persistence")
  );
  assert.match(GLOBAL_SYNTHESIS_PROMPT, /2-7 commitments/);
  assert.match(GLOBAL_SYNTHESIS_PROMPT, /Do not copy the commitment\s+lead/);
});

test("website implementation candidates synthesize under one outcome", () => {
  const result = consolidateExecutionGraph({
    commitments: [
      commitment("website", "Deliver the first working version of Jamileh's website"),
      commitment("stack", "Define technical stack and tools"),
      commitment("auth-plan", "Plan authentication and payment processing"),
      commitment("login-ui", "Design login and signup UI"),
      commitment("catalog", "Design product catalog interface"),
      commitment("auth", "Implement authentication and order placement")
    ],
    tasks: []
  });
  assert.equal(result.graph.commitments.length, 1);
  assert.equal(result.graph.tasks.length, 5);
  assert.ok(
    result.graph.tasks.every((item) => item.commitment_ref === "website")
  );
});

test("chatbot duplicates merge by phase while phases remain distinct", () => {
  const result = consolidateExecutionGraph({
    commitments: [commitment("website", "Deliver the website")],
    tasks: [
      candidateTask("t1", "Research chatbot platforms"),
      candidateTask("t2", "Compile chatbot platform list"),
      candidateTask("t3", "Evaluate chatbot platforms"),
      candidateTask("t4", "Research chatbot integration possibilities"),
      candidateTask("t5", "Select a chatbot platform or defer the feature")
    ]
  });
  assert.equal(result.graph.tasks.length, 3);
  assert.deepEqual(
    new Set(result.graph.tasks.map((item) => item.title.split(" ")[0])),
    new Set(["Research", "Evaluate", "Select"])
  );
});

test("product wireframe variants merge into one task", () => {
  const result = consolidateExecutionGraph({
    commitments: [commitment("website", "Deliver the website")],
    tasks: [
      candidateTask("t1", "Create product page wireframes"),
      candidateTask("t2", "Design product catalog interface"),
      candidateTask("t3", "Design initial product page layouts")
    ]
  });
  assert.equal(result.graph.tasks.length, 1);
});

test("task owners do not inherit from the commitment lead", () => {
  const resolved = resolveAssigneesAndDueDates({
    commitments: [commitment("website", "Deliver the website")],
    tasks: [
      candidateTask("aditya", "Build website shell", { owner: "Aditya" }),
      candidateTask("jamileh", "Send product images", {
        owner: "Jamileh",
        owners: ["Jamileh"]
      }),
      candidateTask("unknown", "Confirm MVP scope", { owner: null, owners: [] })
    ]
  });
  assert.deepEqual(
    resolved.tasks.map((item) => item.owner),
    ["Aditya", "Jamileh", null]
  );
});

test("required website inputs link to the website outcome without changing owner", () => {
  const linked = linkTasksToCommitments({
    commitments: [
      commitment(
        "website",
        "Develop and deliver the first working e-commerce website"
      )
    ],
    tasks: [
      candidateTask("images", "Send product images to the web developer", {
        commitment_ref: null,
        owner: "Jamileh",
        owners: ["Jamileh"]
      })
    ]
  });
  assert.equal(linked.tasks[0].commitment_ref, "website");
  assert.equal(linked.tasks[0].owner, "Jamileh");
});

test("people derive from task owners and manual participants; unassigned group is last", () => {
  const tasks = [
    storedTask("u", null, 2),
    storedTask("j", "Jamileh", 1),
    storedTask("a", "Aditya", 0)
  ];
  const participant: CommitmentParticipant = {
    id: "participant-1",
    commitment_id: "commitment-1",
    participant_user_id: null,
    participant_name: "Reviewer",
    involvement_role: "reviewer",
    manually_added: true,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z"
  };
  assert.deepEqual(
    deriveCommitmentPeople({
      commitment: storedCommitment(),
      tasks,
      participants: [participant]
    }),
    ["Aditya", "Jamileh", "Reviewer"]
  );
  assert.deepEqual(
    groupCommitmentTasksByOwner(tasks).map((group) => group.owner),
    ["Aditya", "Jamileh", null]
  );
});

test("participant persistence and workspace/meeting UI preserve requested boundaries", async () => {
  const [migration, workspace, meetingPage] = await Promise.all([
    readFile(
      new URL(
        "../supabase/migrations/20260727120000_add_commitment_people.sql",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL("../components/commitment-workspace.tsx", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../app/meetings/[id]/page.tsx", import.meta.url), "utf8")
  ]);
  assert.match(migration, /commitment_participants/);
  assert.match(migration, /manually_added boolean not null default true/);
  assert.match(workspace, /sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4/);
  assert.match(workspace, /href=\{`\/tasks\/\$\{task\.id\}` as Route\}/);
  assert.doesNotMatch(meetingPage, /<ExecutionDashboard/);
  assert.match(meetingPage, /<StandaloneTasksPanel tasks=\{partitioned\.standaloneTasks\}/);
  // TopicResults no longer accepts a tasks prop at all (Phase 8 removed the always-empty,
  // never-rendering ActionItemsPanel it used to feed) -- tasks stay scoped to the Commitments/
  // Standalone Tasks/Future Scope panels above, never duplicated into the Topics disclosure.
  assert.match(meetingPage, /<TopicResults topics=\{typedTopics\} insights=\{insights \?\? \[\]\} \/>/);
});
