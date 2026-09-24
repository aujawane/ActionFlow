import {
  getTranscriptNormalizationAutoThreshold,
  getV4StageTimeoutMs,
  isTranscriptNormalizationEnabled
} from "@/lib/env";
import { buildTranscriptWithSegmentIds } from "@/lib/analysis";
import {
  runTranscriptNormalizationModel,
  type CreateStructuredResponse
} from "@/lib/execution-intelligence/work-item-model";
import { TRANSCRIPT_NORMALIZATION_PROMPT } from "@/lib/execution-intelligence/work-item-prompts";
import { participantMap } from "@/lib/execution-intelligence/stages";
import {
  applyDeterministicAliasCorrections,
  buildVocabularyPromptContext,
  getApprovedProjectVocabulary,
  upsertVocabularySuggestions,
  type VocabularyCandidateInput
} from "@/lib/project-vocabulary";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canonicalTranscriptOrder } from "@/lib/transcript-order";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";
import type { TranscriptCorrectionRecord, TranscriptSegment } from "@/lib/types";

export const NORMALIZATION_BATCH_SIZE = 40;
export const NORMALIZATION_BATCH_OVERLAP = 5;

/**
 * Splits ordered segments into overlapping batches for normalization. Unlike
 * lib/execution-intelligence/chunking.ts's topic-boundary-aware chunker, this has no topics to
 * work from yet -- normalization runs BEFORE topic extraction -- so it's a plain fixed-size
 * sliding window. The overlap gives the model a chance to see a segment's neighbors on both
 * sides even near a batch boundary; duplicate proposals for the same segment across overlapping
 * batches are harmless (see mergeCorrectionsForSegment below).
 */
export function chunkSegmentsForNormalization<T>(
  segments: readonly T[],
  batchSize: number = NORMALIZATION_BATCH_SIZE,
  overlap: number = NORMALIZATION_BATCH_OVERLAP
): T[][] {
  if (segments.length === 0) return [];
  if (segments.length <= batchSize) return [segments.slice() as T[]];

  const batches: T[][] = [];
  let start = 0;
  while (start < segments.length) {
    const end = Math.min(start + batchSize, segments.length);
    batches.push(segments.slice(start, end) as T[]);
    if (end >= segments.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return batches;
}

/** First-occurrence-only, single-token replacement -- mirrors
 * lib/execution-intelligence/transcript-normalization.ts's applyTranscriptCorrections semantics,
 * scoped to one segment's text instead of a whole marked-up transcript. A no-op (returns text
 * unchanged) if the token isn't present, which also makes a duplicate correction proposed twice
 * by overlapping batches safe -- the second application finds nothing left to replace. */
export function applyTokenReplacement(text: string, originalToken: string, replacement: string): string {
  if (!originalToken || !text.includes(originalToken)) return text;
  return text.replace(originalToken, replacement);
}

/**
 * ---------------------------------------------------------------------------
 * Correction safety guards -- deterministic backstops applied ON TOP OF the model's own
 * confidence score, never a substitute for it. Both guards below can only ever turn an
 * otherwise-eligible correction into `applied: false` (a recorded-but-unapplied suggestion, kept
 * for observability); they can never cause normalized_text to contain something the model didn't
 * already propose, and they never touch transcript_segments.text.
 * ---------------------------------------------------------------------------
 */

/**
 * Rejects a correction that would expand a short, independently-valid spoken word/name into a
 * longer participant/speaker identifier (a concatenated full name, username, handle, or
 * slug-like label) purely because that fuller string happens to appear in this meeting's
 * participant list. Real failure this guards against: a speaker literally says "craig" (a
 * complete, valid word/name on its own), and the model -- seeing "craiglauer" as a participant
 * label in the same window -- "completes" the short word into that longer identifier. Normalizing
 * corrects MIS-TRANSCRIBED entity names; it must never complete a correctly-heard short name into
 * a longer identifier just because a longer string containing it exists in participant metadata.
 *
 * Deliberately generic (not name-specific): compares the alphanumeric-only, lowercased forms of
 * `originalToken` and `replacement`. A correction is rejected only when the replacement is a
 * strict extension of the original token (same leading characters, then MORE characters) and that
 * extended form matches a participant/speaker label from this meeting -- not merely a
 * capitalization or spacing fix (e.g. "cameron" -> "Cameron" is unaffected: same length after
 * normalization, so it is never treated as an expansion). This intentionally does NOT gate the
 * separate, human-approved-vocabulary deterministic pass (applyDeterministicAliasCorrections) --
 * an approved alias->canonical mapping is a human decision, not an ungrounded model inference from
 * raw metadata, and remains the strongest, most-trusted correction path (see project-vocabulary.ts).
 */
export function isParticipantIdentifierExpansion(
  originalToken: string,
  replacement: string,
  participants: readonly string[]
): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedOriginal = normalize(originalToken);
  const normalizedReplacement = normalize(replacement);
  if (!normalizedOriginal || normalizedReplacement.length <= normalizedOriginal.length) {
    return false;
  }
  if (!normalizedReplacement.startsWith(normalizedOriginal)) return false;
  return participants.some((participant) => normalize(participant) === normalizedReplacement);
}

const MAX_CORRECTION_SPAN_WORDS = 10;
const MAX_CORRECTION_SPAN_LENGTH = 80;

/**
 * Personal pronouns. On their own these are NOT disqualifying -- a real entity name can contain
 * one ("Will Smith" contains no pronoun, but nothing rules out e.g. a band or product using a
 * pronoun-like word) -- they only become a meaningful signal when an auxiliary/modal verb from
 * MODAL_AUX_WORDS also appears elsewhere in the same span (see isCorrectionSpanSafe).
 */
const PRONOUN_WORDS = new Set([
  "i", "you", "we", "he", "she", "it", "they", "me", "us", "him", "her", "them"
]);

/**
 * Auxiliary/modal verbs. Also NOT disqualifying alone -- "Will" is a common first name, "Was"
 * appears in real titles -- but paired with a pronoun elsewhere in the span (see below), the
 * combination is strong, generic evidence of a finite clause ("we will deploy") rather than a
 * noun-phrase entity name.
 */
const MODAL_AUX_WORDS = new Set([
  "will", "would", "can", "could", "should", "must", "shall", "may", "might",
  "is", "are", "was", "were", "am", "do", "does", "did", "have", "has", "had"
]);

/**
 * Contractions that fuse a pronoun and an auxiliary/modal verb into a single token ("I'll",
 * "don't", "we're"). Each one alone is as strong a clause signal as the pronoun+modal pair above --
 * this practically never appears as, or inside, a real entity name.
 */
const PRONOUN_MODAL_CONTRACTIONS = new Set([
  "i'll", "we'll", "you'll", "he'll", "she'll", "they'll",
  "i'd", "we'd", "you'd", "he'd", "she'd", "they'd",
  "i'm", "we're", "you're", "they're",
  "don't", "doesn't", "didn't", "won't", "can't", "couldn't", "wouldn't", "shouldn't",
  "isn't", "aren't", "wasn't", "weren't"
]);

/** Strips everything except letters/apostrophes so "I'll" and "don't" survive intact while
 * surrounding punctuation (a trailing period, a leading/trailing comma, an ampersand token) does
 * not affect word matching either way. */
function normalizeSpanWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, "");
}

/**
 * Deterministic backstop against a correction span (checked on BOTH `original_token` and
 * `replacement`) that reads as a clause or sentence rather than an entity name -- WITHOUT assuming
 * a valid entity name can't contain ordinary punctuation or common words. Real entity names
 * routinely contain a dot ("example.com"), a hyphen or ampersand ("Coca-Cola", "Barnes & Noble"),
 * an apostrophe ("Trader Joe's"), or ordinary words like "of"/"The"/"and" ("University of North
 * Carolina", "The Ohio State University", "Ben & Jerry's"). None of those are disqualifying here.
 * The production prompt already restricts corrections to entity names; this is a defense-in-depth
 * backstop against a non-compliant or hallucinating model response, not a grammar parser.
 *
 * The exact rule -- any ONE of the following disqualifies the span:
 *   1. Contains `!` or `?` anywhere -- essentially never part of a real entity name, and unlike
 *      `.` `,` `-` `'` `/` `&` carries almost no legitimate-entity false-positive risk.
 *   2. Contains a pronoun+modal CONTRACTION ("I'll", "don't", "we're", ...) -- fuses a subject and
 *      a finite verb into one token, which practically never happens inside an entity name.
 *   3. Contains a personal pronoun (I/you/we/he/she/it/they/...) AND, elsewhere in the same span,
 *      an auxiliary/modal verb (will/would/can/is/are/...). Neither alone is disqualifying, but
 *      their CO-OCCURRENCE is strong, generic evidence of a clause ("we will deploy") rather than
 *      a noun-phrase entity name.
 *   4. More than 10 words, or more than 80 characters -- a generous but still bounded backstop
 *      against a long hallucinated clause/paragraph that happens to avoid signals 1-3 entirely;
 *      comfortably above any real multi-word entity name seen in practice.
 */
export function isCorrectionSpanSafe(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/[!?]/.test(trimmed)) return false;
  if (trimmed.length > MAX_CORRECTION_SPAN_LENGTH) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_CORRECTION_SPAN_WORDS) return false;

  let hasPronoun = false;
  let hasModal = false;
  for (const rawWord of words) {
    const word = normalizeSpanWord(rawWord);
    if (PRONOUN_MODAL_CONTRACTIONS.has(word)) return false;
    if (PRONOUN_WORDS.has(word)) hasPronoun = true;
    if (MODAL_AUX_WORDS.has(word)) hasModal = true;
  }
  return !(hasPronoun && hasModal);
}

/**
 * Collapses overlapping-batch duplicate proposals for the same segment before they're persisted.
 * The 5-segment batch overlap (see chunkSegmentsForNormalization) means the SAME correction is
 * routinely proposed twice by two different LLM calls for a segment near a batch boundary --
 * harmless for the actually-applied text (applyTokenReplacement is a safe no-op on the second
 * application), but without this, both proposals were persisted as separate entries in
 * normalization_corrections, doubling the audit trail for no reason. A duplicate is identified by
 * the (source, original_token, replacement) triple exactly as given -- deliberately NOT
 * case-normalized or fuzzy, so two proposals that genuinely differ (even subtly) are always both
 * kept. When duplicates disagree on confidence, the highest-confidence proposal wins (a tie keeps
 * whichever was encountered first); output order is the input's first-occurrence order, which is
 * itself deterministic because the batch loop that produces `corrections` always runs in the same
 * fixed order.
 */
export function dedupeCorrections(
  corrections: readonly TranscriptCorrectionRecord[]
): TranscriptCorrectionRecord[] {
  const bestByKey = new Map<string, TranscriptCorrectionRecord>();
  const order: string[] = [];
  for (const correction of corrections) {
    const key = `${correction.source}::${correction.original_token}::${correction.replacement}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      order.push(key);
      bestByKey.set(key, correction);
    } else if (correction.confidence > existing.confidence) {
      bestByKey.set(key, correction);
    }
  }
  return order.map((key) => bestByKey.get(key)!);
}

export type SegmentNormalizationOutcome = {
  normalizedText: string | null;
  corrections: TranscriptCorrectionRecord[];
};

/**
 * Pure merge of one segment's raw text with its deterministic and model-proposed corrections into
 * the final persisted outcome -- exported so the exact logic normalizeMeetingTranscriptForAnalysis
 * persists is directly unit-testable without a database. Only `applied: true` corrections (model
 * corrections at/above the confidence threshold, and all deterministic ones) touch the text;
 * every proposed correction, applied or not, is kept in `corrections` for audit.
 */
export function mergeSegmentNormalization(input: {
  originalText: string;
  deterministicText: string | null;
  deterministicCorrections: TranscriptCorrectionRecord[];
  modelCorrections: TranscriptCorrectionRecord[];
}): SegmentNormalizationOutcome {
  let text = input.deterministicText ?? input.originalText;
  for (const correction of input.modelCorrections) {
    if (!correction.applied) continue;
    text = applyTokenReplacement(text, correction.original_token, correction.replacement);
  }
  const corrections = [...input.deterministicCorrections, ...input.modelCorrections];
  return {
    normalizedText: text !== input.originalText ? text : null,
    corrections
  };
}

export type SegmentPersistencePatch = {
  normalized_text: string | null;
  normalization_corrections: TranscriptCorrectionRecord[] | null;
  normalized_at: string | null;
  normalization_failed_at: string | null;
};

/**
 * Decides exactly what to persist for one segment, given whether its LLM batch actually
 * succeeded. This is the fix for a real bug: previously, a segment whose batch failed still got
 * `normalized_at` set (because it had zero corrections, indistinguishable from "successfully
 * checked, nothing to fix"). Now:
 *   - succeeded, no corrections  -> normalized_at set, normalization_failed_at cleared (case A)
 *   - succeeded, with corrections -> normalized_at set, normalized_text/corrections set (case B)
 *   - attempt failed             -> normalized_at left NULL, normalization_failed_at set (case C)
 * Case C deliberately leaves normalized_at null (not "processed") so the segment is retried by
 * any later run of this stage, exactly like a segment that was never normalized at all -- the
 * only difference is normalization_failed_at records that an attempt was made and didn't
 * complete, for observability. Deterministic corrections (which never depend on the model) are
 * still safe to keep and persist even when the LLM batch covering that segment failed.
 */
export function resolveSegmentPersistence(input: {
  succeeded: boolean;
  outcome: SegmentNormalizationOutcome;
  now: string;
}): SegmentPersistencePatch {
  const normalization_corrections = input.outcome.corrections.length > 0 ? input.outcome.corrections : null;
  if (!input.succeeded) {
    return {
      normalized_text: input.outcome.normalizedText,
      normalization_corrections,
      normalized_at: null,
      normalization_failed_at: input.now
    };
  }
  return {
    normalized_text: input.outcome.normalizedText,
    normalization_corrections,
    normalized_at: input.now,
    normalization_failed_at: null
  };
}

export type NormalizationStageResult = {
  status: "skipped" | "completed" | "failed";
  reason: "disabled" | "no_transcript" | "ok" | "model_error";
  segmentCount: number;
  deterministicCorrectionCount: number;
  modelCorrectionCount: number;
  appliedCorrectionCount: number;
  vocabularyCandidateCount: number;
  failureDetail: string | null;
};

const SKIPPED_DISABLED: NormalizationStageResult = {
  status: "skipped",
  reason: "disabled",
  segmentCount: 0,
  deterministicCorrectionCount: 0,
  modelCorrectionCount: 0,
  appliedCorrectionCount: 0,
  vocabularyCandidateCount: 0,
  failureDetail: null
};

/**
 * Runs once, upstream of topic extraction, for every downstream analysis consumer (topics,
 * insights, both execution-intelligence engines, Project Brain via meeting_tasks/commitments).
 * Persists normalized_text/normalization_corrections/normalized_at directly onto
 * transcript_segments (transcript_segments.text itself is never touched) so
 * prepareMeetingAnalysis's ordinary re-query of that table automatically picks up the result --
 * no checkpoint plumbing needed for the hand-off to the next stage.
 *
 * Never throws for a normal "nothing to do" or "model failed" outcome -- a transient LLM/API
 * failure on some or all batches degrades to "less correction than usual", never to "meeting
 * blocked" or "raw transcript damaged": failed segments simply leave their raw text as the
 * effective text (normalized_text stays null), which is always a safe, correct fallback. Unlike
 * an earlier version of this stage, a failed segment's `normalized_at` is left NULL (not set) --
 * see resolveSegmentPersistence -- so it reads as "not yet normalized" and is retried by any
 * later run of this stage, rather than being indistinguishable from "successfully checked, no
 * correction needed". `normalization_failed_at` separately records that an attempt was made and
 * didn't complete, for observability. Only a genuine infrastructure failure (can't reach the
 * database at all) throws, exactly like every other analysis stage, so the durable job/retry
 * machinery in lib/meeting-analysis/jobs.ts can retry the whole stage.
 */
export async function normalizeMeetingTranscriptForAnalysis(
  meetingId: string,
  options?: { createResponse?: CreateStructuredResponse }
): Promise<NormalizationStageResult> {
  if (!isTranscriptNormalizationEnabled()) {
    return SKIPPED_DISABLED;
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, project_id, created_at")
    .eq("id", meetingId)
    .is("deleted_at", null)
    .single();
  if (meetingError || !meeting) {
    throw new Error(meetingError?.message ?? "Meeting not found.");
  }

  const { data: rawSegments, error: segmentsError } = await supabaseAdmin
    .from("transcript_segments")
    .select("*")
    .eq("meeting_id", meetingId)
    .order("timestamp", { ascending: true });
  if (segmentsError) throw new Error(segmentsError.message);

  const ordered = canonicalTranscriptOrder((rawSegments ?? []) as TranscriptSegment[]).map(
    normalizeTranscriptSpeaker
  );
  if (ordered.length === 0) {
    return { ...SKIPPED_DISABLED, reason: "no_transcript" };
  }

  const projectId = typeof meeting.project_id === "string" ? meeting.project_id : null;
  const approvedVocabulary = projectId ? await getApprovedProjectVocabulary(projectId) : [];

  // Deterministic pre-pass: no LLM call, only approved vocabulary (status is the trust boundary,
  // not source -- see lib/project-vocabulary.ts), only distinctive/unambiguous aliases (stoplist
  // + collision resolution, also in lib/project-vocabulary.ts). Runs first so the LLM isn't asked
  // to re-derive a correction we already know for certain.
  const deterministic = applyDeterministicAliasCorrections(
    ordered.map((segment) => ({ id: segment.id, text: segment.text })),
    approvedVocabulary
  );

  const afterDeterministic = ordered.map((segment) => ({
    ...segment,
    text: deterministic.correctedText.get(segment.id) ?? segment.text
  }));

  // Proceeds to the LLM pass below even with an empty vocabulary -- context from the transcript
  // itself (participant names, repeated terms) is still useful evidence for the model.
  const vocabularyContext = buildVocabularyPromptContext(approvedVocabulary);
  const participants = participantMap(
    buildTranscriptWithSegmentIds(afterDeterministic)
  ).map((participant) => participant.name);

  const batches = chunkSegmentsForNormalization(afterDeterministic);
  const threshold = getTranscriptNormalizationAutoThreshold();
  const timeoutMs = Math.max(getV4StageTimeoutMs("transcript_normalization"), 60_000);

  const proposedBySegment = new Map<string, TranscriptCorrectionRecord[]>();
  const vocabularyCandidates: VocabularyCandidateInput[] = [];
  // Per-segment attempt outcome, not just a global flag -- a segment covered by one failed batch
  // AND one successful overlapping batch must count as succeeded (success always wins), while a
  // segment covered ONLY by failed batch(es) must be retried, not silently treated as done. See
  // resolveSegmentPersistence.
  const segmentSucceeded = new Map<string, boolean>();
  let anyModelFailure = false;
  let lastFailureDetail: string | null = null;

  for (const batch of batches) {
    const segmentIdsInBatch = new Set(batch.map((segment) => segment.id));
    const transcriptWindow = buildTranscriptWithSegmentIds(batch);

    const result = await runTranscriptNormalizationModel({
      systemPrompt: TRANSCRIPT_NORMALIZATION_PROMPT,
      timeoutMs,
      createResponse: options?.createResponse,
      context: {
        meeting_id: meetingId,
        meeting_date: meeting.created_at,
        participants,
        project_vocabulary: vocabularyContext,
        transcript: transcriptWindow
      }
    });

    if (!result.ok) {
      anyModelFailure = true;
      lastFailureDetail = result.error;
      for (const segmentId of segmentIdsInBatch) {
        if (!segmentSucceeded.get(segmentId)) segmentSucceeded.set(segmentId, false);
      }
      console.warn("[transcript-normalization] Batch normalization failed; segments in this batch keep their raw text", {
        meeting_id: meetingId,
        batch_segment_count: batch.length,
        error: result.error
      });
      continue;
    }

    for (const segmentId of segmentIdsInBatch) segmentSucceeded.set(segmentId, true);

    for (const correction of result.corrections) {
      if (!segmentIdsInBatch.has(correction.segment_id)) continue; // model must stay grounded to this batch
      const record: TranscriptCorrectionRecord = {
        original_token: correction.original_token,
        replacement: correction.replacement,
        confidence: correction.confidence,
        reason: correction.reason,
        source: "model",
        // Confidence alone is not sufficient to trust an auto-apply: a correction must also be a
        // safely-scoped entity-name span (isCorrectionSpanSafe) and must not be expanding a short
        // spoken word into a longer participant identifier (isParticipantIdentifierExpansion).
        // Either guard failing degrades the correction to a recorded-but-unapplied suggestion --
        // it is never dropped, and normalized_text is never touched by it.
        applied:
          correction.confidence >= threshold &&
          isCorrectionSpanSafe(correction.original_token) &&
          isCorrectionSpanSafe(correction.replacement) &&
          !isParticipantIdentifierExpansion(correction.original_token, correction.replacement, participants)
      };
      const existing = proposedBySegment.get(correction.segment_id) ?? [];
      existing.push(record);
      proposedBySegment.set(correction.segment_id, existing);
    }

    for (const candidate of result.vocabularyCandidates) {
      vocabularyCandidates.push({
        canonicalTerm: candidate.canonical_term,
        observedAlias: candidate.observed_alias,
        confidence: candidate.confidence,
        evidenceMeetingId: meetingId,
        evidenceSegmentIds: candidate.evidence_segment_ids.filter((id) => segmentIdsInBatch.has(id))
      });
    }
  }

  const now = new Date().toISOString();
  let deterministicCorrectionCount = 0;
  let modelCorrectionCount = 0;
  let appliedCorrectionCount = 0;

  await Promise.all(
    ordered.map(async (segment) => {
      const deterministicList = deterministic.corrections.get(segment.id) ?? [];
      // Overlapping batches routinely propose the identical correction twice for a segment near a
      // batch boundary (see chunkSegmentsForNormalization's 5-segment overlap) -- deduped here,
      // once, right before it becomes part of the persisted audit trail.
      const modelList = dedupeCorrections(proposedBySegment.get(segment.id) ?? []);
      deterministicCorrectionCount += deterministicList.length;
      modelCorrectionCount += modelList.length;

      const outcome = mergeSegmentNormalization({
        originalText: segment.text,
        deterministicText: deterministic.correctedText.get(segment.id) ?? null,
        deterministicCorrections: deterministicList,
        modelCorrections: modelList
      });
      appliedCorrectionCount += outcome.corrections.filter((c) => c.applied).length;

      // A segment covered by zero batches can't happen (chunkSegmentsForNormalization guarantees
      // full coverage), but default to "not succeeded" rather than assume success if it ever did.
      const succeeded = segmentSucceeded.get(segment.id) === true;
      const patch = resolveSegmentPersistence({ succeeded, outcome, now });

      await supabaseAdmin.from("transcript_segments").update(patch).eq("id", segment.id);
    })
  );

  if (projectId && vocabularyCandidates.length > 0) {
    try {
      await upsertVocabularySuggestions(projectId, vocabularyCandidates);
    } catch (error) {
      console.warn("[transcript-normalization] Failed to store vocabulary suggestions", {
        meeting_id: meetingId,
        project_id: projectId,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  console.info("[transcript-normalization] Meeting normalized", {
    meeting_id: meetingId,
    project_id: projectId,
    segment_count: ordered.length,
    batch_count: batches.length,
    deterministic_correction_count: deterministicCorrectionCount,
    model_correction_count: modelCorrectionCount,
    applied_correction_count: appliedCorrectionCount,
    vocabulary_candidate_count: vocabularyCandidates.length,
    normalization_status: anyModelFailure ? "partial_failure" : "completed"
  });

  return {
    status: anyModelFailure ? "failed" : "completed",
    reason: anyModelFailure ? "model_error" : "ok",
    segmentCount: ordered.length,
    deterministicCorrectionCount,
    modelCorrectionCount,
    appliedCorrectionCount,
    vocabularyCandidateCount: vocabularyCandidates.length,
    failureDetail: lastFailureDetail
  };
}
