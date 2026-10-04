import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyDeterministicAliasCorrections,
  buildVocabularyPromptContext,
  DETERMINISTIC_ALIAS_STOPLIST
} from "../lib/project-vocabulary";
import type { ProjectVocabularyTerm } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function term(overrides: Partial<ProjectVocabularyTerm> = {}): ProjectVocabularyTerm {
  return {
    id: overrides.id ?? "term-1",
    project_id: overrides.project_id ?? "project-a",
    canonical_term: overrides.canonical_term ?? "Vercel",
    aliases: overrides.aliases ?? ["versailles", "versel"],
    term_type: overrides.term_type ?? "tool",
    source: overrides.source ?? "user_added",
    status: overrides.status ?? "approved",
    confidence: overrides.confidence ?? 1,
    evidence_meeting_id: overrides.evidence_meeting_id ?? null,
    evidence_segment_ids: overrides.evidence_segment_ids ?? [],
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z"
  };
}

// ---------------------------------------------------------------------------
// [4] high-confidence project term correction (deterministic path)
// ---------------------------------------------------------------------------

test("[4] a distinctive approved alias is deterministically corrected to the canonical term", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "i deployed it on versailles yesterday" }],
    [term({ canonical_term: "Vercel", aliases: ["versailles"] })]
  );
  assert.equal(result.correctedText.get("seg-1"), "i deployed it on Vercel yesterday");
  const corrections = result.corrections.get("seg-1");
  assert.equal(corrections?.length, 1);
  assert.equal(corrections?.[0].source, "deterministic");
  assert.equal(corrections?.[0].applied, true);
});

// ---------------------------------------------------------------------------
// [8] ordinary-English-word collision is not incorrectly replaced
// ---------------------------------------------------------------------------

test("[8] a stoplisted ordinary-English-word alias (e.g. 'recall') is never deterministically replaced, even if explicitly added", () => {
  assert.equal(DETERMINISTIC_ALIAS_STOPLIST.has("recall"), true);
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "we need to recall what happened yesterday" }],
    [term({ canonical_term: "Recall.ai", aliases: ["recall"] })]
  );
  assert.equal(result.correctedText.has("seg-1"), false);
  assert.equal(result.corrections.has("seg-1"), false);
});

test("[8] a short (<3 char) alias is refused deterministically -- too easy to collide", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "we use ai for this" }],
    [term({ canonical_term: "AI Assistant", aliases: ["ai"] })]
  );
  assert.equal(result.correctedText.has("seg-1"), false);
});

// ---------------------------------------------------------------------------
// [Fix 2] status=approved is the trust boundary; source is provenance only, never a gate.
// status=suggested and status=rejected must never drive deterministic replacement, regardless of
// source or confidence.
// ---------------------------------------------------------------------------

test("[Fix 2] a still-suggested AI-discovered term (even at confidence 1.0) is never used for deterministic replacement", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "we deployed it on versailles" }],
    [term({ canonical_term: "Vercel", aliases: ["versailles"], source: "ai_suggested", status: "suggested", confidence: 1 })]
  );
  assert.equal(result.correctedText.has("seg-1"), false);
});

test("a rejected vocabulary entry is never used for deterministic replacement, regardless of source", () => {
  for (const source of ["user_added", "ai_suggested"] as const) {
    const result = applyDeterministicAliasCorrections(
      [{ id: "seg-1", text: "we deployed it on versailles" }],
      [term({ canonical_term: "Vercel", aliases: ["versailles"], status: "rejected", source })]
    );
    assert.equal(result.correctedText.has("seg-1"), false, source);
  }
});

test("[Fix 2] an AI-suggested term that a human has since approved (status=approved) IS trusted for deterministic replacement, identically to a user-added approved term", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "we deployed it on versailles" }],
    [
      term({
        canonical_term: "Vercel",
        aliases: ["versailles"],
        source: "ai_suggested",
        status: "approved",
        confidence: 1
      })
    ]
  );
  assert.equal(result.correctedText.get("seg-1"), "we deployed it on Vercel");
  const corrections = result.corrections.get("seg-1");
  assert.equal(corrections?.[0].source, "deterministic");
});

test("[Fix 2] source never gates eligibility -- only status does -- for both user_added and ai_suggested approved terms", () => {
  for (const source of ["user_added", "ai_suggested"] as const) {
    const result = applyDeterministicAliasCorrections(
      [{ id: "seg-1", text: "we deployed it on versailles" }],
      [term({ canonical_term: "Vercel", aliases: ["versailles"], source, status: "approved" })]
    );
    assert.equal(result.correctedText.get("seg-1"), "we deployed it on Vercel", source);
  }
});

// ---------------------------------------------------------------------------
// [Fix 3] Alias collisions across two approved canonical terms must never produce an arbitrary
// (order-dependent) deterministic correction.
// ---------------------------------------------------------------------------

test("[Fix 3] a unique approved alias (claimed by exactly one canonical term) is still deterministically replaced", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "ship it with foo" }],
    [term({ canonical_term: "FooTool", aliases: ["foo"] })]
  );
  assert.equal(result.correctedText.get("seg-1"), "ship it with FooTool");
});

test("[Fix 3] the same alias claimed by two distinct approved canonical terms is ambiguous -- no deterministic replacement for either", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "ship it with foo" }],
    [
      term({ id: "term-a", canonical_term: "CanonicalA", aliases: ["foo"] }),
      term({ id: "term-b", canonical_term: "CanonicalB", aliases: ["foo"] })
    ]
  );
  assert.equal(result.correctedText.has("seg-1"), false);
  assert.equal(result.corrections.has("seg-1"), false);
});

test("[Fix 3] alias-collision resolution does not depend on vocabulary array order", () => {
  const canonicalA = term({ id: "term-a", canonical_term: "CanonicalA", aliases: ["foo"] });
  const canonicalB = term({ id: "term-b", canonical_term: "CanonicalB", aliases: ["foo"] });
  const segment = { id: "seg-1", text: "ship it with foo" };

  const resultAB = applyDeterministicAliasCorrections([segment], [canonicalA, canonicalB]);
  const resultBA = applyDeterministicAliasCorrections([segment], [canonicalB, canonicalA]);
  assert.equal(resultAB.correctedText.has("seg-1"), false);
  assert.equal(resultBA.correctedText.has("seg-1"), false);
  assert.deepEqual(resultAB, resultBA);
});

test("[Fix 3] case-insensitive alias collisions ('Foo' vs 'foo' from different canonical terms) are treated as the same colliding alias", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "ship it with foo" }],
    [
      term({ id: "term-a", canonical_term: "CanonicalA", aliases: ["Foo"] }),
      term({ id: "term-b", canonical_term: "CanonicalB", aliases: ["foo"] })
    ]
  );
  assert.equal(result.correctedText.has("seg-1"), false);
});

test("[Fix 3] a collision in one project's vocabulary has no effect on another project's unambiguous alias -- each call only ever sees the vocabulary list the caller passed in", () => {
  const projectAVocabulary = [
    term({ project_id: "project-a", id: "term-a", canonical_term: "CanonicalA", aliases: ["foo"] }),
    term({ project_id: "project-a", id: "term-b", canonical_term: "CanonicalB", aliases: ["foo"] })
  ];
  const projectBVocabulary = [
    term({ project_id: "project-b", id: "term-c", canonical_term: "FooTool", aliases: ["foo"] })
  ];
  const segment = { id: "seg-1", text: "ship it with foo" };

  const resultForProjectA = applyDeterministicAliasCorrections([segment], projectAVocabulary);
  assert.equal(resultForProjectA.correctedText.has("seg-1"), false);

  const resultForProjectB = applyDeterministicAliasCorrections([segment], projectBVocabulary);
  assert.equal(resultForProjectB.correctedText.get("seg-1"), "ship it with FooTool");
});

test("[Fix 3] two aliases on the SAME canonical term are not a collision -- only distinct canonical terms collide", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "ship it with foo" }],
    [term({ canonical_term: "FooTool", aliases: ["foo", "foo2"] })]
  );
  assert.equal(result.correctedText.get("seg-1"), "ship it with FooTool");
});

test("[Fix 3] a suggested/rejected term's alias never contributes to a collision -- only approved terms are considered", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "ship it with foo" }],
    [
      term({ id: "term-a", canonical_term: "CanonicalA", aliases: ["foo"], status: "approved" }),
      term({ id: "term-b", canonical_term: "CanonicalB", aliases: ["foo"], status: "suggested", source: "ai_suggested" })
    ]
  );
  // Only one APPROVED term claims "foo" -- the suggested term doesn't count toward ambiguity.
  assert.equal(result.correctedText.get("seg-1"), "ship it with CanonicalA");
});

// ---------------------------------------------------------------------------
// [3][14] project-scoped: vocabulary passed in for one project cannot leak into another project's
// correction pass -- scoping is the caller's responsibility (only that project's approved terms
// are ever passed in), proven here by constructing two disjoint vocabulary sets.
// ---------------------------------------------------------------------------

test("[3][14] vocabulary from a different project has no effect unless explicitly passed in -- no cross-project leakage", () => {
  const projectAVocabulary = [term({ project_id: "project-a", canonical_term: "Parfait", aliases: ["parface"] })];
  const projectBSegment = { id: "seg-1", text: "good news, parface is live now" };

  // Simulates normalizing a Project B meeting with Project B's (empty) vocabulary -- Project A's
  // term must not be visible here at all.
  const resultForProjectB = applyDeterministicAliasCorrections([projectBSegment], []);
  assert.equal(resultForProjectB.correctedText.has("seg-1"), false);

  // The same segment normalized with Project A's own vocabulary DOES correct -- proving the
  // vocabulary list itself is what's scoped, not some global lookup.
  const resultForProjectA = applyDeterministicAliasCorrections([projectBSegment], projectAVocabulary);
  assert.equal(resultForProjectA.correctedText.get("seg-1"), "good news, Parfait is live now");
});

test("[3][14] getApprovedProjectVocabulary filters strictly by project_id and status=approved", async () => {
  const source = await readSource("lib/project-vocabulary.ts");
  const fnMatch = source.match(/export async function getApprovedProjectVocabulary\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /\.eq\("project_id", projectId\)/);
  assert.match(fnMatch![0], /\.eq\("status", "approved"\)/);
});

// ---------------------------------------------------------------------------
// [6] participant-name correction is representable the same way as any other term
// ---------------------------------------------------------------------------

test("[6] a participant name registered as vocabulary (term_type=person) corrects the same way as a tool name", () => {
  const result = applyDeterministicAliasCorrections(
    [{ id: "seg-1", text: "cameron said he'd handle it" }],
    [term({ canonical_term: "Cameron", aliases: ["cameron"], term_type: "person" })]
  );
  // "cameron" (lowercase, 7 chars, not stoplisted) is a legitimate distinctive alias for the
  // capitalized canonical spelling.
  assert.equal(result.correctedText.get("seg-1"), "Cameron said he'd handle it");
});

// ---------------------------------------------------------------------------
// buildVocabularyPromptContext stays compact (no raw DB row leakage into the prompt)
// ---------------------------------------------------------------------------

test("buildVocabularyPromptContext sends only canonical_term/aliases/type -- never ids, timestamps, or evidence", () => {
  const context = buildVocabularyPromptContext([term()]);
  assert.deepEqual(context, [{ canonical_term: "Vercel", aliases: ["versailles", "versel"], type: "tool" }]);
  const keys = Object.keys(context[0]);
  assert.deepEqual(keys.sort(), ["aliases", "canonical_term", "type"]);
});

// ---------------------------------------------------------------------------
// [11][12] AI vocabulary candidates: proposable, but never automatically equivalent to approved
// ---------------------------------------------------------------------------

test("[11] upsertVocabularySuggestions stores a new candidate as source=ai_suggested, status=suggested -- never approved", async () => {
  const source = await readSource("lib/project-vocabulary.ts");
  const fnMatch = source.match(/export async function upsertVocabularySuggestions\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /source: "ai_suggested"/);
  assert.match(fnMatch![0], /status: "suggested"/);
});

test("[12] a repeated AI suggestion only merges alias evidence on rows still status=suggested -- approved/rejected rows are never touched", async () => {
  const source = await readSource("lib/project-vocabulary.ts");
  const fnMatch = source.match(/export async function upsertVocabularySuggestions\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /if \(existing\.status !== "suggested"\) continue;/);
});

test("upsertVocabularySuggestions is idempotent under a duplicate-insert race (ignores unique-violation code 23505)", async () => {
  const source = await readSource("lib/project-vocabulary.ts");
  const fnMatch = source.match(/export async function upsertVocabularySuggestions\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /insertError\.code !== "23505"/);
});

// ---------------------------------------------------------------------------
// Migration: project_vocabulary RLS/isolation, additive-only transcript_segments alteration
// ---------------------------------------------------------------------------

test("migration keeps transcript_segments.text untouched and only adds nullable normalization columns", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(migration, /add column if not exists normalized_text text/);
  assert.match(migration, /add column if not exists normalization_corrections jsonb/);
  assert.match(migration, /add column if not exists normalized_at timestamptz/);
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /alter column .*text.*type/i);
  assert.doesNotMatch(migration, /^update /im);
});

test("[3][14] project_vocabulary is project-scoped via can_access_project RLS, mirroring the existing project_requirements pattern", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(migration, /project_id uuid not null references public\.projects \(id\) on delete cascade/);
  assert.match(migration, /alter table public\.project_vocabulary enable row level security;/);
  assert.match(
    migration,
    /create policy "project_vocabulary_owner_all" on public\.project_vocabulary for all\nusing \(public\.can_access_project\(project_id\)\)\nwith check \(public\.can_access_project\(project_id\)\);/
  );
});

test("project_vocabulary has a case-insensitive per-project unique index on canonical_term", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(
    migration,
    /create unique index project_vocabulary_term_idx\non public\.project_vocabulary \(project_id, lower\(canonical_term\)\);/
  );
});

// ---------------------------------------------------------------------------
// Migration-quality corrections: stale trust-boundary comments + untrimmed canonical_term.
// ---------------------------------------------------------------------------

test("canonical_term must already equal its own trimmed form -- rejects leading/trailing whitespace, not just empty strings", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(
    migration,
    /check \(length\(trim\(canonical_term\)\) > 0 and canonical_term = trim\(canonical_term\)\)/
  );
});

test("no alias uniqueness constraint was added -- alias collisions remain handled by runtime ambiguity logic, not the schema", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.doesNotMatch(migration, /unique.*aliases/i);
  assert.doesNotMatch(migration, /aliases.*unique/i);
});

test("the source/status comments accurately describe status as the sole trust boundary and source as provenance-only, matching the runtime's applyDeterministicAliasCorrections behavior", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(migration, /Provenance only -- where this term originally came from\. Does NOT determine trust/);
  assert.match(migration, /The trust boundary -- independent of `source` above/);
  assert.match(
    migration,
    /regardless of whether it\n {2}-- was originally user_added or ai_suggested/
  );
  assert.doesNotMatch(migration, /highest authority/);
});

test("enum values for source and status are unchanged by the comment/constraint corrections", async () => {
  const migration = await readSource(
    "supabase/migrations/20260905090000_add_transcript_normalization_and_vocabulary.sql"
  );
  assert.match(migration, /check \(source in \('user_added', 'ai_suggested'\)\)/);
  assert.match(migration, /check \(status in \('approved', 'suggested', 'rejected'\)\)/);
});
