import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackCategorization,
  categoryToWorkspaceType,
  getCategoryDisplayLabel,
  getDeliverableButtonLabel,
  getDeliverablePanelTitle,
  getDeliverableTypeForCategory,
  getTaskCategorization,
  normalizeDeliverableType,
  normalizeTaskCategory,
  parseCategorizationMetadata,
  shouldReturnExistingDeliverable,
  workspaceTypeToCategory
} from "../lib/task-deliverables";
import type { MeetingTask } from "../lib/types";

function buildTask(
  overrides: Partial<MeetingTask> = {}
): MeetingTask {
  return {
    id: "task-1",
    meeting_id: "meeting-1",
    topic_id: "topic-1",
    task: "Send follow-up email",
    owner: "Alex",
    task_type: "commitment",
    priority: "medium",
    suggested_steps: [],
    source_quote: null,
    confidence: 0.8,
    status: "pending",
    due_date: null,
    workspace_type: "email",
    workspace_summary: null,
    rationale: null,
    supporting_context: null,
    created_at: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

test("maps categories to deliverable types and button labels", () => {
  assert.equal(getDeliverableTypeForCategory("email"), "email_draft");
  assert.equal(getDeliverableButtonLabel("email_draft"), "Draft email");
  assert.equal(getDeliverablePanelTitle("website_change_prompt"), "Developer Prompt");
});

test("normalizes legacy workspace types to categories", () => {
  assert.equal(normalizeTaskCategory("meeting_follow_up"), "follow_up");
  assert.equal(normalizeTaskCategory("documentation"), "document");
  assert.equal(normalizeTaskCategory("unknown"), "other");
  assert.equal(workspaceTypeToCategory("proposal"), "document");
  assert.equal(categoryToWorkspaceType("coding"), "coding");
});

test("normalizes deliverable types with category fallback", () => {
  assert.equal(normalizeDeliverableType("email_draft"), "email_draft");
  assert.equal(normalizeDeliverableType("invalid", "research"), "research_report");
  assert.equal(normalizeDeliverableType(null, "other"), "generic_next_steps");
});

test("parses categorization metadata and rejects invalid payloads", () => {
  const parsed = parseCategorizationMetadata({
    category: "email",
    deliverable_type: "email_draft",
    confidence: 1.5,
    reason: "Clear email request.",
    missing_info: ["recipient"],
    suggested_button_label: "Draft email"
  });

  assert.deepEqual(parsed, {
    category: "email",
    deliverable_type: "email_draft",
    confidence: 1,
    reason: "Clear email request.",
    missing_info: ["recipient"],
    suggested_button_label: "Draft email"
  });
  assert.equal(parseCategorizationMetadata({ category: "email" }), null);
});

test("derives categorization from workspace type when metadata is absent", () => {
  const task = buildTask({ workspace_type: "research", categorization_metadata: undefined });
  const categorization = getTaskCategorization(task);

  assert.equal(categorization.category, "research");
  assert.equal(categorization.deliverable_type, "research_report");
  assert.equal(categorization.suggested_button_label, "Create report");
  assert.equal(getCategoryDisplayLabel(categorization.category), "Research");
});

test("uses persisted categorization metadata when available", () => {
  const task = buildTask({
    workspace_type: "other",
    categorization_metadata: {
      category: "website_change",
      deliverable_type: "website_change_prompt",
      confidence: 0.92,
      reason: "UI copy update requested.",
      missing_info: [],
      suggested_button_label: "Create dev prompt"
    }
  });

  const categorization = getTaskCategorization(task);
  assert.equal(categorization.category, "website_change");
  assert.equal(categorization.suggested_button_label, "Create dev prompt");
});

test("buildFallbackCategorization returns safe defaults", () => {
  assert.deepEqual(buildFallbackCategorization(), {
    category: "other",
    deliverable_type: "generic_next_steps",
    confidence: 0,
    reason: "Categorization unavailable; using safe defaults.",
    missing_info: [],
    suggested_button_label: "Do it for me"
  });
});

test("shouldReturnExistingDeliverable respects regenerate and failed artifacts", () => {
  assert.equal(
    shouldReturnExistingDeliverable({
      regenerate: false,
      artifact: { status: "generated", content: "Draft body" }
    }),
    true
  );
  assert.equal(
    shouldReturnExistingDeliverable({
      regenerate: true,
      artifact: { status: "generated", content: "Draft body" }
    }),
    false
  );
  assert.equal(
    shouldReturnExistingDeliverable({
      regenerate: false,
      artifact: { status: "failed", content: "Error" }
    }),
    false
  );
  assert.equal(
    shouldReturnExistingDeliverable({
      regenerate: false,
      artifact: { status: "generated", content: "   " }
    }),
    false
  );
  assert.equal(
    shouldReturnExistingDeliverable({
      regenerate: false,
      artifact: null
    }),
    false
  );
});
