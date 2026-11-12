import assert from "node:assert/strict";
import test from "node:test";

import { isMeetingPrimaryKeyViolation } from "@/lib/transcript-import/duplicate";

test("only meetings primary key collisions qualify as import retries", () => {
  assert.equal(isMeetingPrimaryKeyViolation({ code: "23505", message: 'duplicate key value violates unique constraint "meetings_pkey"' }), true);
  assert.equal(isMeetingPrimaryKeyViolation({ code: "23505", message: 'duplicate key value violates unique constraint "meetings_recall_bot_id_key"' }), false);
  assert.equal(isMeetingPrimaryKeyViolation({ code: "23505", message: 'duplicate key value violates unique constraint "some_other_key"' }), false);
  assert.equal(isMeetingPrimaryKeyViolation({ code: "23503", message: 'duplicate key value violates unique constraint "meetings_pkey"' }), false);
  assert.equal(isMeetingPrimaryKeyViolation(null), false);
});
