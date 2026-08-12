import assert from "node:assert/strict";
import test from "node:test";

import {
  findDeliverableGroup,
  getDeliverableLifecycleState,
  groupDeliverablesByType,
  isAcceptedDeliverable,
  taskHasAcceptedCurrentDeliverable
} from "../lib/task-deliverable-lifecycle";
import type { TaskArtifact, TaskArtifactStatus } from "../lib/types";

let counter = 0;
function artifact(
  overrides: Partial<TaskArtifact> & { status: TaskArtifactStatus }
): TaskArtifact {
  counter += 1;
  return {
    id: `artifact-${counter}`,
    task_id: "task-1",
    artifact_type: "Document Draft",
    deliverable_type: "document_draft",
    title: `Draft ${counter}`,
    content: `Content ${counter}`,
    version: 1,
    accepted_at: null,
    accepted_by: null,
    created_at: new Date(2026, 0, counter).toISOString(),
    updated_at: new Date(2026, 0, counter).toISOString(),
    ...overrides
  };
}

test("getDeliverableLifecycleState: failed status wins regardless of accepted_at", () => {
  assert.equal(
    getDeliverableLifecycleState({ status: "failed", accepted_at: "2026-01-01T00:00:00Z" }),
    "failed"
  );
});

test("getDeliverableLifecycleState: accepted_at present means accepted", () => {
  assert.equal(
    getDeliverableLifecycleState({ status: "edited", accepted_at: "2026-01-01T00:00:00Z" }),
    "accepted"
  );
});

test("getDeliverableLifecycleState: no accepted_at, not failed, means draft", () => {
  assert.equal(getDeliverableLifecycleState({ status: "generated", accepted_at: null }), "draft");
  assert.equal(getDeliverableLifecycleState({ status: "edited", accepted_at: null }), "draft");
});

test("isAcceptedDeliverable", () => {
  const accepted = artifact({ status: "edited", accepted_at: "2026-01-01T00:00:00Z" });
  const draft = artifact({ status: "generated" });
  assert.equal(isAcceptedDeliverable(accepted), true);
  assert.equal(isAcceptedDeliverable(draft), false);
});

test("groupDeliverablesByType: current is the highest-version non-failed row", () => {
  const v1 = artifact({ deliverable_type: "document_draft", version: 1, status: "generated" });
  const v2 = artifact({ deliverable_type: "document_draft", version: 2, status: "edited" });
  const v3 = artifact({ deliverable_type: "document_draft", version: 3, status: "generated" });
  const groups = groupDeliverablesByType([v2, v1, v3]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].current?.id, v3.id);
  assert.deepEqual(groups[0].history.map((item) => item.version), [3, 2, 1]);
});

test("groupDeliverablesByType: a failed latest attempt does not become current, but is reported separately", () => {
  const v1 = artifact({ deliverable_type: "document_draft", version: 1, status: "generated" });
  const v2Failed = artifact({ deliverable_type: "document_draft", version: 2, status: "failed" });
  const groups = groupDeliverablesByType([v1, v2Failed]);
  assert.equal(groups[0].current?.id, v1.id, "the last successful version stays current");
  assert.equal(groups[0].latestFailed?.id, v2Failed.id);
});

test("groupDeliverablesByType: no latestFailed when the newest row is not failed", () => {
  const v1 = artifact({ deliverable_type: "document_draft", version: 1, status: "generated" });
  const groups = groupDeliverablesByType([v1]);
  assert.equal(groups[0].latestFailed, null);
});

test("groupDeliverablesByType: distinct deliverable_types form separate groups", () => {
  const doc = artifact({ deliverable_type: "document_draft", version: 1, status: "generated" });
  const email = artifact({ deliverable_type: "email_draft", version: 1, status: "generated" });
  const groups = groupDeliverablesByType([doc, email]);
  assert.equal(groups.length, 2);
  assert.ok(groups.some((group) => group.deliverableType === "document_draft"));
  assert.ok(groups.some((group) => group.deliverableType === "email_draft"));
});

test("groupDeliverablesByType: a task with only a failed attempt has null current, but the failure is still visible", () => {
  const onlyFailed = artifact({ deliverable_type: "document_draft", version: 1, status: "failed" });
  const groups = groupDeliverablesByType([onlyFailed]);
  assert.equal(groups[0].current, null);
  assert.equal(groups[0].latestFailed?.id, onlyFailed.id);
});

test("findDeliverableGroup: locates a specific type, or null when absent", () => {
  const doc = artifact({ deliverable_type: "document_draft", version: 1, status: "generated" });
  assert.equal(findDeliverableGroup([doc], "document_draft")?.current?.id, doc.id);
  assert.equal(findDeliverableGroup([doc], "email_draft"), null);
});

test("groupDeliverablesByType: empty input returns no groups", () => {
  assert.deepEqual(groupDeliverablesByType([]), []);
});

// ============================================================
// taskHasAcceptedCurrentDeliverable -- the canonical multi-deliverable completion invariant
// (see Phase 7 multi-deliverable audit)
// ============================================================

test("taskHasAcceptedCurrentDeliverable: one accepted current deliverable is sufficient", () => {
  const a = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([a]), true);
});

test("taskHasAcceptedCurrentDeliverable: two accepted current deliverables of different types both count", () => {
  const email = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const research = artifact({
    deliverable_type: "research_report",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-02T00:00:00Z"
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([email, research]), true);
});

test("taskHasAcceptedCurrentDeliverable: no accepted deliverable at all", () => {
  const draft = artifact({ deliverable_type: "email_draft", version: 1, status: "generated" });
  assert.equal(taskHasAcceptedCurrentDeliverable([draft]), false);
});

test("taskHasAcceptedCurrentDeliverable: reopening one of two accepted deliverables leaves the other satisfying the invariant", () => {
  const emailReopened = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: null // just reopened
  });
  const researchStillAccepted = artifact({
    deliverable_type: "research_report",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-02T00:00:00Z"
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([emailReopened, researchStillAccepted]), true);
});

test("taskHasAcceptedCurrentDeliverable: reopening the final accepted current deliverable fails the invariant", () => {
  const onlyOneReopened = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: null
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([onlyOneReopened]), false);
});

test("taskHasAcceptedCurrentDeliverable: a historical accepted version superseded by a current draft does not count", () => {
  const v1AcceptedHistorical = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const v2DraftCurrent = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "edited",
    accepted_at: null
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([v1AcceptedHistorical, v2DraftCurrent]), false);
});

test("taskHasAcceptedCurrentDeliverable: editing accepted A while accepted B exists keeps the invariant satisfied", () => {
  const aV1AcceptedHistorical = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const aV2DraftCurrent = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "edited",
    accepted_at: null
  });
  const bV1AcceptedCurrent = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-02T00:00:00Z"
  });
  assert.equal(
    taskHasAcceptedCurrentDeliverable([aV1AcceptedHistorical, aV2DraftCurrent, bV1AcceptedCurrent]),
    true
  );
});

test("taskHasAcceptedCurrentDeliverable: editing the only accepted deliverable fails the invariant", () => {
  const v1AcceptedHistorical = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const v2DraftCurrent = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "edited",
    accepted_at: null
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([v1AcceptedHistorical, v2DraftCurrent]), false);
});

test("taskHasAcceptedCurrentDeliverable: regenerating accepted A while accepted B exists keeps the invariant satisfied", () => {
  const aV1AcceptedHistorical = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const aV2RegeneratedDraft = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "generated",
    accepted_at: null
  });
  const bV1AcceptedCurrent = artifact({
    deliverable_type: "research_report",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-02T00:00:00Z"
  });
  assert.equal(
    taskHasAcceptedCurrentDeliverable([aV1AcceptedHistorical, aV2RegeneratedDraft, bV1AcceptedCurrent]),
    true
  );
});

test("taskHasAcceptedCurrentDeliverable: regenerating the final accepted deliverable fails the invariant", () => {
  const v1AcceptedHistorical = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const v2RegeneratedDraft = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "generated",
    accepted_at: null
  });
  assert.equal(taskHasAcceptedCurrentDeliverable([v1AcceptedHistorical, v2RegeneratedDraft]), false);
});

test("taskHasAcceptedCurrentDeliverable: a failed version never counts even if it somehow carries accepted_at", () => {
  const failedButFlaggedAccepted = artifact({
    deliverable_type: "document_draft",
    version: 2,
    status: "failed",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const draftV1 = artifact({
    deliverable_type: "document_draft",
    version: 1,
    status: "generated",
    accepted_at: null
  });
  assert.equal(
    taskHasAcceptedCurrentDeliverable([draftV1, failedButFlaggedAccepted]),
    false,
    "the failed row must never be treated as current"
  );
});

test("taskHasAcceptedCurrentDeliverable: different deliverable types are fully independent", () => {
  const emailAccepted = artifact({
    deliverable_type: "email_draft",
    version: 1,
    status: "generated",
    accepted_at: "2026-01-01T00:00:00Z"
  });
  const researchDraftOnly = artifact({
    deliverable_type: "research_report",
    version: 1,
    status: "generated",
    accepted_at: null
  });
  // Accepting/reopening email_draft must never be inferred from or affect research_report.
  assert.equal(taskHasAcceptedCurrentDeliverable([emailAccepted, researchDraftOnly]), true);
  assert.equal(
    taskHasAcceptedCurrentDeliverable([
      { ...emailAccepted, accepted_at: null },
      researchDraftOnly
    ]),
    false
  );
});
