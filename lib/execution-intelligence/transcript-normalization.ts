import {
  getTranscriptNormalizationAutoThreshold,
  getV4StageTimeoutMs,
  isTranscriptNormalizationEnabled
} from "@/lib/env";
import { runTranscriptNormalizationModel, type TokenUsage } from "./work-item-model";
import { TRANSCRIPT_NORMALIZATION_PROMPT } from "./work-item-prompts";
import type { TranscriptCorrection } from "./work-item-schemas";

const SEGMENT_LINE = /^\[([0-9a-f-]{36})\]/i;

export type NormalizationResult = {
  enabled: boolean;
  normalizedTranscript: string;
  corrections: TranscriptCorrection[];
  appliedCorrections: TranscriptCorrection[];
  failed: boolean;
  failureReason: string | null;
  latencyMs: number;
  usage: TokenUsage | null;
};

/** Replaces `original_token` with `replacement` only on the one line matching `segment_id`, and
 * only the first occurrence -- a targeted entity fix, never a transcript-wide find/replace. */
export function applyTranscriptCorrections(
  transcript: string,
  corrections: TranscriptCorrection[]
): string {
  const bySegment = new Map<string, TranscriptCorrection[]>();
  for (const correction of corrections) {
    const list = bySegment.get(correction.segment_id) ?? [];
    list.push(correction);
    bySegment.set(correction.segment_id, list);
  }
  if (bySegment.size === 0) return transcript;
  return transcript
    .split("\n")
    .map((line) => {
      const segmentId = line.match(SEGMENT_LINE)?.[1];
      if (!segmentId) return line;
      const corrections = bySegment.get(segmentId);
      if (!corrections) return line;
      return corrections.reduce(
        (text, correction) => text.replace(correction.original_token, correction.replacement),
        line
      );
    })
    .join("\n");
}

/**
 * Optional, non-blocking transcript normalization (Phase 0). Never throws: any failure (disabled
 * flag, model error, timeout, exception) safely returns the raw transcript unchanged with
 * `failed`/`failureReason` set for observability. Only corrections at or above the configured
 * confidence threshold are applied; everything below is still returned in `corrections` for
 * review but never touches the transcript extraction actually runs against.
 */
export async function normalizeTranscriptSafely(input: {
  meetingId: string;
  meetingDate: string;
  transcript: string;
  participants: string[];
  projectGlossary: string[];
}): Promise<NormalizationResult> {
  const startedAt = Date.now();
  if (!isTranscriptNormalizationEnabled()) {
    return {
      enabled: false,
      normalizedTranscript: input.transcript,
      corrections: [],
      appliedCorrections: [],
      failed: false,
      failureReason: null,
      latencyMs: 0,
      usage: null
    };
  }
  try {
    const result = await runTranscriptNormalizationModel({
      systemPrompt: TRANSCRIPT_NORMALIZATION_PROMPT,
      timeoutMs: Math.max(getV4StageTimeoutMs("transcript_normalization"), 60_000),
      context: {
        meeting_id: input.meetingId,
        meeting_date: input.meetingDate,
        participants: input.participants,
        project_glossary: input.projectGlossary,
        transcript: input.transcript
      }
    });
    if (!result.ok) {
      console.warn("[execution-intelligence-v4] Transcript normalization failed; using raw transcript", {
        meeting_id: input.meetingId,
        error: result.error,
        details: result.details
      });
      return {
        enabled: true,
        normalizedTranscript: input.transcript,
        corrections: [],
        appliedCorrections: [],
        failed: true,
        failureReason: result.error,
        latencyMs: Date.now() - startedAt,
        usage: null
      };
    }
    const threshold = getTranscriptNormalizationAutoThreshold();
    const applied = result.corrections.filter((correction) => correction.confidence >= threshold);
    const normalizedTranscript = applyTranscriptCorrections(input.transcript, applied);
    return {
      enabled: true,
      normalizedTranscript,
      corrections: result.corrections,
      appliedCorrections: applied,
      failed: false,
      failureReason: null,
      latencyMs: Date.now() - startedAt,
      usage: result.usage
    };
  } catch (error) {
    console.warn("[execution-intelligence-v4] Transcript normalization threw; using raw transcript", {
      meeting_id: input.meetingId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return {
      enabled: true,
      normalizedTranscript: input.transcript,
      corrections: [],
      appliedCorrections: [],
      failed: true,
      failureReason: error instanceof Error ? error.message : "Unknown error",
      latencyMs: Date.now() - startedAt,
      usage: null
    };
  }
}
