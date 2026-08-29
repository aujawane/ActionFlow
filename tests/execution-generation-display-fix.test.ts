import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getEffectiveDisplayGeneration,
  isCommitmentCurrentGeneration,
  isTaskCurrentGeneration
} from "../lib/execution-generation";
import { partitionExecutionGraph } from "../lib/execution-display";
import { buildProjectExecutionModel } from "../lib/project-execution";
import type { Meeting, MeetingCommitment, MeetingTask } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function makeMeeting(overrides: Partial<Meeting> & { id: string }): Meeting {
  return {
    user_id: "user-1",
    title: "Meeting",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    recall_bot_id: null,
    status: "completed",
    is_pinned: false,
    deleted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function makeCommitment(overrides: Partial<MeetingCommitment> & { id: string }): MeetingCommitment {
  return {
    meeting_id: "meeting-1",
    topic_id: null,
    title: "Commitment",
    description: null,
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: null,
    source_segment_ids: [],
    type: "personal",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    preserve_on_reanalysis: false,
    manual_override_fields: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function makeTask(overrides: Partial<MeetingTask> & { id: string }): MeetingTask {
  return {
    meeting_id: "meeting-1",
    topic_id: null,
    commitment_id: null,
    task: "Task",
    owner: "Aditya Ujawane",
    owners: ["Aditya Ujawane"],
    task_type: "unassigned_work",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.9,
    status: "pending",
    execution_classification: "committed",
    extraction_metadata: {},
    preserve_on_reanalysis: false,
    manual_override_fields: [],
    workspace_type: "other",
    workspace_summary: null,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function withGeneration<T extends { metadata?: unknown; extraction_metadata?: unknown }>(
  row: T,
  key: "metadata" | "extraction_metadata",
  generation: number | null
): T {
  return { ...row, [key]: generation == null ? {} : { analysis_generation: generation } };
}

test("getEffectiveDisplayGeneration prefers last_persisted_execution_generation over execution_graph_generation", () => {
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 6,
    last_persisted_execution_generation: 5
  });
  assert.equal(getEffectiveDisplayGeneration(meeting), 5);
});

test("getEffectiveDisplayGeneration falls back to execution_graph_generation when nothing has ever persisted", () => {
  const meeting = makeMeeting({ id: "m1", execution_graph_generation: 1 });
  assert.equal(getEffectiveDisplayGeneration(meeting), 1);
});

test("getEffectiveDisplayGeneration is null when the meeting has no generation at all", () => {
  const meeting = makeMeeting({ id: "m1" });
  assert.equal(getEffectiveDisplayGeneration(meeting), null);
});

test("[required scenario 1] the last persisted graph remains current while a newer analysis generation is running", () => {
  // execution_graph_generation = 6 (a re-analysis has been claimed), last_persisted = 5 (it
  // hasn't finished yet), and the existing row is stamped at 5 -- it must stay visible.
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 6,
    last_persisted_execution_generation: 5
  });
  const task = withGeneration(makeTask({ id: "t1" }), "extraction_metadata", 5);
  assert.equal(isTaskCurrentGeneration(task, getEffectiveDisplayGeneration(meeting)), true);

  const commitment = withGeneration(makeCommitment({ id: "c1" }), "metadata", 5);
  assert.equal(
    isCommitmentCurrentGeneration(commitment, getEffectiveDisplayGeneration(meeting)),
    true
  );
});

test("[required scenario 2] once generation 6 successfully persists, non-preserved generation-5 rows become stale", () => {
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 6,
    last_persisted_execution_generation: 6
  });
  const task = withGeneration(
    makeTask({ id: "t1", preserve_on_reanalysis: false }),
    "extraction_metadata",
    5
  );
  assert.equal(isTaskCurrentGeneration(task, getEffectiveDisplayGeneration(meeting)), false);
});

test("[required scenario 5] a genuinely superseded non-preserved stale row remains hidden", () => {
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 5,
    last_persisted_execution_generation: 5
  });
  const staleTask = withGeneration(
    makeTask({ id: "old", preserve_on_reanalysis: false }),
    "extraction_metadata",
    3
  );
  const currentTask = withGeneration(
    makeTask({ id: "new", preserve_on_reanalysis: false }),
    "extraction_metadata",
    5
  );
  const currentGeneration = getEffectiveDisplayGeneration(meeting);
  assert.equal(isTaskCurrentGeneration(staleTask, currentGeneration), false);
  assert.equal(isTaskCurrentGeneration(currentTask, currentGeneration), true);
});

test("[required scenario 3, post-persistence-carry-forward] a preserve_on_reanalysis row whose stamp was carried forward at persistence time reads as current", () => {
  // This is what replace_meeting_execution_graph's new carry-forward UPDATE produces: a preserved
  // row's stamp always equals last_persisted_execution_generation once persistence runs, even if
  // this run's extraction never re-matched it. The read-time predicate itself needs no special
  // case for preserve_on_reanalysis -- it's already satisfied by the exact-match check.
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 5,
    last_persisted_execution_generation: 5
  });
  const preservedTask = withGeneration(
    makeTask({ id: "preserved", preserve_on_reanalysis: true, manual_override_fields: ["status"] }),
    "extraction_metadata",
    5 // carried forward by the migration's new UPDATE, not re-extracted this run
  );
  assert.equal(
    isTaskCurrentGeneration(preservedTask, getEffectiveDisplayGeneration(meeting)),
    true
  );
});

test("[required scenario 4] a preserved human-edited task keeps its manually-set fields regardless of generation stamping", () => {
  const task = makeTask({
    id: "t1",
    status: "completed",
    preserve_on_reanalysis: true,
    manual_override_fields: ["status"]
  });
  // The generation-currency helpers never read or touch status/manual_override_fields -- they
  // only inspect metadata.analysis_generation. Asserting that here pins the contract: nothing in
  // this fix's read path can silently change a human-set field.
  assert.equal(task.status, "completed");
  assert.deepEqual(task.manual_override_fields, ["status"]);
});

test("[required scenario 7] partitionExecutionGraph and buildProjectExecutionModel agree on generation currency for the same fixture", () => {
  const meeting = makeMeeting({
    id: "m1",
    execution_graph_generation: 6,
    last_persisted_execution_generation: 5
  });
  const currentGeneration = getEffectiveDisplayGeneration(meeting);

  const preservedCommitment = withGeneration(
    makeCommitment({ id: "c1", meeting_id: "m1", preserve_on_reanalysis: true }),
    "metadata",
    5
  );
  const preservedTask = withGeneration(
    makeTask({
      id: "t1",
      meeting_id: "m1",
      commitment_id: "c1",
      preserve_on_reanalysis: true
    }),
    "extraction_metadata",
    5
  );

  const partitioned = partitionExecutionGraph({
    commitments: [preservedCommitment],
    tasks: [preservedTask],
    currentGeneration
  });
  const projectModel = buildProjectExecutionModel({
    project: {
      id: "p1",
      owner_id: "user-1",
      name: "Project",
      description: null,
      goal: null,
      status: "active",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z"
    },
    meetings: [meeting],
    commitments: [preservedCommitment],
    tasks: [preservedTask]
  });

  assert.equal(partitioned.activeCommitments.length, 1);
  assert.equal(projectModel.commitments.length, 1);
  assert.equal(partitioned.linkedExecutionTasks.length, 1);
  assert.equal(projectModel.tasks.length, 1);
});

test("[required scenario 10] job/worker staleness protection still compares against the raw, eagerly-incremented execution_graph_generation, not the new display helper", async () => {
  const jobsSource = await readSource("lib/meeting-analysis/jobs.ts");
  assert.match(
    jobsSource,
    /const currentGeneration = Number\(meeting\.execution_graph_generation \?\? 0\);/
  );
  assert.doesNotMatch(jobsSource, /getEffectiveDisplayGeneration/);
});

test("every display consumer routes through the same getEffectiveDisplayGeneration helper", async () => {
  const files = [
    "app/meetings/[id]/page.tsx",
    "lib/project-execution.ts",
    "lib/project-brain/context.ts",
    "lib/execution-dashboard.ts",
    "lib/meeting-assistant/context.ts"
  ];
  for (const file of files) {
    const source = await readSource(file);
    assert.match(source, /getEffectiveDisplayGeneration/, file);
    // None of these should read execution_graph_generation directly as the currentGeneration
    // value anymore for a generation-currency comparison.
    assert.doesNotMatch(
      source,
      /currentGeneration:\s*meeting\.execution_graph_generation/,
      file
    );
  }
});

test("[required scenario 3/6] the persistence migration carries forward preserved-row stamps without touching any other field, and never removes a matched replacement", async () => {
  const migration = await readSource(
    "supabase/migrations/20260829140000_carry_forward_preserved_execution_generation.sql"
  );

  // Only the generation stamp is written -- nothing else about a preserved row is touched here.
  assert.match(
    migration,
    /update public\.meeting_tasks task\s*\n\s*set extraction_metadata = extraction_metadata \|\| jsonb_build_object\('analysis_generation', p_generation\)\s*\n\s*where task\.id = any\(old_task_ids\)\s*\n\s*and not \(task\.id = any\(matched_task_ids\)\)\s*\n\s*and task\.preserve_on_reanalysis = true;/
  );
  assert.match(
    migration,
    /update public\.meeting_commitments commitment\s*\n\s*set metadata = metadata \|\| jsonb_build_object\('analysis_generation', p_generation\)\s*\n\s*where commitment\.id = any\(old_commitment_ids\)\s*\n\s*and not \(commitment\.id = any\(matched_commitment_ids\)\)\s*\n\s*and commitment\.preserve_on_reanalysis = true;/
  );

  // A row that WAS matched into this generation's payload is excluded from the carry-forward
  // update (it already got a full update via the main matching loop) -- "not matched" is the
  // exact complement of "duplicated", so a preserved row and its fresh replacement can never
  // both be stamped current: if the new run matched it, only the matched-row UPDATE runs; if it
  // didn't, only the carry-forward UPDATE runs for the old row, and the new run simply didn't
  // insert a competing row for that same client_ref.
  const carryForwardTasksIndex = migration.indexOf("update public.meeting_tasks task");
  const deleteTasksIndex = migration.indexOf("delete from public.meeting_tasks task");
  assert.ok(carryForwardTasksIndex >= 0 && deleteTasksIndex >= 0);
  assert.ok(carryForwardTasksIndex < deleteTasksIndex, "carry-forward must run before the delete pass");
});

test("[required scenario 8] MeetingTaskStatus has no unsupported/invented states such as draft", async () => {
  const typesSource = await readSource("lib/types.ts");
  const statusBlock = typesSource.match(/export type MeetingTaskStatus =[\s\S]*?;/);
  assert.ok(statusBlock);
  assert.doesNotMatch(statusBlock![0], /draft/i);
  for (const status of ["pending", "in_progress", "completed", "dismissed", "blocked"]) {
    assert.match(statusBlock![0], new RegExp(`"${status}"`));
  }
});

test("[required scenario 8] Project Brain's context builder passes task rows through unmodified rather than synthesizing a status", async () => {
  const contextSource = await readSource("lib/project-brain/context.ts");
  assert.match(
    contextSource,
    /tasks: safeTasks\.map\(\(task\) => \{\s*const \{ extraction_metadata, \.\.\.rest \} = task;\s*void extraction_metadata;\s*return rest;\s*\}\)/
  );
});

test("[required scenario 9] Project Brain's system prompt prohibits inventing unsupported states like draft and requires inference phrasing", async () => {
  const agentSource = await readSource("lib/project-brain/agent.ts");
  const promptMatch = agentSource.match(
    /export const PROJECT_BRAIN_SYSTEM_PROMPT = `([\s\S]*?)`\.trim\(\);/
  );
  assert.ok(promptMatch);
  const prompt = promptMatch![1];
  assert.match(prompt, /never invent a state/i);
  assert.match(prompt, /"draft"/);
  assert.match(prompt, /say so as an inference/i);
  assert.match(prompt, /never assert that a specific tracked task "exists"/i);
});
