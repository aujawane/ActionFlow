import assert from "node:assert/strict";
import test from "node:test";

import { mergeSegmentNormalization } from "../lib/meeting-analysis/normalization";
import { runTranscriptNormalizationModel } from "../lib/execution-intelligence/work-item-model";
import { TRANSCRIPT_NORMALIZATION_PROMPT } from "../lib/execution-intelligence/work-item-prompts";
import type { TranscriptCorrectionRecord } from "../lib/types";

const SEG_1 = "11111111-1111-4111-8111-111111111111";
const SEG_2 = "22222222-2222-4222-8222-222222222222";
const SEG_3 = "33333333-3333-4333-8333-333333333333";

function fakeModelResponse(payload: unknown) {
  return async () => ({ output_text: JSON.stringify(payload) });
}

async function getCorrectionRecords(input: {
  transcript: string;
  modelPayload: unknown;
}): Promise<Map<string, TranscriptCorrectionRecord[]>> {
  const result = await runTranscriptNormalizationModel({
    systemPrompt: TRANSCRIPT_NORMALIZATION_PROMPT,
    context: { transcript: input.transcript },
    createResponse: fakeModelResponse(input.modelPayload)
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const bySegment = new Map<string, TranscriptCorrectionRecord[]>();
  for (const correction of result.corrections) {
    const list = bySegment.get(correction.segment_id) ?? [];
    list.push({
      original_token: correction.original_token,
      replacement: correction.replacement,
      confidence: correction.confidence,
      reason: correction.reason,
      source: "model",
      applied: correction.confidence >= 0.9
    });
    bySegment.set(correction.segment_id, list);
  }
  return bySegment;
}

// ---------------------------------------------------------------------------
// [23] Example A: Parfait
// ---------------------------------------------------------------------------

test("[23] Example A: 'parface' -> 'Parfait' via a grounded entity-name token swap, nothing else rewritten", async () => {
  const raw = "by the way i have some good news of parface live now";
  const corrections = await getCorrectionRecords({
    transcript: `[${SEG_1}] [2026-01-01T00:00:00.000Z] Aditya: ${raw}`,
    modelPayload: {
      corrections: [
        {
          segment_id: SEG_1,
          original_text: raw,
          normalized_text: raw.replace("parface", "Parfait"),
          original_token: "parface",
          replacement: "Parfait",
          reason: "Matches known project vocabulary (Parfait).",
          confidence: 0.98,
          evidence: "Parfait is the product being discussed throughout the meeting."
        }
      ],
      vocabulary_candidates: []
    }
  });

  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: corrections.get(SEG_1) ?? []
  });

  // Strict entity-only substitution -- NOT the more casually reworded "good news, Parfait's live
  // now" some illustrative phrasing might suggest; the prompt's repeated "never paraphrase or
  // reword" rule takes precedence over any looser reading.
  assert.equal(outcome.normalizedText, "by the way i have some good news of Parfait live now");
});

// ---------------------------------------------------------------------------
// [23] Example B: Vercel
// ---------------------------------------------------------------------------

test("[23] Example B: 'versailles' -> 'Vercel', grounded by deployment/hosting context", async () => {
  const raw = "i deployed it on versailles";
  const corrections = await getCorrectionRecords({
    transcript: `[${SEG_1}] [2026-01-01T00:00:00.000Z] Aditya: ${raw}`,
    modelPayload: {
      corrections: [
        {
          segment_id: SEG_1,
          original_text: raw,
          normalized_text: "i deployed it on Vercel",
          original_token: "versailles",
          replacement: "Vercel",
          reason: "Matches known project vocabulary (Vercel); context is deployment/hosting.",
          confidence: 0.99,
          evidence: "Meeting discusses hosting/deployment throughout."
        }
      ],
      vocabulary_candidates: []
    }
  });

  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: corrections.get(SEG_1) ?? []
  });
  assert.equal(outcome.normalizedText, "i deployed it on Vercel");
});

// ---------------------------------------------------------------------------
// [23] Example C: Codex, grounded by surrounding conversation, not the segment alone
// ---------------------------------------------------------------------------

test("[23] Example C: 'codecs' -> 'Codex', grounded by nearby segments discussing Codex/the 100 plan", async () => {
  const surrounding = `[${SEG_1}] [2026-01-01T00:00:00.000Z] Aditya: we've been using Codex for the harder refactors\n[${SEG_2}] [2026-01-01T00:00:01.000Z] Cameron: i think cameron made it and haven't used it yet but i think so we have the 100 plan\n[${SEG_3}] [2026-01-01T00:00:02.000Z] Aditya: yeah the codecs subscription covers that`;
  const raw = "yeah the codecs subscription covers that";
  const corrections = await getCorrectionRecords({
    transcript: surrounding,
    modelPayload: {
      corrections: [
        {
          segment_id: SEG_3,
          original_text: raw,
          normalized_text: "yeah the Codex subscription covers that",
          original_token: "codecs",
          replacement: "Codex",
          reason: "Codex was named explicitly two turns earlier in this same window.",
          confidence: 0.95,
          evidence: "Segment 1 names Codex directly; 'codecs' here is a mishearing of the same word."
        }
      ],
      vocabulary_candidates: []
    }
  });

  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: corrections.get(SEG_3) ?? []
  });
  assert.equal(outcome.normalizedText, "yeah the Codex subscription covers that");
});

// ---------------------------------------------------------------------------
// [23] Example D: informal speech is preserved verbatim -- no forced rewrite into a commitment
// ---------------------------------------------------------------------------

test("[23] Example D: informal, filler-laden speech about frontend work is preserved -- never rewritten into a commitment statement", () => {
  const raw = "i can do like front end mostly yeah i can do that";
  // A well-behaved model proposes NOTHING for this segment -- there is no mis-transcribed entity
  // here, only ordinary informal speech, which the prompt explicitly forbids touching.
  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: []
  });
  assert.equal(outcome.normalizedText, null);
  assert.notEqual(outcome.normalizedText, "I will handle frontend development.");
});

// ---------------------------------------------------------------------------
// [23] Example E: ordinary English "recall" is never converted to "Recall.ai"
// ---------------------------------------------------------------------------

test("[23] Example E: ordinary 'recall' the verb is never auto-converted to 'Recall.ai', even with that vocabulary present", () => {
  const raw = "we need to recall what happened yesterday";
  // A well-behaved model proposes nothing here (matches the prompt's explicit "recall" example);
  // the deterministic stoplist independently guarantees the same outcome (see
  // tests/project-vocabulary.test.ts).
  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: []
  });
  assert.equal(outcome.normalizedText, null);
});

// ---------------------------------------------------------------------------
// [23] Example F: ambiguous unknown proper noun -- left unchanged, optionally a low-confidence
// vocabulary suggestion, never an automatic correction.
// ---------------------------------------------------------------------------

test("[23] Example F: an ambiguous unfamiliar proper noun with no supporting context is left unchanged; may surface as a vocabulary candidate, never a correction", async () => {
  const raw = "we should loop in zoraxis about the schema";
  const result = await runTranscriptNormalizationModel({
    systemPrompt: TRANSCRIPT_NORMALIZATION_PROMPT,
    context: { transcript: `[${SEG_1}] [2026-01-01T00:00:00.000Z] Aditya: ${raw}` },
    createResponse: fakeModelResponse({
      corrections: [],
      vocabulary_candidates: [
        {
          canonical_term: "Zoraxis",
          observed_alias: "zoraxis",
          confidence: 0.35,
          evidence_segment_ids: [SEG_1]
        }
      ]
    })
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.corrections.length, 0);
  assert.equal(result.vocabularyCandidates.length, 1);
  assert.equal(result.vocabularyCandidates[0].confidence, 0.35);

  const outcome = mergeSegmentNormalization({
    originalText: raw,
    deterministicText: null,
    deterministicCorrections: [],
    modelCorrections: []
  });
  assert.equal(outcome.normalizedText, null);
});
