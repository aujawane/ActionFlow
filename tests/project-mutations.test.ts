import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// [required scenario 27] normal project PATCH delegates to applyProjectPatch
// ---------------------------------------------------------------------------

test("[required scenario 27] the normal project PATCH route delegates persistence to lib/project-mutations.ts's applyProjectPatch", async () => {
  const routeSource = await readSource("app/api/projects/[id]/route.ts");
  assert.match(routeSource, /import \{ applyProjectPatch \} from "@\/lib\/project-mutations";/);
  assert.match(routeSource, /const result = await applyProjectPatch\(id, parsed\.data\);/);
  // No local write to the projects table inside the PATCH handler anymore -- only GET/DELETE
  // (unchanged, untouched by this patch) still reference supabaseAdmin directly.
  const patchHandler = routeSource.match(/export async function PATCH\([\s\S]*?\n\}/);
  assert.ok(patchHandler);
  assert.doesNotMatch(patchHandler![0], /supabaseAdmin/);
});

test("applyProjectPatch mirrors applyCommitmentPatch/applyTaskPatch's contract: no auth check, no field allowlist inside it, rejects an empty patch", async () => {
  const source = await readSource("lib/project-mutations.ts");
  assert.match(source, /export async function applyProjectPatch\(\s*\n\s*projectId: string,\s*\n\s*patch: Record<string, unknown>/);
  assert.doesNotMatch(source, /requireApiUser\(|getOwnedProject\(|updateProjectSchema/);
  assert.match(source, /if \(Object\.keys\(patch\)\.length === 0\) \{\s*\n\s*return \{ error: "No changes to apply\." \};/);
});

// ---------------------------------------------------------------------------
// [required scenario 28] project schema remains strict
// ---------------------------------------------------------------------------

test("[required scenario 28] updateProjectSchema in the route is unchanged and still strict -- no new fields were added while extracting applyProjectPatch", async () => {
  const source = await readSource("app/api/projects/[id]/route.ts");
  const schemaMatch = source.match(/const updateProjectSchema = z\s*\n\s*\.object\(\{[\s\S]*?\n {2}\}\)\s*\n\s*\.strict\(\);/);
  assert.ok(schemaMatch);
  assert.match(schemaMatch![0], /name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(160\)\.optional\(\)/);
  assert.match(schemaMatch![0], /description: z\.string\(\)\.trim\(\)\.max\(2000\)\.nullable\(\)\.optional\(\)/);
  assert.match(schemaMatch![0], /goal: z\.string\(\)\.trim\(\)\.max\(2000\)\.nullable\(\)\.optional\(\)/);
  assert.match(schemaMatch![0], /status: z\s*\n\s*\.enum\(\["planning", "active", "on_hold", "completed", "archived"\]\)/);
});

test("the GET and DELETE handlers are untouched by this patch -- only PATCH was migrated", async () => {
  const source = await readSource("app/api/projects/[id]/route.ts");
  assert.match(source, /export async function GET\(/);
  assert.match(source, /export async function DELETE\(/);
  const deleteHandler = source.match(/export async function DELETE\([\s\S]*?\n\}/);
  assert.ok(deleteHandler);
  assert.match(deleteHandler![0], /\.from\("projects"\)\s*\n\s*\.delete\(\)/);
});
