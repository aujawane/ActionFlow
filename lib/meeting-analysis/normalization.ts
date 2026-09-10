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
        applied: correction.confidence >= threshold
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
      const modelList = proposedBySegment.get(segment.id) ?? [];
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
