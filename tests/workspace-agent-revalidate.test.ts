import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenarios 34-36] revalidation design -- source-inspection only, matching this
// repo's established pattern of never directly invoking revalidatePath() in a test (it requires
// a live Next.js request context; every other revalidatePath call site in this codebase is
// verified the same way -- see e.g. tests/project-brain-direct-commitment-edit.test.ts).
// ---------------------------------------------------------------------------

test("[required scenario 34] a touched commitment revalidates its own page and its parent meeting page", async () => {
  const source = await readSource("lib/workspace-agent/revalidate.ts");
  const branch = source.match(/if \(entity\.kind === "commitment"\) \{[\s\S]*?\n {4}\}/);
  assert.ok(branch);
  assert.match(branch![0], /paths\.add\(`\/commitments\/\$\{entity\.id\}`\);/);
  assert.match(branch![0], /paths\.add\(`\/meetings\/\$\{entity\.meetingId\}`\);/);
});

test("[required scenario 35] a touched task revalidates its own page, its parent commitment page (when it has one), and its parent meeting page", async () => {
  const source = await readSource("lib/workspace-agent/revalidate.ts");
  const branch = source.match(/\} else if \(entity\.kind === "task"\) \{[\s\S]*?\n {4}\}/);
  assert.ok(branch);
  assert.match(branch![0], /paths\.add\(`\/tasks\/\$\{entity\.id\}`\);/);
  assert.match(branch![0], /if \(entity\.commitmentId\) paths\.add\(`\/commitments\/\$\{entity\.commitmentId\}`\);/);
  assert.match(branch![0], /paths\.add\(`\/meetings\/\$\{entity\.meetingId\}`\);/);
});

test("[required scenario 36] a touched project revalidates its own page, /projects, and /dashboard", async () => {
  const source = await readSource("lib/workspace-agent/revalidate.ts");
  const branch = source.match(/\} else \{[\s\S]*?\n {4}\}/);
  assert.ok(branch);
  assert.match(branch![0], /paths\.add\(`\/projects\/\$\{entity\.id\}`\);/);
  assert.match(branch![0], /paths\.add\("\/projects"\);/);
  assert.match(branch![0], /paths\.add\("\/dashboard"\);/);
});

test("revalidateWorkspaceEntities uses Next.js's own revalidatePath -- it does not hand-roll its own cache invalidation", async () => {
  const source = await readSource("lib/workspace-agent/revalidate.ts");
  assert.match(source, /import \{ revalidatePath \} from "next\/cache";/);
  assert.match(source, /for \(const path of paths\) revalidatePath\(path\);/);
});

test("duplicate paths across multiple touched entities are deduplicated via a Set before revalidating", async () => {
  const source = await readSource("lib/workspace-agent/revalidate.ts");
  assert.match(source, /const paths = new Set<string>\(\);/);
});

test("this is infrastructure only in Patch 1B -- no chat route or component calls it yet", async () => {
  const chatRoutes = [
    "app/api/projects/[id]/brain/route.ts",
    "app/api/commitments/[id]/comments/route.ts",
    "app/api/tasks/[id]/comments/route.ts",
    "app/api/meetings/[id]/assistant/messages/route.ts"
  ];
  for (const route of chatRoutes) {
    const source = await readSource(route);
    assert.doesNotMatch(source, /revalidateWorkspaceEntities/, route);
  }
});
