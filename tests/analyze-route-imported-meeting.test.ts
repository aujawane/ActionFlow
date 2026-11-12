import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-level checks (the route needs a live Supabase client, so it is not executed here).

async function route() {
  return readFile(new URL("../app/api/meetings/[id]/analyze/route.ts", import.meta.url), "utf8");
}

test("the analyze route reads the meeting source", async () => {
  assert.match(await route(), /\.select\("id, status, source"\)/);
});

test("an import with no saved transcript gets import guidance, decided before any Recall wording", async () => {
  const source = await route();
  const importBranch = source.indexOf("!isRecallMeeting(meeting)");
  assert.ok(importBranch !== -1);
  assert.match(source, /No transcript was saved for this import/);
  for (const recallWording of ["Recall reported a failure", "Recall has not finished", "Transcript is still processing"]) {
    assert.ok(source.indexOf(recallWording) > importBranch, `${recallWording} must come after the import branch`);
  }
});

test("Recall meetings keep their existing messages", async () => {
  const source = await route();
  assert.match(source, /error: "Meeting processing failed"/);
  assert.match(source, /error: "Transcript is still processing"/);
});
