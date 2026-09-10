import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ProjectVocabularyTerm, TranscriptCorrectionRecord } from "@/lib/types";

/**
 * Ordinary English words that are also plausible-looking aliases (e.g. "Recall.ai" vs the verb
 * "recall") -- deterministic, no-LLM-adjudication replacement is refused for these even if a
 * human explicitly added them as an alias, since a whole-word match is not by itself strong
 * enough evidence for an unattended global-ish replacement. The LLM normalization pass (which
 * sees surrounding context) can still correct these; only the cheap deterministic pre-pass is
 * restricted. This list is intentionally small and reviewable, not exhaustive -- extend
 * conservatively.
 */
export const DETERMINISTIC_ALIAS_STOPLIST = new Set([
  "recall",
  "call",
  "calls",
  "called",
  "base",
  "code",
  "form",
  "post",
  "act",
  "search",
  "open",
  "close",
  "run",
  "check",
  "meet",
  "meets",
  "work",
  "works",
  "task",
  "tasks",
  "team",
  "plan",
  "plans",
  "test",
  "tests",
  "build",
  "flow",
  "safe",
  "next",
  "site",
  "space",
  "cloud",
  "brain",
  "note",
  "notes",
  "sync",
  "deploy",
  "deploys",
  "ship"
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDeterministicallyEligible(alias: string, canonicalTerm: string): boolean {
  const normalizedAlias = alias.trim().toLowerCase();
  if (!normalizedAlias) return false;
  // Exact-string (not case-insensitive) self-match only -- a lowercase mishearing like "cameron"
  // must still be eligible to correct into the properly-capitalized canonical "Cameron".
  if (alias.trim() === canonicalTerm.trim()) return false;
  if (DETERMINISTIC_ALIAS_STOPLIST.has(normalizedAlias)) return false;
  if (normalizedAlias.length < 3) return false;
  return true;
}

/**
 * Fetches only APPROVED project vocabulary -- suggested/rejected entries never ground
 * normalization or participate in deterministic replacement. `status = "approved"` is the trust
 * boundary, not `source`: an AI-suggested term a human later approves is fetched here and trusted
 * exactly like one a human typed in directly. `source` remains on the row purely as provenance
 * (where the term originally came from), never as an eligibility gate.
 */
export async function getApprovedProjectVocabulary(
  projectId: string
): Promise<ProjectVocabularyTerm[]> {
  const { data, error } = await supabaseAdmin
    .from("project_vocabulary")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "approved")
    .order("canonical_term", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectVocabularyTerm[];
}

/** Compact shape sent to the normalization prompt -- never the full row (no ids/timestamps/etc). */
export function buildVocabularyPromptContext(
  terms: ProjectVocabularyTerm[]
): Array<{ canonical_term: string; aliases: string[]; type: ProjectVocabularyTerm["term_type"] }> {
  return terms.map((term) => ({
    canonical_term: term.canonical_term,
    aliases: term.aliases,
    type: term.term_type
  }));
}

/**
 * Resolves which (lowercased) aliases are safe to deterministically replace, project-wide, before
 * touching any segment text. `status = "approved"` is the sole trust boundary -- `source` (where
 * the term originally came from) is provenance only and never gates eligibility, so a term a
 * human explicitly approves after it was AI-suggested becomes just as trusted as one they typed
 * in directly. An alias claimed by more than one distinct approved canonical term is ambiguous
 * and is excluded entirely: resolving the map up front, keyed by the lowercased alias, means the
 * outcome can never depend on which row happens to come first in `vocabulary`'s order (array/DB
 * ordering never matters here) or on which project the caller scoped `vocabulary` to (a
 * collision in one project's vocabulary list has no way to see or affect another project's, since
 * this function only ever sees whatever the caller already scoped).
 */
function resolveUnambiguousDeterministicAliases(
  vocabulary: ProjectVocabularyTerm[]
): Array<{ aliasKey: string; alias: string; canonicalTerm: string }> {
  const eligibleTerms = vocabulary.filter((term) => term.status === "approved");

  const canonicalsByAliasKey = new Map<string, Map<string, string>>();
  for (const term of eligibleTerms) {
    for (const alias of term.aliases) {
      if (!isDeterministicallyEligible(alias, term.canonical_term)) continue;
      const aliasKey = alias.trim().toLowerCase();
      const byCanonical = canonicalsByAliasKey.get(aliasKey) ?? new Map<string, string>();
      byCanonical.set(term.canonical_term, alias);
      canonicalsByAliasKey.set(aliasKey, byCanonical);
    }
  }

  const unambiguous: Array<{ aliasKey: string; alias: string; canonicalTerm: string }> = [];
  for (const [aliasKey, byCanonical] of canonicalsByAliasKey) {
    if (byCanonical.size !== 1) continue; // claimed by 2+ distinct canonical terms -- ambiguous, refuse
    const [[canonicalTerm, alias]] = byCanonical;
    unambiguous.push({ aliasKey, alias, canonicalTerm });
  }
  // Longest alias first so e.g. "recall.ai" is matched before a shorter alias that could be its
  // substring -- unrelated to the ambiguity resolution above.
  return unambiguous.sort((a, b) => b.aliasKey.length - a.aliasKey.length);
}

/**
 * Safe, targeted, whole-word, case-insensitive replacement of a segment's raw text against
 * APPROVED vocabulary aliases only (see resolveUnambiguousDeterministicAliases for the trust and
 * ambiguity rules) -- never for global/ambiguous words (see DETERMINISTIC_ALIAS_STOPLIST) and
 * never for an alias claimed by two different approved canonical terms. This exists purely to
 * skip a wasted LLM call for the subset of corrections we already know for certain; anything not
 * covered here (including any ambiguous alias) is still eligible for the LLM pass to adjudicate
 * with full surrounding context.
 */
export function applyDeterministicAliasCorrections(
  segments: Array<{ id: string; text: string }>,
  vocabulary: ProjectVocabularyTerm[]
): {
  correctedText: Map<string, string>;
  corrections: Map<string, TranscriptCorrectionRecord[]>;
} {
  const unambiguousAliases = resolveUnambiguousDeterministicAliases(vocabulary);
  const correctedText = new Map<string, string>();
  const corrections = new Map<string, TranscriptCorrectionRecord[]>();

  for (const segment of segments) {
    let text = segment.text;
    const segmentCorrections: TranscriptCorrectionRecord[] = [];

    for (const { aliasKey, alias, canonicalTerm } of unambiguousAliases) {
      const pattern = new RegExp(`\\b${escapeRegExp(aliasKey)}\\b`, "gi");
      if (!pattern.test(text)) continue;
      text = text.replace(new RegExp(`\\b${escapeRegExp(aliasKey)}\\b`, "gi"), canonicalTerm);
      segmentCorrections.push({
        original_token: alias,
        replacement: canonicalTerm,
        confidence: 1,
        reason: "Matches an approved project vocabulary alias.",
        source: "deterministic",
        applied: true
      });
    }

    if (text !== segment.text) correctedText.set(segment.id, text);
    if (segmentCorrections.length > 0) corrections.set(segment.id, segmentCorrections);
  }

  return { correctedText, corrections };
}

export type VocabularyCandidateInput = {
  canonicalTerm: string;
  observedAlias: string | null;
  confidence: number;
  evidenceMeetingId: string;
  evidenceSegmentIds: string[];
};

/**
 * Idempotent, conservative learning: a brand-new term is stored as an unapproved suggestion
 * (source="ai_suggested", status="suggested"); a repeated suggestion for the same canonical term
 * (case-insensitive) only accumulates alias evidence on a row that is STILL "suggested" -- an
 * already-approved or explicitly-rejected entry's canonical data is never touched by this
 * function, so one hallucinated correction can never override or masquerade as approved
 * vocabulary. Never throws on a duplicate-insert race (best-effort, not a critical write path).
 */
export async function upsertVocabularySuggestions(
  projectId: string,
  candidates: VocabularyCandidateInput[]
): Promise<void> {
  for (const candidate of candidates) {
    const canonicalTerm = candidate.canonicalTerm.trim();
    if (!canonicalTerm) continue;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("project_vocabulary")
      .select("id, status, aliases")
      .eq("project_id", projectId)
      .ilike("canonical_term", canonicalTerm)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from("project_vocabulary").insert({
        project_id: projectId,
        canonical_term: canonicalTerm,
        aliases: candidate.observedAlias ? [candidate.observedAlias] : [],
        term_type: "other",
        source: "ai_suggested",
        status: "suggested",
        confidence: candidate.confidence,
        evidence_meeting_id: candidate.evidenceMeetingId,
        evidence_segment_ids: candidate.evidenceSegmentIds
      });
      if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
      continue;
    }

    if (existing.status !== "suggested") continue;
    if (!candidate.observedAlias) continue;
    const mergedAliases = Array.from(
      new Set([...(existing.aliases ?? []), candidate.observedAlias])
    );
    if (mergedAliases.length === (existing.aliases ?? []).length) continue;
    const { error: updateError } = await supabaseAdmin
      .from("project_vocabulary")
      .update({ aliases: mergedAliases })
      .eq("id", existing.id);
    if (updateError) throw new Error(updateError.message);
  }
}
