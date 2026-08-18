import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingAssistantExecutionContext } from "../lib/meeting-assistant/context";
import type {
  ExtractedInsight,
  Meeting,
  MeetingCommitment,
  MeetingTask,
  MeetingTopic,
  TaskArtifact,
  TaskDependency
} from "../lib/types";

let taskCounter = 0;
let commitmentCounter = 0;

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    user_id: "user-1",
    project_id: null,
    title: "Summer Labbies sync",
    meeting_url: "https://example.com/meet",
    platform: "google_meet",
    recall_bot_id: null,
    status: "completed",
    is_pinned: false,
    deleted_at: null,
    execution_graph_generation: 2,
    last_persisted_execution_generation: 2,
    created_at: "2026-08-01T15:00:00Z",
    updated_at: "2026-08-01T15:00:00Z",
    ...overrides
  };
}

function commitment(overrides: Partial<MeetingCommitment> = {}): MeetingCommitment {
  commitmentCounter += 1;
  return {
    id: `commitment-${commitmentCounter}`,
    meeting_id: "meeting-1",
    project_id: null,
    topic_id: null,
    title: `Commitment ${commitmentCounter}`,
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: null,
    source_segment_ids: [],
    type: "assignment",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    created_at: "2026-08-01T15:00:00Z",
    updated_at: "2026-08-01T15:00:00Z",
    ...overrides
  };
}

function task(overrides: Partial<MeetingTask> = {}): MeetingTask {
  taskCounter += 1;
  return {
    id: `task-${taskCounter}`,
    meeting_id: "meeting-1",
    project_id: null,
    topic_id: null,
    commitment_id: null,
    task: `Task ${taskCounter}`,
    owner: null,
    owners: [],
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    due_date: null,
    inferred: false,
    extraction_metadata: null,
    execution_classification: "committed",
    workspace_type: "other",
    workspace_summary: null,
    created_at: "2026-08-01T15:00:00Z",
    ...overrides
  };
}

const baseInput = {
  meeting: meeting(),
  project: null,
  transcriptParticipants: [] as Array<{ participant_name: string | null; speaker: string | null }>,
  topics: [] as MeetingTopic[],
  insights: [] as ExtractedInsight[],
  dependencies: [] as TaskDependency[],
  artifacts: [] as TaskArtifact[]
};

// 1. includes current commitments
test("context: includes current, active commitments with owner/progress/due date/priority/acceptance criteria", () => {
  const shopify = commitment({
    id: "c1",
    title: "Build the Shopify website",
    owner: "Aditya Ujawane",
    due_date: "2026-09-01",
    priority: "high",
    metadata: { acceptance_criteria: [{ title: "Site is live" }, { title: "Content approved" }] }
  });
  const t = task({ id: "t1", commitment_id: "c1", status: "completed" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [shopify],
    tasks: [t]
  });
  assert.equal(context.commitments.length, 1);
  const found = context.commitments[0];
  assert.equal(found.title, "Build the Shopify website");
  assert.equal(found.owner, "Aditya Ujawane");
  assert.equal(found.due_date, "2026-09-01");
  assert.equal(found.priority, "high");
  assert.deepEqual(found.acceptance_criteria, ["Site is live", "Content approved"]);
  assert.deepEqual(found.progress, { completed: 1, total: 1, percent: 100 });
});

// 2. includes current tasks (linked)
test("context: includes current linked tasks with commitment title and scope", () => {
  const c = commitment({ id: "c1", title: "Build the Shopify website" });
  const linked = task({ id: "t1", commitment_id: "c1", task: "Create Shopify account" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [c],
    tasks: [linked]
  });
  const found = context.tasks.find((item) => item.id === "t1");
  assert.ok(found);
  assert.equal(found?.scope, "linked");
  assert.equal(found?.commitment_id, "c1");
  assert.equal(found?.commitment_title, "Build the Shopify website");
});

// 3. includes standalone tasks
test("context: includes standalone tasks with scope='standalone' and null commitment fields", () => {
  const standalone = task({ id: "t1", commitment_id: null, task: "Send calendar invite" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [standalone]
  });
  const found = context.tasks.find((item) => item.id === "t1");
  assert.ok(found);
  assert.equal(found?.scope, "standalone");
  assert.equal(found?.commitment_id, null);
  assert.equal(found?.commitment_title, null);
});

// 4. includes Future Scope
test("context: includes Future Scope commitments and tasks separately from active work", () => {
  const futureCommitment = commitment({
    id: "c1",
    title: "Add e-commerce checkout",
    execution_classification: "future_consideration"
  });
  const futureTask = task({
    id: "t1",
    task: "Explore subscription billing",
    execution_classification: "proposed"
  });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [futureCommitment],
    tasks: [futureTask]
  });
  assert.equal(context.commitments.length, 0);
  assert.equal(context.tasks.length, 0);
  assert.equal(context.future_scope.length, 2);
  assert.ok(context.future_scope.some((item) => item.title === "Add e-commerce checkout"));
  assert.ok(context.future_scope.some((item) => item.title === "Explore subscription billing"));
});

// 5. includes dependency/blocker information
test("context: a task depending on an incomplete prerequisite is marked blocked with the blocker's title", () => {
  const account = task({ id: "t1", task: "Create Shopify account", status: "pending" });
  const build = task({ id: "t2", task: "Begin building the website", status: "pending" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [account, build],
    dependencies: [{ task_id: "t2", depends_on_task_id: "t1", created_at: "2026-08-01T00:00:00Z" }]
  });
  const blocked = context.tasks.find((item) => item.id === "t2");
  assert.equal(blocked?.is_blocked, true);
  assert.equal(blocked?.blocked_by, "Create Shopify account");
});

test("context: a completed prerequisite unblocks the dependent task", () => {
  const account = task({ id: "t1", task: "Create Shopify account", status: "completed" });
  const build = task({ id: "t2", task: "Begin building the website", status: "pending" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [account, build],
    dependencies: [{ task_id: "t2", depends_on_task_id: "t1", created_at: "2026-08-01T00:00:00Z" }]
  });
  const unblocked = context.tasks.find((item) => item.id === "t2");
  assert.equal(unblocked?.is_blocked, false);
  assert.equal(unblocked?.blocked_by, null);
});

// 6. includes participants
test("context: meeting.participants reflects Recall participants and extracted owners", () => {
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [commitment({ owner: "Craig Lauer" })],
    tasks: [task({ owner: "Aditya Ujawane" })],
    transcriptParticipants: [{ participant_name: "Laura Wetherhold", speaker: "Laura Wetherhold" }]
  });
  assert.deepEqual(
    [...context.meeting.participants].sort(),
    ["Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"].sort()
  );
});

// 7. stale-generation work excluded
test("context: excludes commitments/tasks stamped with an older analysis generation than the meeting's current one", () => {
  const currentCommitment = commitment({
    id: "c1",
    title: "Current commitment",
    metadata: { analysis_generation: 2 }
  });
  const staleCommitment = commitment({
    id: "c2",
    title: "Stale commitment",
    metadata: { analysis_generation: 1 }
  });
  const currentTask = task({ id: "t1", task: "Current task", extraction_metadata: { analysis_generation: 2 } });
  const staleTask = task({ id: "t2", task: "Stale task", extraction_metadata: { analysis_generation: 1 } });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    meeting: meeting({ execution_graph_generation: 2 }),
    commitments: [currentCommitment, staleCommitment],
    tasks: [currentTask, staleTask]
  });
  assert.deepEqual(context.commitments.map((item) => item.title), ["Current commitment"]);
  assert.deepEqual(context.tasks.map((item) => item.title), ["Current task"]);
});

// 8. manually corrected owner wins over transcript attribution
test("context: uses the task's current (possibly manually corrected) owner field, never re-derives ownership from source_quote/transcript text", () => {
  const corrected = task({
    id: "t1",
    task: "Begin building the website",
    owner: "Aditya Ujawane",
    source_quote: "Didier said he would start on the website once the account exists."
  });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [corrected]
  });
  const found = context.tasks.find((item) => item.id === "t1");
  assert.equal(found?.owner, "Aditya Ujawane");
  // The transcript-derived text is preserved as evidence, but only ownership itself is asserted
  // by the canonical `owner` field above -- the model is instructed (see agent.ts SYSTEM_PROMPT)
  // to treat this field, not source_quote, as authoritative.
  assert.equal(found?.source_quote, "Didier said he would start on the website once the account exists.");
});

// 9. completed task state represented correctly
test("context: a completed task's status is passed through as 'completed', not filtered out", () => {
  // A completed STANDALONE task is intentionally excluded from execution lists app-wide (see
  // isTaskExecutable / the Standalone Tasks panel it also feeds) -- use a linked task, which has
  // no such exclusion, to isolate "is completed status represented" from that unrelated rule.
  const c = commitment({ id: "c1", title: "Ship the newsletter" });
  const done = task({ id: "t1", commitment_id: "c1", task: "Send calendar invite", status: "completed" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [c],
    tasks: [done]
  });
  const found = context.tasks.find((item) => item.id === "t1");
  assert.equal(found?.status, "completed");
});

// 10. 100%-tasks/open-commitment distinction preserved
test("context: a commitment with 100% complete child tasks but a non-'completed' status is NOT reported as complete -- progress and status stay separate facts", () => {
  const c = commitment({ id: "c1", title: "Build the Shopify website", status: "in_progress" });
  const t1 = task({ id: "t1", commitment_id: "c1", status: "completed" });
  const t2 = task({ id: "t2", commitment_id: "c1", status: "completed" });
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [c],
    tasks: [t1, t2]
  });
  const found = context.commitments[0];
  assert.equal(found.progress.percent, 100);
  assert.equal(found.status, "in_progress");
  assert.notEqual(found.status, "completed");
});

// Deliverables: current-only (section 37)
test("context: deliverables reflect only the current version per (task, deliverable_type), never historical versions", () => {
  const t = task({ id: "t1", task: "Draft the FAQ" });
  const artifacts: TaskArtifact[] = [
    {
      id: "a1",
      task_id: "t1",
      artifact_type: "Document Draft",
      deliverable_type: "document_draft",
      title: "FAQ v1",
      content: "old content",
      version: 1,
      status: "generated",
      accepted_at: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z"
    },
    {
      id: "a2",
      task_id: "t1",
      artifact_type: "Document Draft",
      deliverable_type: "document_draft",
      title: "FAQ v2",
      content: "new content",
      version: 2,
      status: "generated",
      accepted_at: "2026-08-02T00:00:00Z",
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z"
    }
  ];
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [t],
    artifacts
  });
  assert.equal(context.deliverables.length, 1);
  assert.equal(context.deliverables[0].title, "FAQ v2");
  assert.equal(context.deliverables[0].state, "accepted");
});

test("context: decisions come from insights with category 'decisions'; other insights stay separate", () => {
  const insights: ExtractedInsight[] = [
    {
      id: "i1",
      meeting_id: "meeting-1",
      topic_id: null,
      category: "decisions",
      content: "We will use an FAQ section instead of a chatbot.",
      confidence: 0.9,
      created_at: "2026-08-01T00:00:00Z"
    },
    {
      id: "i2",
      meeting_id: "meeting-1",
      topic_id: null,
      category: "risks",
      content: "Domain transfer could take a few days.",
      confidence: 0.7,
      created_at: "2026-08-01T00:00:00Z"
    }
  ];
  const context = buildMeetingAssistantExecutionContext({
    ...baseInput,
    commitments: [],
    tasks: [],
    insights
  });
  assert.deepEqual(context.decisions, ["We will use an FAQ section instead of a chatbot."]);
  assert.equal(context.insights.length, 1);
  assert.equal(context.insights[0].category, "risks");
});
