import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Commitment Workspace: inline "Mark complete" task action
// ---------------------------------------------------------------------------
//
// These tests follow the same readSource() source-inspection pattern used in
// tests/task-status-completion.test.ts, since this repo has no component-
// rendering test harness. They assert the architectural guarantees the
// product spec requires: the inline control reuses the existing task-update
// path (no second mutation implementation), never touches deliverable
// acceptance, and a completed task never shows an actionable button again.

test("the inline Mark complete button calls the same updateTask()/PATCH /api/tasks/[id] path as the status dropdown -- no second completion implementation", async () => {
  const source = await readSource("components/commitment-workspace.tsx");

  const updateTaskFn = source.match(
    /async function updateTask\(taskId: string, patch: Record<string, unknown>\) \{[\s\S]*?\n {2}\}\n/
  );
  assert.ok(updateTaskFn, "expected an updateTask function");
  assert.match(updateTaskFn![0], /`\/api\/tasks\/\$\{taskId\}`/);
  assert.match(updateTaskFn![0], /method: "PATCH"/);

  // The status <select> and the Mark complete button both call this same function.
  assert.match(source, /onChange=\{\(event\) => void updateTask\(task\.id, \{ status: event\.target\.value \}\)\}/);
  assert.match(source, /onClick=\{\(\) => void updateTask\(task\.id, \{ status: "completed" \}\)\}/);
});

test("Mark complete is hidden for an already-completed task -- a completed task shows a completed state, not an actionable button", async () => {
  const source = await readSource("components/commitment-workspace.tsx");
  const branchMatch = source.match(
    /\{task\.status !== "completed" \? \([\s\S]*?Mark complete[\s\S]*?\) : \([\s\S]*?Completed[\s\S]*?\)\}/
  );
  assert.ok(branchMatch, "expected a status !== completed ? <Mark complete button> : <Completed state> branch");
  // The completed branch renders a <p>, not a <button> -- it is not clickable.
  const completedBranch = branchMatch![0].split(") : (")[1];
  assert.doesNotMatch(completedBranch, /<button/);
});

test("the Mark complete control never sends an acceptance-related field -- Accept and Mark complete stay separate", async () => {
  const source = await readSource("components/commitment-workspace.tsx");
  // The literal patch sent by the button is status-only -- never an acceptance field.
  const onClickMatch = source.match(/onClick=\{\(\) => void updateTask\(task\.id, \{[^}]*\}\)\}\s*\n\s*>\s*\n\s*Mark complete/);
  assert.ok(onClickMatch, "expected the Mark complete button's onClick");
  assert.doesNotMatch(onClickMatch![0], /accepted/);
  assert.match(onClickMatch![0], /status: "completed"/);
});

test("updateTaskSchema has no acceptance field, so the shared PATCH route the button calls can never mutate deliverable acceptance", async () => {
  const schemaSource = await readSource("lib/task-status.ts");
  const schemaMatch = schemaSource.match(/export const updateTaskSchema = z[\s\S]*?\.object\(\{[\s\S]*?\n {2}\}\)\n {2}\.strict\(\);/);
  assert.ok(schemaMatch, "expected updateTaskSchema");
  assert.doesNotMatch(schemaMatch![0], /accepted/);
});

test("the commitment title is a wrapping, full-width control rather than a single-line input that clips long titles", async () => {
  const source = await readSource("components/commitment-workspace.tsx");
  assert.match(source, /ref=\{titleRef\}/);
  assert.match(source, /className="mt-2 w-full resize-none overflow-hidden[^"]*"\s*\n\s*value=\{commitment\.title\}/);
});

test("the Commitment Workspace header stacks vertically by default and only sits side-by-side from sm: up, so the title never has to share a row with the status select on mobile", async () => {
  const source = await readSource("components/commitment-workspace.tsx");
  assert.match(source, /flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between/);
});
