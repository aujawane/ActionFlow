import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { workspaceOperationSchema } from "../lib/workspace-agent/schema";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const commitmentId = "20000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// [required scenario 6] valid update_commitment accepted
// ---------------------------------------------------------------------------

test("[required scenario 6] a valid update_commitment operation is accepted", () => {
  const result = workspaceOperationSchema.safeParse({
    type: "update_commitment",
    commitmentId,
    changes: { title: "Launch website", due_date: "2026-10-16", priority: "high" }
  });
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// [required scenario 7] valid complete/reopen/dismiss commitment accepted
// ---------------------------------------------------------------------------

test("[required scenario 7] complete_commitment, reopen_commitment, and dismiss_commitment are each accepted with just a commitmentId", () => {
  for (const type of ["complete_commitment", "reopen_commitment", "dismiss_commitment"]) {
    const result = workspaceOperationSchema.safeParse({ type, commitmentId });
    assert.equal(result.success, true, `${type} should be accepted`);
  }
});

// ---------------------------------------------------------------------------
// [required scenario 8] valid update_task accepted
// ---------------------------------------------------------------------------

test("[required scenario 8] a valid update_task operation is accepted", () => {
  const result = workspaceOperationSchema.safeParse({
    type: "update_task",
    taskId,
    changes: { task: "Write onboarding doc", owner: "Kevin", status: "in_progress" }
  });
  assert.equal(result.success, true);
});

test("assign_task_owner accepts a name or an explicit null (unassign)", () => {
  assert.equal(
    workspaceOperationSchema.safeParse({ type: "assign_task_owner", taskId, owner: "Kevin" }).success,
    true
  );
  assert.equal(
    workspaceOperationSchema.safeParse({ type: "assign_task_owner", taskId, owner: null }).success,
    true
  );
});

// ---------------------------------------------------------------------------
// [required scenario 9] valid complete/reopen/dismiss task accepted
// ---------------------------------------------------------------------------

test("[required scenario 9] complete_task, reopen_task, and dismiss_task are each accepted with just a taskId", () => {
  for (const type of ["complete_task", "reopen_task", "dismiss_task"]) {
    const result = workspaceOperationSchema.safeParse({ type, taskId });
    assert.equal(result.success, true, `${type} should be accepted`);
  }
});

// ---------------------------------------------------------------------------
// [required scenario 10] unsupported fields rejected
// ---------------------------------------------------------------------------

test("[required scenario 10] unsupported fields are rejected on every changes object", () => {
  const cases = [
    { type: "update_commitment", commitmentId, changes: { meeting_id: "x" } },
    { type: "update_commitment", commitmentId, changes: { completion_state: "completed" } },
    { type: "update_commitment", commitmentId, changes: { manual_override_fields: ["title"] } },
    { type: "update_task", taskId, changes: { commitment_id: commitmentId } },
    { type: "update_task", taskId, changes: { task_type: "coding" } },
    { type: "update_project", projectId, changes: { owner_id: "someone" } }
  ];
  for (const candidate of cases) {
    assert.equal(workspaceOperationSchema.safeParse(candidate).success, false, JSON.stringify(candidate));
  }
});

test("unknown operation types are rejected entirely", () => {
  const result = workspaceOperationSchema.safeParse({ type: "delete_project", projectId });
  assert.equal(result.success, false);
});

test("create_commitment, create_task, and move_task are deliberately not part of the V1 schema", () => {
  for (const type of ["create_commitment", "create_task", "move_task"]) {
    const result = workspaceOperationSchema.safeParse({
      type,
      commitmentId,
      taskId,
      changes: {}
    });
    assert.equal(result.success, false, `${type} should not be accepted yet`);
  }
});

// ---------------------------------------------------------------------------
// [required scenario 11] acceptance fields structurally impossible
// ---------------------------------------------------------------------------

test("[required scenario 11] acceptance fields are rejected on every entity's changes object", () => {
  for (const field of ["accepted_at", "accepted_by"]) {
    assert.equal(
      workspaceOperationSchema.safeParse({
        type: "update_commitment",
        commitmentId,
        changes: { [field]: "2026-01-01" }
      }).success,
      false
    );
    assert.equal(
      workspaceOperationSchema.safeParse({
        type: "update_task",
        taskId,
        changes: { [field]: "2026-01-01" }
      }).success,
      false
    );
  }
});

// ---------------------------------------------------------------------------
// Invalid field VALUES (not just unsupported field names) are still rejected.
// ---------------------------------------------------------------------------

test("invalid priority/status/date values are rejected", () => {
  assert.equal(
    workspaceOperationSchema.safeParse({
      type: "update_commitment",
      commitmentId,
      changes: { priority: "urgent" }
    }).success,
    false
  );
  assert.equal(
    workspaceOperationSchema.safeParse({
      type: "update_task",
      taskId,
      changes: { status: "archived" }
    }).success,
    false
  );
  assert.equal(
    workspaceOperationSchema.safeParse({
      type: "update_commitment",
      commitmentId,
      changes: { due_date: "10/16/2026" }
    }).success,
    false
  );
});

test("update_project mirrors the existing updateProjectSchema field set exactly", async () => {
  assert.equal(
    workspaceOperationSchema.safeParse({
      type: "update_project",
      projectId,
      changes: { name: "Renamed project", status: "active" }
    }).success,
    true
  );
  const routeSource = await readSource("app/api/projects/[id]/route.ts");
  assert.match(routeSource, /name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(160\)\.optional\(\)/);
});
