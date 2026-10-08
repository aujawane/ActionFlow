import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDirectEditConfirmationMessage,
  hasExplicitCommitmentMutationIntent,
  isDirectCommitmentEditEligible,
  mergeDirectCommitmentEdits,
  prepareDirectCommitmentEdits,
  type AppliedCommitmentEdit
} from "../lib/project-brain/direct-commitment-edit";
import {
  validateAndCanonicalizeOperationOwners,
  validateProposalTargets
} from "../lib/project-brain/operations";
import { projectChangeOperationSchema } from "../lib/project-brain/schemas";
import type { MeetingCommitment } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const commitmentId = "20000000-0000-4000-8000-000000000001";
const otherCommitmentId = "20000000-0000-4000-8000-000000000002";

function updateMilestoneOp(
  milestoneId: string,
  changes: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    type: "update_milestone" as const,
    milestoneId,
    changes,
    explanation: "Requested by the user.",
    evidence: [],
    warning: null,
    ...overrides
  };
}

function commitment(overrides: Partial<MeetingCommitment>): MeetingCommitment {
  return {
    id: commitmentId,
    meeting_id: "m1",
    title: "Launch website",
    description: null,
    owner: null,
    owners: [],
    due_date: null,
    due_date_text: null,
    priority: "medium",
    status: "pending",
    completion_state: "open",
    confidence: null,
    source_quote: null,
    source_segment_ids: [],
    type: "assignment",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  } as MeetingCommitment;
}

function applied(
  changes: Record<string, unknown>,
  before: Partial<MeetingCommitment>,
  after: Partial<MeetingCommitment>
): AppliedCommitmentEdit {
  return {
    commitmentId,
    changes,
    before: commitment(before),
    after: commitment(after)
  };
}

// ---------------------------------------------------------------------------
// Eligibility: only plain commitment field edits (update_milestone) qualify for direct
// execution; anything else falls back to the existing proposal/review flow.
// ---------------------------------------------------------------------------

test("[required scenario 22] a batch of only update_milestone operations is direct-edit eligible", () => {
  const ops = [
    updateMilestoneOp(commitmentId, { priority: "high" }),
    updateMilestoneOp(otherCommitmentId, { status: "completed" })
  ];
  assert.equal(isDirectCommitmentEditEligible(ops), true);
});

test("[required scenario 22] a batch containing any non-commitment-field operation is NOT eligible, even mixed with simple edits", () => {
  const withCreate = [
    updateMilestoneOp(commitmentId, { priority: "high" }),
    { type: "create_milestone" as const, title: "New", description: null, owner: null, owners: [], priority: "medium" as const, explanation: "x", evidence: [], warning: null }
  ];
  assert.equal(isDirectCommitmentEditEligible(withCreate), false);

  const withTaskOp = [
    updateMilestoneOp(commitmentId, { priority: "high" }),
    { type: "update_task_status" as const, taskId: commitmentId, status: "completed" as const, explanation: "x", evidence: [], warning: null }
  ];
  assert.equal(isDirectCommitmentEditEligible(withTaskOp), false);

  assert.equal(isDirectCommitmentEditEligible([]), false);
});

test("[required scenario 22] rename_milestone normalizes into update_milestone and is then eligible (complex merge/archive operations are not)", () => {
  const renamed = prepareDirectCommitmentEdits([
    { type: "rename_milestone", milestoneId: commitmentId, title: "New title", explanation: "x", evidence: [], warning: null }
  ]);
  assert.equal(renamed.eligible, true);
  assert.equal(renamed.normalized[0].type, "update_milestone");

  const archived = prepareDirectCommitmentEdits([
    { type: "archive_milestone", milestoneId: commitmentId, reason: "done", explanation: "x", evidence: [], warning: null }
  ]);
  assert.equal(archived.eligible, false, "archive (dismiss) is the delete action -- out of scope for this patch");

  const merged = prepareDirectCommitmentEdits([
    {
      type: "merge_milestones",
      sourceMilestoneIds: [commitmentId, otherCommitmentId],
      targetMilestoneId: null,
      target: { title: "Merged", description: null },
      explanation: "x",
      evidence: [],
      warning: null
    }
  ]);
  assert.equal(merged.eligible, false);
});

// ---------------------------------------------------------------------------
// [required scenarios 1-6] field-level edits all route through the same eligible shape.
// ---------------------------------------------------------------------------

test("[required scenarios 1-4] title, due_date, owner, and priority edits are each a single eligible update_milestone operation", () => {
  for (const changes of [
    { title: "MVP video workflow" },
    { due_date: "2026-10-09" },
    { owner: "Kevin" },
    { priority: "high" }
  ]) {
    const { eligible, normalized } = prepareDirectCommitmentEdits([updateMilestoneOp(commitmentId, changes)]);
    assert.equal(eligible, true);
    assert.equal(normalized.length, 1);
  }
});

test("[required scenario 5] mark-complete is a status=completed update_milestone operation", () => {
  const { eligible, normalized } = prepareDirectCommitmentEdits([
    updateMilestoneOp(commitmentId, { status: "completed" })
  ]);
  assert.equal(eligible, true);
  assert.equal((normalized[0] as { changes: Record<string, unknown> }).changes.status, "completed");
});

test("[required scenario 6] reopen is a status=pending (or in_progress) update_milestone operation", () => {
  const { eligible, normalized } = prepareDirectCommitmentEdits([
    updateMilestoneOp(commitmentId, { status: "pending" })
  ]);
  assert.equal(eligible, true);
  assert.equal((normalized[0] as { changes: Record<string, unknown> }).changes.status, "pending");
});

// ---------------------------------------------------------------------------
// Server-side explicit-mutation-intent gate: a deterministic second signal, independent of the
// model's own operation output or confidence, inspecting the CURRENT user message.
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
  "Do you think I should change the deadline?"
];

for (const [index, message] of MUST_EXECUTE_MESSAGES.entries()) {
  test(`[must execute ${index + 1}] "${message}" is an explicit mutation request`, () => {
    assert.equal(hasExplicitCommitmentMutationIntent(message), true);
  });
}

for (const [index, message] of MUST_NOT_EXECUTE_MESSAGES.entries()) {
  test(`[must NOT execute ${index + 9}] "${message}" is discussion/speculation/recommendation-seeking, not a request`, () => {
    assert.equal(hasExplicitCommitmentMutationIntent(message), false);
  });
}

test("a bare mutation verb inside a hypothetical/recommendation question does not count as a request on its own", () => {
  // The exact trap the task calls out: "change" is present, but framed as a question about
  // what the user should do, not an instruction for the assistant to do it.
  assert.equal(hasExplicitCommitmentMutationIntent("Do you think I should change the owner?"), false);
});

test("polite question forms (\"Can you...?\", \"Could you...?\") are explicit requests despite the question mark", () => {
  assert.equal(hasExplicitCommitmentMutationIntent("Can you move the deadline to October 20?"), true);
  assert.equal(hasExplicitCommitmentMutationIntent("Could you assign this to Priya?"), true);
});

test("additional explicit-edit phrasings from the broader examples also pass", () => {
  assert.equal(hasExplicitCommitmentMutationIntent("Move the deadline to October 20."), true);
  assert.equal(hasExplicitCommitmentMutationIntent("Update the description to mention the landing page."), true);
  assert.equal(hasExplicitCommitmentMutationIntent("I'd like you to rename this to Launch MVP."), true);
  assert.equal(hasExplicitCommitmentMutationIntent("I want you to mark it complete."), true);
});

test("[required scenario 20] an eligible operation with a non-explicit message does not satisfy the combined direct-execution gate", () => {
  const { eligible } = prepareDirectCommitmentEdits([updateMilestoneOp(commitmentId, { priority: "high" })]);
  const intent = hasExplicitCommitmentMutationIntent("Maybe this should be higher priority.");
  assert.equal(eligible, true);
  assert.equal(intent, false);
  assert.equal(eligible && intent, false);
});

test("[required scenario 21] an eligible operation with an explicit request satisfies the combined direct-execution gate", () => {
  const { eligible } = prepareDirectCommitmentEdits([updateMilestoneOp(commitmentId, { priority: "high" })]);
  const intent = hasExplicitCommitmentMutationIntent("Set this to high priority.");
  assert.equal(eligible, true);
  assert.equal(intent, true);
  assert.equal(eligible && intent, true);
});

test("[required scenario 22] the route only evaluates the intent gate inside the responseType === \"proposal\" branch, so a clarification/no-operation response can never reach direct execution regardless of message wording", async () => {
  const routeSource = await readSource("app/api/projects/[id]/brain/route.ts");
  assert.match(
    routeSource,
    /if \(result\.responseType === "proposal" && result\.proposal && result\.proposal\.operations\.length > 0\) \{\s*\n\s*const \{ normalized, eligible \} = prepareDirectCommitmentEdits/
  );
  assert.match(
    routeSource,
    /if \(eligible && hasExplicitCommitmentMutationIntent\(parsed\.data\.message\)\) \{/
  );
});

test("the intent gate reads only the current message -- it takes a single string, with no access to prior chat history", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  const fnMatch = source.match(/export function hasExplicitCommitmentMutationIntent\([^)]*\): boolean \{/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /userMessage: string/);
});

// ---------------------------------------------------------------------------
// Multiple edits in one request -- same commitment collapses to one patch; different
// commitments stay distinct, in first-seen order.
// ---------------------------------------------------------------------------

test("two operations on the same commitment merge into one patch (owner + due date in one request)", () => {
  const merged = mergeDirectCommitmentEdits([
    updateMilestoneOp(commitmentId, { owner: "Kevin" }),
    updateMilestoneOp(commitmentId, { due_date: "2026-10-09" })
  ]);
  assert.deepEqual(merged, [
    { commitmentId, changes: { owner: "Kevin", due_date: "2026-10-09" } }
  ]);
});

test("operations on different commitments stay as separate patches, in first-seen order", () => {
  const merged = mergeDirectCommitmentEdits([
    updateMilestoneOp(otherCommitmentId, { priority: "high" }),
    updateMilestoneOp(commitmentId, { status: "completed" })
  ]);
  assert.deepEqual(merged.map((edit) => edit.commitmentId), [otherCommitmentId, commitmentId]);
});

// ---------------------------------------------------------------------------
// [required scenario 11] hallucinated/out-of-project commitment IDs are rejected by the same
// validateProposalTargets check the existing apply route already uses -- reused, not
// reimplemented.
// ---------------------------------------------------------------------------

test("[required scenario 11] validateProposalTargets rejects a milestoneId the project context never resolved", () => {
  const result = validateProposalTargets(
    [updateMilestoneOp("99999999-0000-4000-8000-000000000099", { priority: "high" })],
    {
      milestones: [{ id: commitmentId }],
      tasks: [],
      staleMilestoneIds: new Set(),
      staleTaskIds: new Set()
    }
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "outside_project");
});

// ---------------------------------------------------------------------------
// Owner resolution for commitment edits (extended in lib/project-brain/operations.ts).
// ---------------------------------------------------------------------------

test("an owner edit resolves against known participants and rejects an unknown name", () => {
  const context = {
    participants: [{ participant_name: "Kevin Kenniston" }],
    milestones: [],
    tasks: []
  };
  const resolved = validateAndCanonicalizeOperationOwners(
    [updateMilestoneOp(commitmentId, { owner: "kevin" })],
    context
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal((resolved.operations[0] as { changes: { owner: string } }).changes.owner, "Kevin Kenniston");
  }

  const rejected = validateAndCanonicalizeOperationOwners(
    [updateMilestoneOp(commitmentId, { owner: "Someone Else" })],
    context
  );
  assert.equal(rejected.ok, false);
});

test("an ambiguous owner name is rejected rather than guessed", () => {
  const context = {
    participants: [{ participant_name: "Kevin Kenniston" }, { participant_name: "Kevin Smith" }],
    milestones: [],
    tasks: []
  };
  const result = validateAndCanonicalizeOperationOwners(
    [updateMilestoneOp(commitmentId, { owner: "Kevin" })],
    context
  );
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// [required scenarios 13-16] field/value allowlist, enforced by the existing zod schema --
// not a new allowlist invented for this patch.
// ---------------------------------------------------------------------------

test("[required scenario 13] an unsupported field on a commitment edit is rejected by the schema", () => {
  const parsed = projectChangeOperationSchema.safeParse(
    updateMilestoneOp(commitmentId, { meeting_id: "should-not-be-settable" })
  );
  assert.equal(parsed.success, false);
});

test("[required scenario 14] an invalid priority value is rejected", () => {
  const parsed = projectChangeOperationSchema.safeParse(
    updateMilestoneOp(commitmentId, { priority: "urgent" })
  );
  assert.equal(parsed.success, false);
});

test("[required scenario 15] an invalid status value is rejected", () => {
  const parsed = projectChangeOperationSchema.safeParse(
    updateMilestoneOp(commitmentId, { status: "archived" })
  );
  assert.equal(parsed.success, false);
});

test("[required scenario 16] acceptance fields are structurally impossible on a commitment edit", async () => {
  for (const field of ["accepted_at", "accepted_by", "accept_artifact"]) {
    const parsed = projectChangeOperationSchema.safeParse(
      updateMilestoneOp(commitmentId, { [field]: "2026-01-01" })
    );
    assert.equal(parsed.success, false, `${field} must be rejected`);
  }
  // And there is no operation type in the whole union for accepting a deliverable at all.
  const schemaSource = await readSource("lib/project-brain/schemas.ts");
  assert.doesNotMatch(schemaSource, /accept_artifact|accept_deliverable|accepted_at|accepted_by/);
});

test("the direct-edit V1 field matrix matches milestoneChanges exactly -- owners/lead_owner_id/due_date_text are deliberately out of scope until the agent can populate them", () => {
  const valid = updateMilestoneOp(commitmentId, {
    title: "t",
    description: "d",
    owner: "Kevin",
    due_date: "2026-10-09",
    priority: "high",
    status: "completed",
    completion_state: "completed"
  });
  assert.equal(projectChangeOperationSchema.safeParse(valid).success, true);

  for (const field of ["owners", "lead_owner_id", "lead_owner_name", "due_date_text"]) {
    const parsed = projectChangeOperationSchema.safeParse(
      updateMilestoneOp(commitmentId, { [field]: field === "owners" ? ["Kevin"] : "x" })
    );
    assert.equal(parsed.success, false, `${field} is not yet supported by milestoneChanges`);
  }
});

// ---------------------------------------------------------------------------
// [required scenarios 5, 6, 19] natural-language confirmation building.
// ---------------------------------------------------------------------------

test("[required scenario 19] a single field edit produces a concise Done confirmation naming the commitment, never raw JSON or IDs", () => {
  const message = buildDirectEditConfirmationMessage([
    applied({ due_date: "2026-10-09" }, { due_date: null }, { due_date: "2026-10-09", title: "Launch website" })
  ]);
  assert.match(message, /^Done — /);
  assert.match(message, /Launch website/);
  assert.match(message, /due date/);
  assert.doesNotMatch(message, /\{|\}|milestoneId|commitmentId|20000000-0000-4000-8000/);
});

test("[required scenario 19] multiple fields on one commitment join into one sentence (owner + due date)", () => {
  const message = buildDirectEditConfirmationMessage([
    applied(
      { owner: "Kevin", due_date: "2026-10-09" },
      { owner: null, due_date: null },
      { owner: "Kevin", due_date: "2026-10-09", title: "Order the custom LED chip" }
    )
  ]);
  assert.match(message, /Kevin/);
  assert.match(message, / and /);
  assert.match(message, /Order the custom LED chip/);
});

test("[required scenario 5] mark-complete confirmation says 'marked it complete', not a raw status value", () => {
  const message = buildDirectEditConfirmationMessage([
    applied({ status: "completed" }, { status: "pending" }, { status: "completed", title: "Phase-one video workflow" })
  ]);
  assert.match(message, /marked it complete/);
  assert.doesNotMatch(message, /"completed"/);
});

test("[required scenario 6] reopen confirmation says 'reopened it'", () => {
  const message = buildDirectEditConfirmationMessage([
    applied({ status: "pending" }, { status: "completed" }, { status: "pending", title: "Phase-one video workflow" })
  ]);
  assert.match(message, /reopened it/);
});

test("confirmation for multiple commitments lists each by title", () => {
  const message = buildDirectEditConfirmationMessage([
    applied({ priority: "high" }, { priority: "medium" }, { priority: "high", title: "Launch website" }),
    {
      ...applied({ status: "completed" }, { status: "pending" }, { status: "completed", title: "Order the chip" }),
      commitmentId: otherCommitmentId
    }
  ]);
  assert.match(message, /Launch website/);
  assert.match(message, /Order the chip/);
});

// ---------------------------------------------------------------------------
// [required scenarios 7-10, 12, 17, 18, 20, 21] source-level guarantees that can't be exercised
// without a live LLM/DB -- follows this repo's established readSource() pattern (see
// tests/task-status-completion.test.ts).
// ---------------------------------------------------------------------------

test("[required scenarios 7-8] the system prompt explicitly distinguishes explicit instructions from discussion/speculation before proposing an operation", async () => {
  const source = await readSource("lib/project-brain/agent.ts");
  assert.match(source, /explicit instruction to make that\s+change/);
  assert.match(source, /do\s+not propose an operation they have not explicitly requested/);
});

test("[required scenario 9] the system prompt requires naming candidates and asking when a commitment reference is ambiguous, rather than guessing", async () => {
  const source = await readSource("lib/project-brain/agent.ts");
  assert.match(source, /name the specific candidates and ask which one they mean/);
  assert.match(source, /only proceed once exactly one commitment clearly matches/);
});

test("relative date phrases are grounded against project_context.today using the same pattern as lib/commitment-correction, not a new date system", async () => {
  const contextSource = await readSource("lib/project-brain/context.ts");
  assert.match(contextSource, /today: new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  const agentSource = await readSource("lib/project-brain/agent.ts");
  assert.match(agentSource, /project_context\.today/);
});

test("[required scenario 10] an out-of-project commitment reference becomes a clarification response, never an execution", async () => {
  const routeSource = await readSource("app/api/projects/[id]/brain/route.ts");
  const block = routeSource.match(/const targetValidation[\s\S]*?if \(!targetValidation\.ok\) \{[\s\S]*?\n {6}\}/);
  assert.ok(block, "expected a targetValidation failure branch");
  assert.match(block![0], /responseType: "clarification"/);
  assert.match(block![0], /proposal: null/);
});

test("[required scenario 12] another user's commitment cannot be reached -- getOwnedCommitment is re-checked immediately before every write", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.match(source, /import \{ getOwnedCommitment \} from "@\/lib\/project-access";/);
  const loop = source.match(/for \(const edit of merged\) \{[\s\S]*?\n {2}\}/);
  assert.ok(loop);
  assert.match(loop![0], /getOwnedCommitment\(edit\.commitmentId, input\.userId\)/);
  assert.match(loop![0], /if \(!before\) \{/);
});

test("[required scenario 17] the canonical applyCommitmentPatch path is reused -- no raw meeting_commitments write in the direct-edit module", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.match(source, /import \{ applyCommitmentPatch \} from "@\/lib\/commitment-mutations";/);
  assert.match(source, /applyCommitmentPatch\(edit\.commitmentId, edit\.changes\)/);
  assert.doesNotMatch(source, /\.from\("meeting_commitments"\)/);
});

test("[required scenario 18] lifecycle (status/completion_state) normalization is not reimplemented here -- it is left entirely to applyCommitmentPatch", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.doesNotMatch(source, /completion_state:\s*"(open|in_progress|blocked|completed|cancelled")/);
  assert.doesNotMatch(source, /STATUS_TO_COMPLETION_STATE|COMPLETION_STATE_TO_STATUS/);
});

test("[required scenario 20] a persistence failure is reported as a failed save, never as success", async () => {
  const routeSource = await readSource("app/api/projects/[id]/brain/route.ts");
  const block = routeSource.match(/\} else \{\s*\n\s*console\.warn\("\[ProjectBrain\] direct commitment edit failed"[\s\S]*?\n {10}\}/);
  assert.ok(block, "expected a failure branch after executeDirectCommitmentEdits");
  assert.match(block![0], /I couldn't save that change/);
  assert.doesNotMatch(block![0], /Done —/);
});

test("[required scenario 21] a direct Brain mutation is audited with actor_type \"assistant\", never \"user\"", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.match(source, /actor_type: "assistant"/);
  assert.doesNotMatch(source, /actor_type: "user"/);
  assert.match(source, /actor_id: input\.userId/);
  assert.match(source, /source_type: "project_chat"/);
});

test("[required scenario 22] operations the direct-edit path does not recognize fall through to the existing pending_review proposal flow unchanged", async () => {
  const routeSource = await readSource("app/api/projects/[id]/brain/route.ts");
  // The pre-existing proposal-persistence block is still reachable and its condition is
  // untouched by the new direct-edit block above it.
  assert.match(
    routeSource,
    /let proposal: Record<string, unknown> \| null = null;\s*\n\s*if \(\s*\n\s*result\.responseType === "proposal" &&\s*\n\s*result\.proposal &&\s*\n\s*result\.proposal\.operations\.length > 0\s*\n\s*\) \{/
  );
});

test("the new direct-edit module never touches task-artifact acceptance fields or tables", async () => {
  const source = await readSource("lib/project-brain/direct-commitment-edit.ts");
  assert.doesNotMatch(source, /accepted_at|accepted_by|task_artifacts/);
});
