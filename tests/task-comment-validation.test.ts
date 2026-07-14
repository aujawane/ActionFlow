import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskCommentMessage } from "../lib/task-comment-validation";

test("preserves correction text without applying task mutations", () => {
  const result = parseTaskCommentMessage(
    "  This should be assigned to Sarah instead.  "
  );
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data, "This should be assigned to Sarah instead.");
  }
});

test("rejects empty and oversized clarification messages", () => {
  assert.equal(parseTaskCommentMessage("   ").success, false);
  assert.equal(parseTaskCommentMessage("x".repeat(4001)).success, false);
});
