import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaceConfirmationMessage, type ConfirmedEntityChange } from "../lib/workspace-agent/confirmation";

function commitmentChange(overrides: Partial<ConfirmedEntityChange> = {}): ConfirmedEntityChange {
  return {
    kind: "commitment",
    title: "Launch website",
    before: { status: "pending" },
    after: { status: "pending" },
    changes: {},
    ...overrides
  };
}

test("a single field edit produces a concise Done confirmation naming the entity, never raw JSON or IDs", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ changes: { due_date: "2026-10-16" } })
  ]);
  assert.match(message, /^Done — /);
  assert.match(message, /Launch website/);
  assert.match(message, /due date/);
  assert.doesNotMatch(message, /\{|\}|commitmentId|taskId|projectId|20000000-0000-4000-8000/);
});

test("multiple fields on one entity join into one sentence", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ changes: { owner: "Kevin", due_date: "2026-10-16" } })
  ]);
  assert.match(message, /Kevin/);
  assert.match(message, / and /);
});

test("mark-complete confirmation says 'marked it complete', not a raw status value", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ before: { status: "pending" }, after: { status: "completed" }, changes: { status: "completed" } })
  ]);
  assert.match(message, /marked it complete/);
  assert.doesNotMatch(message, /"completed"/);
});

test("reopen confirmation says 'reopened it'", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ before: { status: "completed" }, after: { status: "pending" }, changes: { status: "pending" } })
  ]);
  assert.match(message, /reopened it/);
});

test("task confirmations use the task title field, not the commitment title field", () => {
  const message = buildWorkspaceConfirmationMessage([
    { kind: "task", title: "Write onboarding doc", before: { status: "pending" }, after: { status: "completed" }, changes: { status: "completed" } }
  ]);
  assert.match(message, /Write onboarding doc/);
  assert.match(message, /marked it complete/);
});

test("project confirmations use generic status phrasing, not completion/reopen framing", () => {
  const message = buildWorkspaceConfirmationMessage([
    { kind: "project", title: "Jamileh", before: { status: "planning" }, after: { status: "active" }, changes: { status: "active" } }
  ]);
  assert.match(message, /set the status to active/);
  assert.doesNotMatch(message, /marked it complete|reopened it/);
});

test("confirmation for multiple entities lists each by title", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ title: "Launch website", changes: { priority: "high" } }),
    { kind: "task", title: "Order the chip", before: { status: "pending" }, after: { status: "completed" }, changes: { status: "completed" } }
  ]);
  assert.match(message, /Launch website/);
  assert.match(message, /Order the chip/);
});

test("rename clause quotes the new title", () => {
  const message = buildWorkspaceConfirmationMessage([
    commitmentChange({ changes: { title: "MVP workflow" } })
  ]);
  assert.match(message, /renamed it to "MVP workflow"/);
});
