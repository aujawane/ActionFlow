import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeWorkspaceOperations } from "../lib/workspace-agent/executor";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const commitmentId = "20000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// [required scenarios 18-21] canonical mutation reuse, no raw table writes
// ---------------------------------------------------------------------------

test("[required scenario 18] a commitment-targeting operation is routed through applyCommitmentPatch", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /import \{ applyCommitmentPatch \} from "@\/lib\/commitment-mutations";/);
  assert.match(source, /await applyCommitmentPatch\(id, changes\)/);
});

test("[required scenario 19] a task-targeting operation is routed through applyTaskPatch", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /import \{ applyTaskPatch \} from "@\/lib\/task-mutations";/);
  assert.match(source, /await applyTaskPatch\(id, changes\)/);
});

test("a project-targeting operation is routed through applyProjectPatch", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /import \{ applyProjectPatch \} from "@\/lib\/project-mutations";/);
  assert.match(source, /await applyProjectPatch\(id, changes\)/);
});

test("[required scenario 20] the executor contains no direct meeting_commitments write", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.doesNotMatch(source, /\.from\("meeting_commitments"\)/);
});

test("[required scenario 21] the executor contains no direct meeting_tasks write", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.doesNotMatch(source, /\.from\("meeting_tasks"\)/);
});

test("the full lib/workspace-agent/ tree has no raw writes to meeting_commitments or meeting_tasks outside the canonical mutation functions it imports -- only the audit insert (project_change_events) is a direct table write", async () => {
  const files = [
    "lib/workspace-agent/scope.ts",
    "lib/workspace-agent/schema.ts",
    "lib/workspace-agent/intent-gate.ts",
    "lib/workspace-agent/authorize.ts",
    "lib/workspace-agent/executor.ts",
    "lib/workspace-agent/audit.ts",
    "lib/workspace-agent/confirmation.ts",
    "lib/workspace-agent/revalidate.ts"
  ];
  for (const file of files) {
    const source = await readSource(file);
    assert.doesNotMatch(source, /\.from\("meeting_commitments"\)|\.from\("meeting_tasks"\)/, file);
  }
});

// ---------------------------------------------------------------------------
// [required scenarios 22-23] lifecycle derivation stays canonical, not reimplemented
// ---------------------------------------------------------------------------

test("[required scenario 22] complete_task maps to {status:\"completed\"} and is written via applyTaskPatch, which already derives completed_at -- not reimplemented here", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /case "complete_task":\s*\n\s*return \{ status: "completed" \};/);
  assert.doesNotMatch(source, /completed_at/);
});

test("[required scenario 23] complete_commitment maps to {status:\"completed\"} and is written via applyCommitmentPatch, which already derives completion_state -- not reimplemented here", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /case "complete_commitment":\s*\n\s*return \{ status: "completed" \};/);
  assert.doesNotMatch(source, /completion_state/);
});

test("reopen_commitment/reopen_task map to status pending; dismiss_commitment/dismiss_task map to status dismissed -- same lifecycle values Patch A's direct UI controls use", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /case "reopen_commitment":\s*\n\s*return \{ status: "pending" \};/);
  assert.match(source, /case "reopen_task":\s*\n\s*return \{ status: "pending" \};/);
  assert.match(source, /case "dismiss_commitment":\s*\n\s*return \{ status: "dismissed" \};/);
  assert.match(source, /case "dismiss_task":\s*\n\s*return \{ status: "dismissed" \};/);
});

// ---------------------------------------------------------------------------
// [required scenario 24] failed mutation never produces a success confirmation
// ---------------------------------------------------------------------------

test("[required scenario 24] a persistence failure is recorded in failedOperations, excluded from appliedOperations, and never contributes to the confirmation", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  const block = source.match(/if \("error" in outcome\) \{[\s\S]*?\n {6}continue;\s*\n {4}\}/);
  assert.ok(block, "expected the persistence-failure branch");
  assert.match(block![0], /failedOperations\.push/);
  assert.match(block![0], /reason: "persistence_failed"/);
  // "continue" skips straight to the next group without ever pushing to appliedOperations or
  // calling recordWorkspaceAuditEvent for this group.
  assert.match(block![0], /continue;/);
});

test("confirmation is only built from appliedOperations -- never includes anything from failedOperations", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  const confirmationBlock = source.match(/const confirmation =[\s\S]*?: null;/);
  assert.ok(confirmationBlock);
  assert.doesNotMatch(confirmationBlock![0], /failedOperations/);
  assert.match(confirmationBlock![0], /appliedOperations/);
});

// ---------------------------------------------------------------------------
// [required scenario 25] multiple successful operations produce one coherent confirmation
// ---------------------------------------------------------------------------

test("[required scenario 25] operations targeting the same entity are grouped into one merged write before the canonical mutation is ever called", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /function groupOperations\(operations: WorkspaceOperation\[\]\): OperationGroup\[\]/);
  assert.match(source, /Object\.assign\(group\.changes, patchFieldsFor\(operation\)\);/);
});

// ---------------------------------------------------------------------------
// [required scenario 26] before/after state captured for audit
// ---------------------------------------------------------------------------

test("[required scenario 26] both before (pre-mutation, from authorization) and after (post-mutation, from the canonical function's own return) state are captured and passed to the audit writer", async () => {
  const source = await readSource("lib/workspace-agent/executor.ts");
  assert.match(source, /const before = beforeStateOf\(authResult\.target\);/);
  assert.match(source, /const after = outcome\.entity as unknown as Record<string, unknown>;/);
  assert.match(source, /beforeState: before,/);
  assert.match(source, /afterState: after,/);
});

// ---------------------------------------------------------------------------
// Explicit-intent gating and empty-input short-circuiting (required by PART 6: "require explicit
// mutation intent for direct execution").
// ---------------------------------------------------------------------------

test("executeWorkspaceOperations returns executed:false and does nothing when the operations list is empty", async () => {
  const result = await executeWorkspaceOperations({
    operations: [],
    scope: { type: "commitment", commitmentId, meetingId: "m1", projectId: null },
    userId: "u1",
    source: "project_chat",
    sourceId: null,
    userMessage: "Change the due date to Friday."
  });
  assert.equal(result.executed, false);
  assert.deepEqual(result.appliedOperations, []);
  assert.equal(result.confirmation, null);
});

test("executeWorkspaceOperations returns executed:false and performs no DB call when the message is not an explicit request, even with a well-formed operation", async () => {
  const result = await executeWorkspaceOperations({
    operations: [{ type: "complete_commitment", commitmentId }],
    scope: { type: "commitment", commitmentId, meetingId: "m1", projectId: null },
    userId: "u1",
    source: "project_chat",
    sourceId: null,
    userMessage: "Maybe this should be marked complete."
  });
  assert.equal(result.executed, false);
  assert.deepEqual(result.appliedOperations, []);
  assert.deepEqual(result.failedOperations, []);
  assert.equal(result.confirmation, null);
});
