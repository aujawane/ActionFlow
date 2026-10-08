import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deriveCommitmentLifecyclePatch } from "../lib/commitment-mutations";
import { isCommitmentCountedActive, partitionExecutionGraph } from "../lib/execution-display";
import { computeProjectProgress } from "../lib/project-execution";
import type { MeetingCommitment, MeetingTask } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function commitment(overrides: Partial<MeetingCommitment>): MeetingCommitment {
  return {
    id: "c1",
    meeting_id: "m1",
    execution_classification: "committed",
    status: "pending",
    completion_state: "open",
    converted_to_task_id: null,
    ...overrides
  } as MeetingCommitment;
}

// ---------------------------------------------------------------------------
// [required scenario 1-3] Mark complete / Reopen / Delete patches
// ---------------------------------------------------------------------------

test("[required scenario 1] Mark complete sends status=completed and completion_state=completed", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  const fnMatch = source.match(/function markComplete\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "expected a markComplete function");
  assert.match(fnMatch![0], /submitPatch\(\{ status: "completed", completion_state: "completed" \}\)/);
});

test("[required scenario 2] Reopen sends an open status and an open completion_state", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  const fnMatch = source.match(/function reopen\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "expected a reopen function");
  assert.match(fnMatch![0], /submitPatch\(\{ status: "pending", completion_state: "open" \}\)/);
});

test("[required scenario 3] Delete uses status=dismissed", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  const fnMatch = source.match(/function deleteCommitment\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "expected a deleteCommitment function");
  assert.match(fnMatch![0], /submitPatch\(\{ status: "dismissed" \}\)/);
});

// ---------------------------------------------------------------------------
// [required scenario 4-5] Delete is soft (dismiss), never a hard SQL DELETE, and never
// touches/orphans child rows.
// ---------------------------------------------------------------------------

test("[required scenario 4] the canonical commitment mutation path never issues a SQL DELETE", async () => {
  const mutationsSource = await readSource("lib/commitment-mutations.ts");
  assert.doesNotMatch(mutationsSource, /\.delete\(/);
  const menuSource = await readSource("components/commitment-correction-menu.tsx");
  assert.doesNotMatch(menuSource, /method:\s*"DELETE"/);
  assert.doesNotMatch(menuSource, /deleted_at/);
});

test("[required scenario 5] deleting a commitment never touches meeting_tasks -- child tasks are neither deleted nor orphaned by this UI action", async () => {
  const menuSource = await readSource("components/commitment-correction-menu.tsx");
  const fnMatch = menuSource.match(/function deleteCommitment\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch);
  // deleteCommitment's only executable statement is the dismiss patch -- no fetch/call touches
  // any task route or table. (The function's own explanatory comment mentions meeting_tasks by
  // name, which is why this checks the executable line rather than the whole function body.)
  const executableLine = fnMatch![0]
    .split("\n")
    .find((line) => line.trim().startsWith("void submitPatch"));
  assert.equal(executableLine?.trim(), 'void submitPatch({ status: "dismissed" });');
  assert.equal((fnMatch![0].match(/fetch\(/g) ?? []).length, 0);
  // The commitment row itself is never removed (see scenario 4), so the on-delete-set-null FK
  // from meeting_tasks.commitment_id (supabase/migrations) never fires in the first place.
});

// ---------------------------------------------------------------------------
// [required scenario 6] Acceptance (TaskArtifact.accepted_at/accepted_by) stays untouched.
// ---------------------------------------------------------------------------

test("[required scenario 6] Mark complete, Reopen, and Delete never reference acceptance fields", async () => {
  const menuSource = await readSource("components/commitment-correction-menu.tsx");
  const block = menuSource.match(
    /function markComplete[\s\S]*?function deleteCommitment\(\) \{[\s\S]*?\n {2}\}/
  );
  assert.ok(block);
  assert.doesNotMatch(block![0], /accepted_at|accepted_by|task_artifacts/);
});

// ---------------------------------------------------------------------------
// [required scenario 7] Dismissed commitments disappear from active meeting-workspace rendering
// -- a real unit test against the actual partitioning/progress functions, not just source
// inspection, since these are pure and cheap to call directly.
// ---------------------------------------------------------------------------

test("[required scenario 7] isCommitmentCountedActive excludes only dismissed commitments", () => {
  assert.equal(isCommitmentCountedActive(commitment({ status: "pending" })), true);
  assert.equal(isCommitmentCountedActive(commitment({ status: "in_progress" })), true);
  assert.equal(isCommitmentCountedActive(commitment({ status: "blocked" })), true);
  assert.equal(isCommitmentCountedActive(commitment({ status: "completed" })), true);
  assert.equal(isCommitmentCountedActive(commitment({ status: "dismissed" })), false);
});

test("[required scenario 7] partitionExecutionGraph drops a dismissed commitment out of activeCommitments", () => {
  const commitments = [
    commitment({ id: "active", status: "pending" }),
    commitment({ id: "dismissed", status: "dismissed" })
  ];
  const partitioned = partitionExecutionGraph({ commitments, tasks: [] });
  assert.deepEqual(
    partitioned.activeCommitments.map((c) => c.id),
    ["active"]
  );
});

test("[required scenario 7] a dismissed commitment with no children drops out of project progress counts", () => {
  const commitments = [
    commitment({ id: "active", status: "pending" }),
    commitment({ id: "dismissed", status: "dismissed" })
  ];
  const progress = computeProjectProgress({ commitments, tasks: [] });
  // Only the active (non-dismissed) zero-child commitment counts toward the total; the
  // dismissed one must not drag the denominator down.
  assert.equal(progress.total, 1);
});

// ---------------------------------------------------------------------------
// [required scenario 8-9] Mark complete / Reopen are mutually exclusive on the menu.
// ---------------------------------------------------------------------------

test("[required scenario 8] a completed commitment's menu shows Reopen, not Mark complete", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  assert.match(source, /isCompleted \? \{ label: "Reopen", onSelect: reopen \} : null/);
});

test("[required scenario 9] an active (non-completed) commitment's menu shows Mark complete", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  assert.match(source, /!isCompleted \? \{ label: "Mark complete", onSelect: markComplete \} : null/);
});

// ---------------------------------------------------------------------------
// [required scenario 10] Delete requires confirmation in the direct UI -- the ActionMenu item
// only opens a dialog; deleteCommitment is only ever invoked from that dialog's confirm button.
// ---------------------------------------------------------------------------

test("[required scenario 10] the Delete commitment ActionMenu item opens a confirmation dialog rather than deleting immediately", async () => {
  const source = await readSource("components/commitment-correction-menu.tsx");
  assert.match(
    source,
    /label: "Delete commitment",\s*\n\s*onSelect: \(\) => setDialog\("delete"\),\s*\n\s*variant: "destructive"/
  );
  // deleteCommitment is referenced exactly once outside its own definition -- as the confirm
  // button's onClick inside the "delete" dialog -- never as an ActionMenuItem's onSelect.
  const occurrences = source.split("deleteCommitment").length - 1;
  assert.equal(occurrences, 2); // the `function deleteCommitment() {` definition + one call site
  assert.match(source, /onClick=\{deleteCommitment\}/);
});

// ---------------------------------------------------------------------------
// [required scenario 11] Ownership validation remains in the API route.
// ---------------------------------------------------------------------------

test("[required scenario 11] PATCH /api/commitments/[id] still requires auth and validates the commitment belongs to the authenticated user's meeting", async () => {
  const source = await readSource("app/api/commitments/[id]/route.ts");
  assert.match(source, /const auth = await requireApiUser\(\);/);
  assert.match(source, /if \(auth\.response\) return auth\.response;/);
  assert.match(source, /\.eq\("user_id", auth\.user\.id\)/);
  assert.match(source, /applyCommitmentPatch\(id, parsed\.data\)/);
});

// ---------------------------------------------------------------------------
// [required scenario 12] Commitment Workspace navigates away when its own commitment is
// dismissed, instead of leaving the user on a stale/broken workspace page.
// ---------------------------------------------------------------------------

test("[required scenario 12] Commitment Workspace navigates back to the source meeting when its commitment becomes dismissed", async () => {
  const source = await readSource("components/commitment-workspace.tsx");
  const fnMatch = source.match(/function handleCommitmentUpdated\(updated: MeetingCommitment\) \{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "expected a handleCommitmentUpdated function");
  assert.match(fnMatch![0], /updated\.status === "dismissed"/);
  assert.match(fnMatch![0], /router\.push\(`\/meetings\/\$\{sourceMeeting\.id\}` as Route\)/);
  // Both the menu-driven actions and the raw status <select> flow through this one function.
  assert.match(source, /onCommitmentUpdated=\{handleCommitmentUpdated\}/);
});

// ---------------------------------------------------------------------------
// [required scenario 13] Mobile: no new persistent/competing controls were introduced outside
// the existing ActionMenu, and the shared ActionMenu/Modal components themselves are untouched
// by this patch.
// ---------------------------------------------------------------------------

test("[required scenario 13] the new commitment actions live entirely inside the existing ActionMenu -- no new always-visible button was added next to the commitment title", async () => {
  const panelSource = await readSource("components/commitments-panel.tsx");
  // The card's title/status/menu row still contains exactly one badge + one menu component,
  // matching the pre-patch structure -- Mark complete/Reopen/Delete did not add sibling buttons
  // that would crowd the title row on a narrow viewport.
  const headerRow = panelSource.match(
    /<div className="flex items-center gap-1\.5">[\s\S]*?<\/div>\s*<\/div>/
  );
  assert.ok(headerRow, "expected the status badge + menu header row");
  assert.equal((headerRow![0].match(/<CommitmentCorrectionMenu/g) ?? []).length, 1);
  assert.doesNotMatch(headerRow![0], /<button/);
});

test("[required scenario 13] ActionMenu and Modal (the shared mobile-safe primitives) are not modified by this patch", async () => {
  const actionMenuSource = await readSource("components/action-menu.tsx");
  const modalSource = await readSource("components/modal.tsx");
  // Both still expose the exact same props this patch relies on.
  assert.match(actionMenuSource, /variant\?: "default" \| "destructive"/);
  assert.match(modalSource, /variant\?: "dialog" \| "drawer"/);
});

// ---------------------------------------------------------------------------
// Direct unit coverage of the status<->completion_state derivation (the drift fix).
// ---------------------------------------------------------------------------

test("deriveCommitmentLifecyclePatch fills in completion_state from a status-only patch", () => {
  assert.deepEqual(deriveCommitmentLifecyclePatch({ status: "completed" }), {
    completion_state: "completed"
  });
  assert.deepEqual(deriveCommitmentLifecyclePatch({ status: "dismissed" }), {
    completion_state: "cancelled"
  });
  assert.deepEqual(deriveCommitmentLifecyclePatch({ status: "pending" }), {
    completion_state: "open"
  });
});

test("deriveCommitmentLifecyclePatch fills in status from a completion_state-only patch", () => {
  assert.deepEqual(deriveCommitmentLifecyclePatch({ completion_state: "cancelled" }), {
    status: "dismissed"
  });
  assert.deepEqual(deriveCommitmentLifecyclePatch({ completion_state: "open" }), {
    status: "pending"
  });
});

test("deriveCommitmentLifecyclePatch never overrides a value the caller already sent for both fields", () => {
  assert.deepEqual(
    deriveCommitmentLifecyclePatch({ status: "completed", completion_state: "open" }),
    {}
  );
});

test("deriveCommitmentLifecyclePatch is a no-op for patches touching neither field", () => {
  assert.deepEqual(deriveCommitmentLifecyclePatch({ title: "New title" }), {});
});
