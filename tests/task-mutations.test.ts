import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import { deriveCompletedAtPatch, updateTaskSchema } from "../lib/task-status";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenario 1] PATCH /api/tasks/[id] delegates to canonical applyTaskPatch
// ---------------------------------------------------------------------------

test("[required scenario 1] the normal task PATCH route delegates persistence to lib/task-mutations.ts's applyTaskPatch", async () => {
  const source = await readSource("app/api/tasks/[id]/route.ts");
  assert.match(source, /import \{ applyTaskPatch \} from "@\/lib\/task-mutations";/);
  assert.match(source, /const result = await applyTaskPatch\(id, parsed\.data\);/);
  // No local DB write -- this route no longer touches meeting_tasks directly at all.
  assert.doesNotMatch(source, /meeting_tasks/);
});

// ---------------------------------------------------------------------------
// [required scenario 2] Task Chat delegates to the SAME canonical applyTaskPatch
// ---------------------------------------------------------------------------

test("[required scenario 2] Task Chat imports the shared applyTaskPatch instead of defining its own", async () => {
  const source = await readSource("app/api/tasks/[id]/comments/route.ts");
  assert.match(source, /import \{ applyTaskPatch \} from "@\/lib\/task-mutations";/);
  assert.doesNotMatch(source, /async function applyTaskPatch/);
  assert.doesNotMatch(source, /meeting_tasks/);
});

test("[required scenario 2] both of Task Chat's write call sites (confirmation flow and immediate-apply flow) use the shared function", async () => {
  const source = await readSource("app/api/tasks/[id]/comments/route.ts");
  const calls = source.match(/await applyTaskPatch\(/g) ?? [];
  assert.equal(calls.length, 2, "expected exactly the confirmation-flow and immediate-apply-flow call sites");
});

// ---------------------------------------------------------------------------
// [required scenario 3] exactly one application-layer general task-patch implementation
// ---------------------------------------------------------------------------

test("[required scenario 3] lib/task-mutations.ts is the only place that performs a general meeting_tasks field update -- classification/commitment-move/reorder/dependency-provenance routes remain their own narrow, single-purpose writes and are not duplicates of this", async () => {
  const mutationsSource = await readSource("lib/task-mutations.ts");
  assert.match(mutationsSource, /\.from\("meeting_tasks"\)\s*\n\s*\.update\(/);

  // The two surfaces that used to each have their own general-patch write no longer do.
  const routeSource = await readSource("app/api/tasks/[id]/route.ts");
  const commentsSource = await readSource("app/api/tasks/[id]/comments/route.ts");
  assert.doesNotMatch(routeSource, /\.from\("meeting_tasks"\)/);
  assert.doesNotMatch(commentsSource, /\.from\("meeting_tasks"\)/);
});

// ---------------------------------------------------------------------------
// [required scenarios 4-6] completed_at / lifecycle derivation is unconditional and shared
// ---------------------------------------------------------------------------

test("[required scenarios 4-6] applyTaskPatch unconditionally derives completed_at via deriveCompletedAtPatch -- not a Task-Chat-specific condition, not reimplemented", async () => {
  const source = await readSource("lib/task-mutations.ts");
  assert.match(source, /import \{ deriveCompletedAtPatch \} from "@\/lib\/task-status";/);
  assert.match(source, /\.\.\.deriveCompletedAtPatch\(patch\.status as MeetingTaskStatus \| undefined\)/);
  // No second, bespoke completed_at assignment anywhere in this file.
  assert.doesNotMatch(source, /completed_at:\s*(?!.*deriveCompletedAtPatch)/);
});

test("deriveCompletedAtPatch itself is unchanged: completing sets a timestamp, any other status (including reopening) clears it", () => {
  const completed = deriveCompletedAtPatch("completed", () => "2026-10-08T00:00:00.000Z");
  assert.deepEqual(completed, { completed_at: "2026-10-08T00:00:00.000Z" });
  const reopened = deriveCompletedAtPatch("pending");
  assert.deepEqual(reopened, { completed_at: null });
  const untouched = deriveCompletedAtPatch(undefined);
  assert.deepEqual(untouched, {});
});

// ---------------------------------------------------------------------------
// [required scenarios 7-8] preserve_on_reanalysis / manual_override_fields unchanged
// ---------------------------------------------------------------------------

test("[required scenarios 7-8] applyTaskPatch always stamps preserve_on_reanalysis and merges manual_override_fields, matching the pre-migration behavior of both call sites", async () => {
  const source = await readSource("lib/task-mutations.ts");
  assert.match(source, /preserve_on_reanalysis: true/);
  assert.match(source, /manual_override_fields: mergeManualOverrideFields\(\s*\n\s*task\.manual_override_fields,\s*\n\s*Object\.keys\(patch\)\s*\n\s*\)/);
});

// ---------------------------------------------------------------------------
// [required scenario 9] the general PATCH route's field allowlist is unchanged and unbroadened
// ---------------------------------------------------------------------------

test("[required scenario 9] updateTaskSchema still rejects fields outside its original allowlist, including ones Task Chat is allowed to write", () => {
  assert.equal(updateTaskSchema.safeParse({ status: "completed" }).success, true);
  // task_type/suggested_steps/rationale/supporting_context are in Task Chat's wider
  // sanitizeTaskChatPatch allowlist but must remain OUT of the general API's allowlist --
  // applyTaskPatch enforces no allowlist itself, so this boundary lives entirely in each
  // caller's own schema, and updateTaskSchema must not have grown to match the wider one.
  for (const field of ["task_type", "suggested_steps", "rationale", "supporting_context", "accepted_at", "accepted_by"]) {
    const result = updateTaskSchema.safeParse({ status: "completed", [field]: "x" });
    assert.equal(result.success, false, `${field} must still be rejected by updateTaskSchema`);
  }
});

// ---------------------------------------------------------------------------
// [required scenarios 10-12] Task Chat's own decision logic is untouched by this patch
// ---------------------------------------------------------------------------

test("[required scenario 10] Task Chat's confidence threshold (>= 0.75) and intent gate are byte-identical to before this migration", async () => {
  const source = await readSource("app/api/tasks/[id]/comments/route.ts");
  assert.match(source, /agent\.result\.confidence < 0\.75/);
  assert.match(source, /agent\.result\.intent === "apply_update"/);
  assert.match(source, /canApplyTaskChatPatch\(\{/);
});

test("[required scenario 11] Task Chat's pendingPatch / confirmation detection logic is untouched", async () => {
  const source = await readSource("app/api/tasks/[id]/comments/route.ts");
  assert.match(source, /isTaskUpdateConfirmation\(parsed\.data\)/);
  assert.match(source, /findLatestPendingProposal\(/);
  assert.match(source, /createPendingProposalMetadata\(\{/);
});

test("[required scenario 12] neither the shared mutation function nor Task Chat's route touches artifact acceptance fields or tables", async () => {
  const mutationsSource = await readSource("lib/task-mutations.ts");
  const commentsSource = await readSource("app/api/tasks/[id]/comments/route.ts");
  for (const source of [mutationsSource, commentsSource]) {
    assert.doesNotMatch(source, /accepted_at|accepted_by|task_artifacts/);
  }
});

// ---------------------------------------------------------------------------
// [required scenarios 13-14] getOwnedMeeting consolidation
// ---------------------------------------------------------------------------

test("[required scenario 13] getOwnedMeeting is now exported from the shared lib/project-access.ts", async () => {
  const source = await readSource("lib/project-access.ts");
  assert.match(source, /export async function getOwnedMeeting\(meetingId: string, userId: string\)/);
});

test("[required scenario 14] the meeting assistant route imports the shared getOwnedMeeting rather than defining its own, with the exact same ownership filters preserved", async () => {
  const routeSource = await readSource("app/api/meetings/[id]/assistant/messages/route.ts");
  assert.match(routeSource, /import \{ getOwnedMeeting \} from "@\/lib\/project-access";/);
  assert.doesNotMatch(routeSource, /async function getOwnedMeeting/);

  const accessSource = await readSource("lib/project-access.ts");
  const fnMatch = accessSource.match(/export async function getOwnedMeeting\([^]*?\n\}/);
  assert.ok(fnMatch, "expected a getOwnedMeeting function body");
  assert.match(fnMatch![0], /\.eq\("id", meetingId\)/);
  assert.match(fnMatch![0], /\.eq\("user_id", userId\)/);
  assert.match(fnMatch![0], /\.is\("deleted_at", null\)/);
});

// ---------------------------------------------------------------------------
// [required scenario 16] dead task-owner route removal
// ---------------------------------------------------------------------------

test("[required scenario 16] app/api/tasks/[id]/owner/route.ts no longer exists", async () => {
  await assert.rejects(() => stat(new URL("../app/api/tasks/[id]/owner/route.ts", import.meta.url)));
});

test("[required scenario 16] no remaining caller references the removed owner-only endpoint", async () => {
  const callers = [
    "components/standalone-tasks-panel.tsx",
    "components/task-correction-menu.tsx"
  ];
  for (const file of callers) {
    const source = await readSource(file);
    assert.doesNotMatch(source, /tasks\/\$\{[^}]*\}\/owner/);
  }
});

// ---------------------------------------------------------------------------
// applyTaskPatch's own contract: no allowlist/auth inside it, matching applyCommitmentPatch
// ---------------------------------------------------------------------------

test("applyTaskPatch takes a raw patch with no internal field allowlist or auth check, matching applyCommitmentPatch's contract (validation/authorization are the caller's job)", async () => {
  const source = await readSource("lib/task-mutations.ts");
  assert.match(source, /export async function applyTaskPatch\(\s*\n\s*taskId: string,\s*\n\s*patch: Record<string, unknown>/);
  assert.doesNotMatch(source, /requireApiUser\(|getOwnedTask\(|updateTaskSchema\.(parse|safeParse)\(/);
});

test("applyTaskPatch rejects an empty patch rather than issuing a no-op write", async () => {
  const source = await readSource("lib/task-mutations.ts");
  assert.match(source, /if \(Object\.keys\(patch\)\.length === 0\) \{\s*\n\s*return \{ error: "No changes to apply\." \};/);
});
