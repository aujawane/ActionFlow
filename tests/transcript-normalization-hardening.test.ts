import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dedupeCorrections,
  isCorrectionSpanSafe,
  isParticipantIdentifierExpansion,
  mergeSegmentNormalization
} from "../lib/meeting-analysis/normalization";
import type { TranscriptCorrectionRecord } from "../lib/types";

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function correction(overrides: Partial<TranscriptCorrectionRecord> = {}): TranscriptCorrectionRecord {
  return {
    original_token: overrides.original_token ?? "parfit",
    replacement: overrides.replacement ?? "Parfait",
    confidence: overrides.confidence ?? 0.98,
    reason: overrides.reason ?? "matches known project vocabulary",
    source: overrides.source ?? "model",
    applied: overrides.applied ?? true
  };
}

// ---------------------------------------------------------------------------
// [Hardening 1] Participant-name / internal-ID expansion guard
// ---------------------------------------------------------------------------

test("[Hardening 1] REJECT: a short spoken name is never expanded into a longer participant identifier ('craig' -> 'craiglauer')", () => {
  assert.equal(
    isParticipantIdentifierExpansion("craig", "craiglauer", ["craiglauer"]),
    true
  );
});

test("[Hardening 1] REJECT: the same expansion is caught even when the participant label is properly spaced/capitalized ('Craig Lauer')", () => {
  assert.equal(
    isParticipantIdentifierExpansion("craig", "Craig Lauer", ["Craig Lauer"]),
    true
  );
});

test("[Hardening 1] REJECT: expansion via an email-derived/handle-style participant label", () => {
  assert.equal(
    isParticipantIdentifierExpansion("craig", "craig.lauer99", ["craig.lauer99"]),
    true
  );
});

test("[Hardening 1] ACCEPT: a pure capitalization/case fix is never treated as an expansion ('cameron' -> 'Cameron')", () => {
  assert.equal(
    isParticipantIdentifierExpansion("cameron", "Cameron", ["Cameron"]),
    false
  );
});

test("[Hardening 1] ACCEPT: an unrelated entity correction is unaffected even when participants are present ('farfelder' -> 'Parfait')", () => {
  assert.equal(
    isParticipantIdentifierExpansion("farfelder", "Parfait", ["Craig Lauer", "Cameron"]),
    false
  );
});

test("[Hardening 1] ACCEPT: no participants at all -- nothing to match against, so no expansion is flagged", () => {
  assert.equal(isParticipantIdentifierExpansion("craig", "craiglauer", []), false);
});

test("[Hardening 1] ACCEPT: replacement is shorter than or equal in length to the original token -- never an expansion by definition", () => {
  assert.equal(isParticipantIdentifierExpansion("craiglauer", "Craig", ["Craig"]), false);
});

test("[Hardening 1] the guard is generic -- it is not hardcoded to any specific name", () => {
  assert.equal(
    isParticipantIdentifierExpansion("sam", "samantha.reyes", ["samantha.reyes"]),
    true
  );
  assert.equal(
    isParticipantIdentifierExpansion("dev", "devanshu_k", ["devanshu_k"]),
    true
  );
});

test("[Hardening 1] wiring: normalizeMeetingTranscriptForAnalysis gates `applied` on isParticipantIdentifierExpansion, not confidence alone", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(
    source,
    /!isParticipantIdentifierExpansion\(correction\.original_token, correction\.replacement, participants\)/
  );
});

test("[Hardening 1] the participant-expansion guard does NOT gate the human-approved deterministic vocabulary pass -- approved aliases remain the strongest path", async () => {
  const source = await readSource("lib/project-vocabulary.ts");
  assert.doesNotMatch(source, /isParticipantIdentifierExpansion/);
});

// ---------------------------------------------------------------------------
// [Hardening 2] Programmatic correction-span safety guard
// ---------------------------------------------------------------------------

test("[Hardening 2] a normal single-token entity correction is safe", () => {
  assert.equal(isCorrectionSpanSafe("parfit"), true);
  assert.equal(isCorrectionSpanSafe("Parfait"), true);
  assert.equal(isCorrectionSpanSafe("codecs"), true);
  assert.equal(isCorrectionSpanSafe("Codex"), true);
});

test("[Hardening 2] a legitimate multi-word entity correction is safe", () => {
  for (const value of [
    "cloud code",
    "Claude Code",
    "visual studio",
    "Visual Studio Code",
    "san diego state",
    "San Diego State University"
  ]) {
    assert.equal(isCorrectionSpanSafe(value), true, value);
  }
});

test("[Hardening 2] an obviously sentence-like correction cannot be safe (auto-apply eligible)", () => {
  assert.equal(isCorrectionSpanSafe("I will deploy it tomorrow morning after standup"), false);
  assert.equal(isCorrectionSpanSafe("Yeah, I'll do that."), false);
  assert.equal(isCorrectionSpanSafe("we should loop in Zoraxis about the schema"), false);
  assert.equal(isCorrectionSpanSafe("Thanks, I'll handle it"), false);
});

test("[Hardening 2] a domain containing a dot is safe -- a bare period is no longer treated as sentence-terminal punctuation", () => {
  assert.equal(isCorrectionSpanSafe("example.com"), true);
  assert.equal(isCorrectionSpanSafe("docs.anthropic.com"), true);
});

test("[Hardening 2] an entity name containing ordinary words like 'of' or 'The' is safe", () => {
  assert.equal(isCorrectionSpanSafe("University of North Carolina"), true);
  assert.equal(isCorrectionSpanSafe("The Ohio State University"), true);
});

test("[Hardening 2] an entity name containing '&' or '-' is safe", () => {
  assert.equal(isCorrectionSpanSafe("Barnes & Noble"), true);
  assert.equal(isCorrectionSpanSafe("AT&T"), true);
  assert.equal(isCorrectionSpanSafe("Coca-Cola"), true);
});

test("[Hardening 2] a short clause is unsafe: pronoun + modal verb co-occurring disqualifies the span even when short", () => {
  assert.equal(isCorrectionSpanSafe("we will deploy"), false);
  assert.equal(isCorrectionSpanSafe("I will"), false);
  assert.equal(isCorrectionSpanSafe("we can"), false);
});

test("[Hardening 2] a longer sentence-like replacement is unsafe", () => {
  assert.equal(
    isCorrectionSpanSafe("We will go ahead and deploy the updated service tomorrow"),
    false
  );
});

test("[Hardening 2] a pronoun+modal contraction alone disqualifies a span, even with no bare pronoun/modal word and no terminal punctuation", () => {
  assert.equal(isCorrectionSpanSafe("Yeah, I'll do that"), false);
  assert.equal(isCorrectionSpanSafe("we're on it"), false);
});

test("[Hardening 2] neither a bare pronoun nor a bare modal verb alone is disqualifying -- only their co-occurrence is", () => {
  assert.equal(isCorrectionSpanSafe("Will Smith"), true);
  assert.equal(isCorrectionSpanSafe("University of North Carolina"), true); // contains no pronoun at all
});

test("[Hardening 2] `!` and `?` remain disqualifying -- the only punctuation marks still treated as a strong sentence signal", () => {
  assert.equal(isCorrectionSpanSafe("Parfait!"), false);
  assert.equal(isCorrectionSpanSafe("Parfait?"), false);
});

test("[Hardening 2] a long span with no clause signal at all is still bounded by the word-count backstop", () => {
  assert.equal(
    isCorrectionSpanSafe("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda"),
    false
  );
});

test("[Hardening 2] an empty or whitespace-only span is never safe", () => {
  assert.equal(isCorrectionSpanSafe(""), false);
  assert.equal(isCorrectionSpanSafe("   "), false);
});

test("[Hardening 2] wiring: applied requires BOTH original_token and replacement to pass isCorrectionSpanSafe", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(source, /isCorrectionSpanSafe\(correction\.original_token\)/);
  assert.match(source, /isCorrectionSpanSafe\(correction\.replacement\)/);
});

test("[Hardening 2] an unsafe correction span never alters normalized_text -- the raw original text is preserved", () => {
  const raw = "yeah i'll do that, we should loop in the team about it";
  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    // Simulates what the pipeline would produce for a hallucinated sentence-like correction: the
    // span-safety guard forces applied=false before this record is ever built in production, but
    // this test proves the merge step itself is also safe even if an unapplied record reaches it.
    modelCorrections: [
      correction({
        original_token: "we should loop in the team about it",
        replacement: "We will notify the whole team immediately",
        confidence: 0.99,
        applied: false
      })
    ]
  });
  assert.equal(outcome.normalizedText, null);
  assert.equal(outcome.corrections.length, 1);
  assert.equal(outcome.corrections[0].applied, false);
});

// ---------------------------------------------------------------------------
// [Hardening 3] Deduplicate overlapping-batch corrections
// ---------------------------------------------------------------------------

test("[Hardening 3] an exact duplicate proposal (same original_token/replacement/source) collapses to one entry", () => {
  const result = dedupeCorrections([correction(), correction()]);
  assert.equal(result.length, 1);
});

test("[Hardening 3] the real-run case: 'parfit' -> 'Parfait' proposed twice by overlapping batches persists exactly once", () => {
  const result = dedupeCorrections([
    correction({ original_token: "parfit", replacement: "Parfait", confidence: 0.98 }),
    correction({ original_token: "parfit", replacement: "Parfait", confidence: 0.98 })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].original_token, "parfit");
  assert.equal(result[0].replacement, "Parfait");
});

test("[Hardening 3] genuinely different proposals for the same segment are never removed", () => {
  const result = dedupeCorrections([
    correction({ original_token: "parfit", replacement: "Parfait" }),
    correction({ original_token: "codecs", replacement: "Codex" })
  ]);
  assert.equal(result.length, 2);
});

test("[Hardening 3] a different original_token or a different replacement is NOT a duplicate, even for the same segment/source", () => {
  const sameTokenDifferentReplacement = dedupeCorrections([
    correction({ original_token: "parfit", replacement: "Parfait" }),
    correction({ original_token: "parfit", replacement: "Perfect" })
  ]);
  assert.equal(sameTokenDifferentReplacement.length, 2);
});

test("[Hardening 3] a different source (deterministic vs model) is never collapsed together", () => {
  const result = dedupeCorrections([
    correction({ source: "deterministic" }),
    correction({ source: "model" })
  ]);
  assert.equal(result.length, 2);
});

test("[Hardening 3] when duplicates disagree on confidence, the strongest (highest-confidence) proposal is kept", () => {
  const result = dedupeCorrections([
    correction({ confidence: 0.91 }),
    correction({ confidence: 0.98 })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 0.98);
});

test("[Hardening 3] when duplicates tie on confidence, the first-encountered proposal is kept deterministically", () => {
  const first = correction({ reason: "first batch" });
  const second = correction({ reason: "second batch" });
  const result = dedupeCorrections([first, second]);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "first batch");
});

test("[Hardening 3] output order is deterministic first-occurrence order across repeated calls with identical input", () => {
  const input = [
    correction({ original_token: "codecs", replacement: "Codex" }),
    correction({ original_token: "parfit", replacement: "Parfait" }),
    correction({ original_token: "codecs", replacement: "Codex" })
  ];
  const first = dedupeCorrections(input);
  const second = dedupeCorrections(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.equal(first[0].original_token, "codecs");
  assert.equal(first[1].original_token, "parfit");
});

test("[Hardening 3] wiring: the persistence loop dedupes model corrections before merging", async () => {
  const source = await readSource("lib/meeting-analysis/normalization.ts");
  assert.match(source, /dedupeCorrections\(proposedBySegment\.get\(segment\.id\) \?\? \[\]\)/);
});
