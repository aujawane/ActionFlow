import assert from "node:assert/strict";
import test from "node:test";

import { hasExplicitWorkspaceMutationIntent } from "../lib/workspace-agent/intent-gate";

// ---------------------------------------------------------------------------
// [required scenario 12] existing explicit-request cases still pass (reused verbatim from the
// Project Brain intent-gate hardening -- the shared gate must remain byte-for-byte compatible).
// ---------------------------------------------------------------------------

const MUST_EXECUTE_MESSAGES = [
  "Change the due date to Friday.",
  "Can you change the due date to Friday?",
  "Please make Kevin the owner.",
  "Set this to high priority.",
  "Rename this commitment to MVP workflow.",
  "Mark this commitment complete.",
  "Reopen it.",
  "Could you update the description?"
];

for (const [index, message] of MUST_EXECUTE_MESSAGES.entries()) {
  test(`[required scenario 12] (${index + 1}) "${message}" is an explicit mutation request`, () => {
    assert.equal(hasExplicitWorkspaceMutationIntent(message), true);
  });
}

// ---------------------------------------------------------------------------
// [required scenario 13] existing hypothetical/discussion cases still fail
// ---------------------------------------------------------------------------

const MUST_NOT_EXECUTE_MESSAGES = [
  "Maybe Kevin should own this.",
  "I think Kevin should own this.",
  "Do you think Kevin should own this?",
  "Should Kevin own this?",
  "What if Kevin owned this?",
  "Would it be better if this were high priority?",
  "I wonder if Friday is a better deadline.",
  "The deadline seems aggressive.",
  "Tell me what would happen if I moved this to Friday.",
  "Which owner would you recommend?",
  "Do you think I should change the deadline?",
  "Maybe delete that one.",
  "What would happen if we deleted this?"
];

for (const [index, message] of MUST_NOT_EXECUTE_MESSAGES.entries()) {
  test(`[required scenario 13] (${index + 1}) "${message}" is discussion/speculation, not a request`, () => {
    assert.equal(hasExplicitWorkspaceMutationIntent(message), false);
  });
}

// ---------------------------------------------------------------------------
// [required scenario 14] new verbs (create/add/delete/remove/accept) are handled conservatively
// ---------------------------------------------------------------------------

test("[required scenario 14] new verbs execute when explicitly requested", () => {
  assert.equal(hasExplicitWorkspaceMutationIntent("Create a task called Test login."), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Add Kevin to the project."), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Delete the old landing-page commitment."), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Remove this task."), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Can you delete the obsolete requirement?"), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Please accept the deliverable."), true);
});

test("[required scenario 14] new verbs stay blocked under hypothetical/discussion framing, same as the original verb set", () => {
  assert.equal(hasExplicitWorkspaceMutationIntent("Do you think we should delete this?"), false);
  assert.equal(hasExplicitWorkspaceMutationIntent("Maybe we should remove the old one."), false);
  assert.equal(hasExplicitWorkspaceMutationIntent("I wonder if we should create a new commitment."), false);
  assert.equal(hasExplicitWorkspaceMutationIntent("What if we added Kevin to the project?"), false);
});

test("a bare mutation verb inside a hypothetical/recommendation question does not count as a request on its own", () => {
  assert.equal(hasExplicitWorkspaceMutationIntent("Do you think I should change the owner?"), false);
});

test("polite question forms are explicit requests despite the question mark", () => {
  assert.equal(hasExplicitWorkspaceMutationIntent("Can you move the deadline to October 20?"), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("Could you assign this to Priya?"), true);
});

test("first-person request forms are explicit", () => {
  assert.equal(hasExplicitWorkspaceMutationIntent("I'd like you to rename this to Launch MVP."), true);
  assert.equal(hasExplicitWorkspaceMutationIntent("I want you to mark it complete."), true);
});
