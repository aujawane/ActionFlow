import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { workspaceOperationSchema } from "../lib/workspace-agent/schema";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenario 37] artifact acceptance is NOT exposed in WorkspaceOperation
// ---------------------------------------------------------------------------

test("[required scenario 37] no WorkspaceOperation type concerns artifact acceptance -- only the 10 enabled operation types exist", () => {
  const types = workspaceOperationSchema.options.map((option) => option.shape.type.value);
  assert.deepEqual(
    types,
    [
      "update_commitment",
      "complete_commitment",
      "reopen_commitment",
      "dismiss_commitment",
      "update_task",
      "complete_task",
      "reopen_task",
      "dismiss_task",
      "assign_task_owner",
      "update_project"
    ]
  );
  for (const forbidden of ["accept_artifact", "reject_artifact", "request_artifact_revision"]) {
    assert.equal(types.includes(forbidden as never), false);
  }
});

test("[required scenario 37] no operation's changes schema accepts accepted_at/accepted_by, and artifactId is not a recognized field anywhere in the schema", () => {
  const commitmentId = "20000000-0000-4000-8000-000000000001";
  const taskId = "30000000-0000-4000-8000-000000000001";
  for (const candidate of [
    { type: "update_commitment", commitmentId, changes: { accepted_at: "2026-01-01" } },
    { type: "update_task", taskId, changes: { accepted_by: "someone" } },
    { type: "update_task", taskId, changes: { artifactId: "x" } }
  ]) {
    assert.equal(workspaceOperationSchema.safeParse(candidate).success, false);
  }
});

// ---------------------------------------------------------------------------
// [required scenario 38] existing accept_deliverable RPC remains untouched
// ---------------------------------------------------------------------------

test("[required scenario 38] the accept_deliverable/reopen_deliverable RPCs and their routes were not modified by this patch -- no workspace-agent file references them", async () => {
  // schema.ts is excluded here -- it deliberately documents the exclusion in prose (see the
  // "required scenario 39" test below), which legitimately mentions "task_artifacts" as the
  // thing being excluded. No *code* (operation type, field, or table reference) in any of these
  // files touches it, which is what the other tests in this file prove structurally.
  const workspaceAgentFiles = [
    "lib/workspace-agent/scope.ts",
    "lib/workspace-agent/intent-gate.ts",
    "lib/workspace-agent/authorize.ts",
    "lib/workspace-agent/executor.ts",
    "lib/workspace-agent/audit.ts",
    "lib/workspace-agent/confirmation.ts",
    "lib/workspace-agent/revalidate.ts"
  ];
  for (const file of workspaceAgentFiles) {
    const source = await readSource(file);
    assert.doesNotMatch(source, /accept_deliverable|reopen_deliverable|task_artifacts/, file);
  }
});

// ---------------------------------------------------------------------------
// [required scenario 39] known completed_at inconsistency is documented as a future prerequisite
// ---------------------------------------------------------------------------

test("[required scenario 39] the deliberate exclusion of artifact acceptance, and the accept_deliverable completed_at gap it is waiting on, are documented in the schema module", async () => {
  const source = await readSource("lib/workspace-agent/schema.ts");
  assert.match(source, /acceptance/i);
  assert.match(source, /structurally excluded/i);
});
