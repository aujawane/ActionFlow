import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// SCOPE -- resolveWorkspaceScope is the only supported way to build a WorkspaceScope, and it
// always re-derives ownership via the shared getOwnedX primitives rather than trusting any
// client-supplied field. Real cross-user rejection is proven live in the Patch 1B real-DB
// integration check (see the patch report); these tests confirm the source wiring that
// guarantees it structurally.
// ---------------------------------------------------------------------------

test("[required scenario 1] project scope resolution goes through getOwnedProject -- only an owner can ever resolve one", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const caseMatch = source.match(/case "project": \{[\s\S]*?\n {4}\}/);
  assert.ok(caseMatch);
  assert.match(caseMatch![0], /getOwnedProject\(input\.id, input\.userId\)/);
  assert.match(caseMatch![0], /if \(!project\) return \{ ok: false, reason: "not_found" \};/);
});

test("[required scenario 2] meeting scope resolution goes through getOwnedMeeting -- only an owner can ever resolve one", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const caseMatch = source.match(/case "meeting": \{[\s\S]*?\n {4}\}/);
  assert.ok(caseMatch);
  assert.match(caseMatch![0], /getOwnedMeeting\(input\.id, input\.userId\)/);
  assert.match(caseMatch![0], /if \(!meeting\) return \{ ok: false, reason: "not_found" \};/);
});

test("[required scenario 3] commitment scope resolution reuses the exact getOwnedCommitment ownership chain and carries meeting_id/project_id along", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const caseMatch = source.match(/case "commitment": \{[\s\S]*?\n {4}\}/);
  assert.ok(caseMatch);
  assert.match(caseMatch![0], /getOwnedCommitment\(input\.id, input\.userId\)/);
  assert.match(caseMatch![0], /meetingId: commitment\.meeting_id/);
  assert.match(caseMatch![0], /projectId: commitment\.project_id \?\? null/);
});

test("[required scenario 4] task scope resolution reuses the exact getOwnedTask ownership chain and carries commitment_id/meeting_id/project_id along", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const caseMatch = source.match(/case "task": \{[\s\S]*?\n {4}\}/);
  assert.ok(caseMatch);
  assert.match(caseMatch![0], /getOwnedTask\(input\.id, input\.userId\)/);
  assert.match(caseMatch![0], /commitmentId: task\.commitment_id \?\? null/);
  assert.match(caseMatch![0], /meetingId: task\.meeting_id/);
  assert.match(caseMatch![0], /projectId: task\.project_id \?\? null/);
});

test("[required scenario 5] every scope branch returns the identical not_found shape for a missing/cross-user id -- no branch leaks whether the entity exists for someone else", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const notFoundReturns = source.match(/\{ ok: false, reason: "not_found" \}/g) ?? [];
  assert.equal(notFoundReturns.length, 4, "expected exactly one not_found return per scope type (project/meeting/commitment/task)");
});

test("resolveWorkspaceScope never accepts a scope's ids directly from a parameter -- the only input is the single URL-scoped id and the authenticated userId", async () => {
  const source = await readSource("lib/workspace-agent/scope.ts");
  const fnMatch = source.match(/export async function resolveWorkspaceScope\(input: \{[\s\S]*?\n\}\): Promise<ResolveWorkspaceScopeResult> \{/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /type: WorkspaceScope\["type"\];/);
  assert.match(fnMatch![0], /id: string;/);
  assert.match(fnMatch![0], /userId: string;/);
  // No projectId/meetingId/commitmentId/taskId parameter -- those are only ever derived, never input.
  assert.doesNotMatch(fnMatch![0], /projectId:\s*string|meetingId:\s*string|commitmentId:\s*string|taskId:\s*string/);
});

// ---------------------------------------------------------------------------
// AUTHORIZATION
// ---------------------------------------------------------------------------

test("[required scenario 15] a target outside the current scope is rejected even if it belongs to the authenticated user -- scope membership is checked independently of ownership", async () => {
  const source = await readSource("lib/workspace-agent/authorize.ts");
  assert.match(source, /if \(!commitmentWithinScope\(commitment, scope\)\) return \{ ok: false, reason: "outside_scope" \};/);
  assert.match(source, /if \(!taskWithinScope\(task, scope\)\) return \{ ok: false, reason: "outside_scope" \};/);
  assert.match(source, /if \(!projectWithinScope\(project, scope\)\) return \{ ok: false, reason: "outside_scope" \};/);
});

test("[required scenario 16] commitment authorization re-resolves ownership fresh via getOwnedCommitment -- never reuses an earlier pass's result", async () => {
  const source = await readSource("lib/workspace-agent/authorize.ts");
  assert.match(source, /const commitment = await getOwnedCommitment\(ref\.id, userId\);/);
  assert.match(source, /if \(!commitment\) return \{ ok: false, reason: "not_found" \};/);
});

test("[required scenario 17] task authorization re-resolves ownership fresh via getOwnedTask -- never reuses an earlier pass's result", async () => {
  const source = await readSource("lib/workspace-agent/authorize.ts");
  assert.match(source, /const task = await getOwnedTask\(ref\.id, userId\);/);
  assert.match(source, /if \(!task\) return \{ ok: false, reason: "not_found" \};/);
});

test("authorization never trusts the scope's own cached ids as proof -- every branch re-fetches the target entity by its own id before checking scope membership", async () => {
  const source = await readSource("lib/workspace-agent/authorize.ts");
  // The scope-membership helpers only ever compare already-fetched entity fields against the
  // scope -- they never themselves call a getOwnedX function (that happens once, in the caller).
  const helperSection = source.match(/function commitmentWithinScope[\s\S]*?function projectWithinScope[\s\S]*?\n\}/);
  assert.ok(helperSection);
  assert.doesNotMatch(helperSection![0], /getOwned/);
});

test("conservative Patch 1B scope policy: a commitment scope cannot reach a sibling commitment in the same meeting, and a task scope cannot reach a sibling task under the same commitment", async () => {
  const source = await readSource("lib/workspace-agent/authorize.ts");
  const commitmentFn = source.match(/function commitmentWithinScope[\s\S]*?\n\}/);
  assert.ok(commitmentFn);
  assert.match(commitmentFn![0], /case "commitment":\s*\n\s*return commitment\.id === scope\.commitmentId;/);
  const taskFn = source.match(/function taskWithinScope[\s\S]*?\n\}/);
  assert.ok(taskFn);
  assert.match(taskFn![0], /case "task":\s*\n\s*return task\.id === scope\.taskId;/);
});
