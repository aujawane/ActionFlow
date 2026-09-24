import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  groupVocabularyTermsByStatus,
  vocabularyEvidenceLabel
} from "../components/project-vocabulary-panel";
import {
  reviewProjectVocabularyTerm,
  type ReviewVocabularyTermDependencies,
  type UpdateSuggestedVocabularyTerm
} from "../lib/project-vocabulary-review";
import type { ProjectVocabularyTerm } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function term(overrides: Partial<ProjectVocabularyTerm> = {}): ProjectVocabularyTerm {
  return {
    id: overrides.id ?? "term-1",
    project_id: overrides.project_id ?? "project-a",
    canonical_term: overrides.canonical_term ?? "Vercel",
    aliases: overrides.aliases ?? ["versailles"],
    term_type: overrides.term_type ?? "tool",
    source: overrides.source ?? "ai_suggested",
    status: overrides.status ?? "suggested",
    confidence: overrides.confidence ?? 0.9,
    evidence_meeting_id: overrides.evidence_meeting_id ?? "meeting-1",
    evidence_segment_ids: overrides.evidence_segment_ids ?? ["seg-1"],
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z"
  };
}

const ROUTE_PATH = "app/api/projects/[id]/vocabulary/[termId]/route.ts";
const REVIEW_MODULE_PATH = "lib/project-vocabulary-review.ts";

// ---------------------------------------------------------------------------
// Pure grouping/display logic
// ---------------------------------------------------------------------------

test("groupVocabularyTermsByStatus buckets terms by status", () => {
  const terms = [
    term({ id: "a", status: "suggested" }),
    term({ id: "b", status: "approved" }),
    term({ id: "c", status: "rejected" }),
    term({ id: "d", status: "suggested" })
  ];
  const grouped = groupVocabularyTermsByStatus(terms);
  assert.deepEqual(
    grouped.suggested.map((t) => t.id),
    ["a", "d"]
  );
  assert.deepEqual(
    grouped.approved.map((t) => t.id),
    ["b"]
  );
  assert.deepEqual(
    grouped.rejected.map((t) => t.id),
    ["c"]
  );
});

test("vocabularyEvidenceLabel reports segment count when evidence exists", () => {
  assert.equal(
    vocabularyEvidenceLabel(term({ evidence_meeting_id: "m1", evidence_segment_ids: ["s1", "s2"] })),
    "2 transcript segments"
  );
  assert.equal(
    vocabularyEvidenceLabel(term({ evidence_meeting_id: "m1", evidence_segment_ids: ["s1"] })),
    "1 transcript segment"
  );
});

test("vocabularyEvidenceLabel reports no evidence when meeting/segments are missing", () => {
  assert.equal(
    vocabularyEvidenceLabel(term({ evidence_meeting_id: null, evidence_segment_ids: [] })),
    "No transcript evidence recorded"
  );
});

// ---------------------------------------------------------------------------
// Route shape: route.ts must export ONLY supported Next.js route fields (this is exactly what
// broke `next build` previously -- a Next.js route module may not export an arbitrary helper like
// reviewProjectVocabularyTerm, even one used only by tests). The real logic now lives in
// lib/project-vocabulary-review.ts; route.ts is a thin PATCH handler that imports and calls it.
// ---------------------------------------------------------------------------

test("route.ts exports only the PATCH handler -- no other export (e.g. a test-only helper) that next build's route validation would reject", async () => {
  const source = await readSource(ROUTE_PATH);
  const topLevelExports = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+(\w+)/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(topLevelExports, ["PATCH"]);
  assert.doesNotMatch(source, /export\s+.*reviewProjectVocabularyTerm/);
});

test("route.ts imports the review logic from lib/project-vocabulary-review rather than implementing it inline", async () => {
  const source = await readSource(ROUTE_PATH);
  assert.match(source, /import \{ reviewProjectVocabularyTerm \} from "@\/lib\/project-vocabulary-review";/);
  assert.match(source, /return reviewProjectVocabularyTerm\(\{ projectId: id, termId, body \}\);/);
});

// ---------------------------------------------------------------------------
// lib/project-vocabulary-review.ts: source-level sanity checks on the real (non-injected)
// implementation
// ---------------------------------------------------------------------------

test("the default dependencies wire the real requireApiUser/getOwnedProject/Supabase update -- production never uses a fake", async () => {
  const source = await readSource(REVIEW_MODULE_PATH);
  assert.match(source, /requireApiUser,\s*\n\s*getOwnedProject,\s*\n\s*updateSuggestedTerm: updateSuggestedTermInSupabase/);
});

test("the vocabulary review logic only accepts status \"approved\" or \"rejected\" -- never \"suggested\" or an arbitrary field", async () => {
  const source = await readSource(REVIEW_MODULE_PATH);
  assert.match(source, /z\s*\.\s*enum\(\["approved", "rejected"\]\)/);
  assert.match(source, /\.strict\(\)/);
});

test("the real Supabase update is scoped to the term id, the project id, AND the current status -- all three are enforced in one atomic query", async () => {
  const source = await readSource(REVIEW_MODULE_PATH);
  assert.match(source, /\.eq\("id", termId\)/);
  assert.match(source, /\.eq\("project_id", projectId\)/);
  assert.match(source, /\.eq\("status", "suggested"\)/);
});

test("the review logic never hardcodes an approval at the actual mutation call site -- the persisted status always comes from the parsed, user-submitted body", async () => {
  const source = await readSource(REVIEW_MODULE_PATH);
  assert.match(source, /status: parsed\.data\.status/);
  assert.doesNotMatch(source, /\.update\(\{\s*status:\s*"approved"\s*\}\)/);
  assert.doesNotMatch(source, /\.update\(\{\s*status:\s*"rejected"\s*\}\)/);
});

test("the vocabulary review logic reuses the existing project_vocabulary table -- no second vocabulary table/route pattern is introduced", async () => {
  const source = await readSource(REVIEW_MODULE_PATH);
  assert.match(source, /from\("project_vocabulary"\)/);
});

// ---------------------------------------------------------------------------
// API route: BEHAVIOR-level tests against reviewProjectVocabularyTerm (the real logic the PATCH
// handler delegates to), with fake auth/db dependencies injected -- mirrors the existing
// createResponse-override testing pattern used elsewhere in this repo (see
// lib/execution-intelligence/work-item-model.ts / tests/transcript-normalization-regressions.test.ts)
// rather than inventing a new one. The fake store below faithfully mirrors the real query's three
// .eq() filters (id, project_id, status="suggested"), so these tests prove the ROUTE threads the
// right values through -- not merely that a fake happens to return null.
// ---------------------------------------------------------------------------

type FakeVocabRow = {
  id: string;
  project_id: string;
  status: "approved" | "suggested" | "rejected";
  canonical_term: string;
};

function createFakeVocabularyStore(initialRows: FakeVocabRow[]) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const updateCalls: Array<{ termId: string; projectId: string; status: string }> = [];

  const updateSuggestedTerm: UpdateSuggestedVocabularyTerm = async ({ termId, projectId, status }) => {
    updateCalls.push({ termId, projectId, status });
    const row = rows.get(termId);
    if (!row || row.project_id !== projectId || row.status !== "suggested") {
      return { data: null, error: null };
    }
    row.status = status;
    return { data: { ...row } as unknown as ProjectVocabularyTerm, error: null };
  };

  return { rows, updateCalls, updateSuggestedTerm };
}

function happyPathDeps(
  store: ReturnType<typeof createFakeVocabularyStore>,
  ownedProjectId = "project-a",
  userId = "owner-1"
): ReviewVocabularyTermDependencies {
  return {
    requireApiUser: async () => ({ user: { id: userId } as never, response: null }),
    getOwnedProject: async (projectId) =>
      projectId === ownedProjectId ? ({ id: projectId } as never) : null,
    updateSuggestedTerm: store.updateSuggestedTerm
  };
}

test("[behavior] unauthenticated request -> 401, and ownership/mutation are never attempted", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  let getOwnedProjectCalled = false;
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "approved" } },
    {
      requireApiUser: async () => ({
        user: null,
        response: Response.json({ error: "Unauthorized" }, { status: 401 })
      }) as never,
      getOwnedProject: async () => {
        getOwnedProjectCalled = true;
        return null;
      },
      updateSuggestedTerm: store.updateSuggestedTerm
    }
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "Unauthorized");
  assert.equal(getOwnedProjectCalled, false, "ownership must never be checked for an unauthenticated caller");
  assert.equal(store.updateCalls.length, 0);
});

test("[behavior] a caller who does not own the project cannot mutate it -> 404, mutation never attempted", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "approved" } },
    {
      requireApiUser: async () => ({ user: { id: "intruder" } as never, response: null }),
      getOwnedProject: async (projectId, userId) => {
        assert.equal(projectId, "project-a");
        assert.equal(userId, "intruder");
        return null; // the intruder does not own project-a
      },
      updateSuggestedTerm: store.updateSuggestedTerm
    }
  );
  assert.equal(response.status, 404);
  assert.equal(store.updateCalls.length, 0, "mutation must never be attempted for an unowned project");
  assert.equal(store.rows.get("term-1")?.status, "suggested", "the term must remain untouched");
});

test("[behavior] a vocabulary term belonging to a different project cannot be mutated, even by a legitimate owner of the requested project -> 409, row untouched", async () => {
  // term-1 actually belongs to project-B, but the caller (who legitimately owns project-A) sends a
  // request scoped to project-A -- the real query's .eq("project_id", projectId) must reject this.
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-B", status: "suggested", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-A", termId: "term-1", body: { status: "approved" } },
    happyPathDeps(store, "project-A")
  );
  assert.equal(response.status, 409);
  assert.equal(store.rows.get("term-1")?.project_id, "project-B");
  assert.equal(store.rows.get("term-1")?.status, "suggested", "a cross-project term must remain untouched");
});

test("[behavior] suggested -> approved succeeds -> 200, row updated", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "approved" } },
    happyPathDeps(store)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.term.status, "approved");
  assert.equal(store.rows.get("term-1")?.status, "approved");
});

test("[behavior] suggested -> rejected succeeds -> 200, row updated", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "rejected" } },
    happyPathDeps(store)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.term.status, "rejected");
  assert.equal(store.rows.get("term-1")?.status, "rejected");
});

test("[behavior] an already-approved term cannot be reviewed again -> 409, status unchanged", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "approved", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "rejected" } },
    happyPathDeps(store)
  );
  assert.equal(response.status, 409);
  assert.equal(store.rows.get("term-1")?.status, "approved");
});

test("[behavior] an already-rejected term cannot be reviewed again -> 409, status unchanged", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "rejected", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    { projectId: "project-a", termId: "term-1", body: { status: "approved" } },
    happyPathDeps(store)
  );
  assert.equal(response.status, 409);
  assert.equal(store.rows.get("term-1")?.status, "rejected");
});

test("[behavior] an invalid status value -> 400, mutation never attempted", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  for (const invalidBody of [{ status: "suggested" }, { status: "banana" }, { status: 5 }, {}, null]) {
    const response = await reviewProjectVocabularyTerm(
      { projectId: "project-a", termId: "term-1", body: invalidBody },
      happyPathDeps(store)
    );
    assert.equal(response.status, 400, JSON.stringify(invalidBody));
  }
  assert.equal(store.updateCalls.length, 0, "no invalid body should ever reach the mutation");
  assert.equal(store.rows.get("term-1")?.status, "suggested");
});

test("[behavior] arbitrary extra fields cannot be persisted -- the strict schema rejects the whole request, not just the extra field", async () => {
  const store = createFakeVocabularyStore([
    { id: "term-1", project_id: "project-a", status: "suggested", canonical_term: "Vercel" }
  ]);
  const response = await reviewProjectVocabularyTerm(
    {
      projectId: "project-a",
      termId: "term-1",
      body: { status: "approved", role: "admin", canonical_term: "Hacked" }
    },
    happyPathDeps(store)
  );
  assert.equal(response.status, 400);
  assert.equal(store.updateCalls.length, 0);
  assert.equal(store.rows.get("term-1")?.status, "suggested");
  assert.equal(store.rows.get("term-1")?.canonical_term, "Vercel", "no field from the body ever reaches the row");
});

// ---------------------------------------------------------------------------
// UI: approve/reject wiring, optimistic-free but responsive review flow
// ---------------------------------------------------------------------------

const PANEL_PATH = "components/project-vocabulary-panel.tsx";

test("the panel calls the project-scoped PATCH route with the term id and chosen status", async () => {
  const source = await readSource(PANEL_PATH);
  assert.match(
    source,
    /fetch\(`\/api\/projects\/\$\{projectId\}\/vocabulary\/\$\{termId\}`, \{/
  );
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /body: JSON\.stringify\(\{ status \}\)/);
});

test("the panel exposes both Approve and Reject actions for a suggested term", async () => {
  const source = await readSource(PANEL_PATH);
  assert.match(source, /review\(term\.id, "rejected"\)/);
  assert.match(source, /review\(term\.id, "approved"\)/);
});

test("router.refresh() runs after a successful review, matching the app's existing mutation pattern", async () => {
  const source = await readSource(PANEL_PATH);
  const successIndex = source.indexOf("setTerms((current)");
  const refreshIndex = source.indexOf("router.refresh()");
  assert.ok(successIndex > -1 && refreshIndex > -1);
  assert.ok(successIndex < refreshIndex);
});

test("a failed review surfaces an error and does not optimistically mutate local state", async () => {
  const source = await readSource(PANEL_PATH);
  assert.match(source, /if \(!response\.ok \|\| !result\.term\) \{/);
  assert.match(source, /setError\(result\.error \|\| "Failed to update this suggestion\."\);/);
});

test("a review action is disabled while a request for that term is already in flight, preventing a duplicate submission", async () => {
  const source = await readSource(PANEL_PATH);
  assert.match(source, /disabled=\{pendingId === term\.id\}/);
  assert.match(source, /if \(pendingId\) return;/);
});

test("the panel never renders anything for a project with zero vocabulary terms", async () => {
  const source = await readSource(PANEL_PATH);
  assert.match(source, /if \(terms\.length === 0\) return null;/);
});

// ---------------------------------------------------------------------------
// Project page: initial data fetch is project-scoped, matching every other section on this page
// ---------------------------------------------------------------------------

test("the project page fetches project_vocabulary scoped to this project and passes it to ProjectVocabularyPanel", async () => {
  const source = await readSource("app/projects/[id]/page.tsx");
  assert.match(source, /from\("project_vocabulary"\)/);
  assert.match(source, /<ProjectVocabularyPanel/);
  assert.match(source, /projectId=\{id\}/);
});
