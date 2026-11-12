import { createHash } from "node:crypto";

import type { CommittableTranscriptSegment } from "@/lib/transcript-commit";
import { TranscriptImportError } from "@/lib/transcript-import/errors";
import type { TranscriptFileFormat } from "@/lib/transcript-import/input";
import {
  MAX_IMPORT_SEGMENTS,
  MAX_SEGMENT_CHARS,
  TRANSCRIPT_IMPORT_PARSER_VERSION
} from "@/lib/transcript-import/limits";
import {
  parseTranscriptText,
  type DetectedTranscriptFormat,
  type TranscriptContainer,
  type TranscriptImportWarning
} from "@/lib/transcript-import/parse";
import { splitSegmentText } from "@/lib/transcript-import/split";
import { PARFAIT_IMPORT_PAYLOAD_KEY } from "@/lib/transcript-order";
import { getTranscriptSpeakerLabel } from "@/lib/transcript-speaker";

export type TranscriptImportSource = "manual_upload" | "manual_paste";

/** What an imported row records about where it came from, under raw_payload.parfait_import. */
export type ParfaitImportPayload = {
  /** Position in the imported transcript: the canonical ordering key (lib/transcript-order.ts). */
  segment_index: number;
  /** The source turn (speaker block, cue group or paragraph) this row came from. */
  turn_index: number;
  /** Which piece of that turn, when a long turn was split. */
  fragment_index: number;
  fragment_count: number;
  /** 1-based line in the normalized input where the turn starts. */
  source_line: number;
  /** Offsets from the start of the recording, when the source gave times. Never a date. */
  start_offset_ms?: number;
  end_offset_ms?: number;
  /** Subtitle cues (1-based, file order) merged into the turn. */
  cue_start?: number;
  cue_end?: number;
  hard_split?: true;
  source: TranscriptImportSource;
  format: DetectedTranscriptFormat;
  /** SHA-256 of the import's normalized text, source and declared format: how a retried import
   * recognizes that it is the same content. */
  content_sha256: string;
  parser_version: number;
};

export type PreparedTranscriptImport = {
  source: TranscriptImportSource;
  format: DetectedTranscriptFormat;
  container: TranscriptContainer;
  contentSha256: string;
  characterCount: number;
  turnCount: number;
  segments: CommittableTranscriptSegment[];
  speakers: Array<{ label: string; segmentCount: number }>;
  hasTimeOffsets: boolean;
  warnings: TranscriptImportWarning[];
};

export function transcriptContentSha256(input: {
  text: string;
  source: TranscriptImportSource;
  formatHint: TranscriptFileFormat | null;
}): string {
  // The parser version is deliberately excluded: a retry of the same content across a deploy
  // must still be recognized as the same import.
  return createHash("sha256")
    .update(`parfait-transcript-import\n${input.source}\n${input.formatHint ?? "auto"}\n${input.text}`)
    .digest("hex");
}

/**
 * Normalized text (see normalizeTranscriptText) to the exact rows the import will commit.
 * Pure and deterministic: the preview and the import call this with the same input and get the
 * same rows, so they cannot interpret a transcript differently.
 */
export function prepareTranscriptImport(input: {
  text: string;
  source: TranscriptImportSource;
  formatHint: TranscriptFileFormat | null;
}): PreparedTranscriptImport {
  const parsed = parseTranscriptText(input.text, { formatHint: input.formatHint });
  const contentSha256 = transcriptContentSha256(input);
  const warnings = [...parsed.warnings];

  const segments: CommittableTranscriptSegment[] = [];
  let splitTurns = 0;
  let hardSplitTurns = 0;
  parsed.turns.forEach((turn, turnIndex) => {
    const { pieces, hardSplit } = splitSegmentText(turn.text, MAX_SEGMENT_CHARS);
    if (pieces.length > 1) splitTurns += 1;
    if (hardSplit) hardSplitTurns += 1;
    pieces.forEach((piece, fragmentIndex) => {
      if (segments.length >= MAX_IMPORT_SEGMENTS) {
        throw new TranscriptImportError(
          "too_many_segments",
          `The transcript would produce more than ${MAX_IMPORT_SEGMENTS.toLocaleString("en-US")} segments.`,
          { details: { maxSegments: MAX_IMPORT_SEGMENTS } }
        );
      }
      const payload: ParfaitImportPayload = {
        segment_index: segments.length,
        turn_index: turnIndex,
        fragment_index: fragmentIndex,
        fragment_count: pieces.length,
        source_line: turn.sourceLine,
        ...(turn.startOffsetMs !== null ? { start_offset_ms: turn.startOffsetMs } : {}),
        ...(turn.endOffsetMs !== null ? { end_offset_ms: turn.endOffsetMs } : {}),
        ...(turn.cueRange ? { cue_start: turn.cueRange[0], cue_end: turn.cueRange[1] } : {}),
        ...(hardSplit ? { hard_split: true as const } : {}),
        source: input.source,
        format: parsed.format,
        content_sha256: contentSha256,
        parser_version: TRANSCRIPT_IMPORT_PARSER_VERSION
      };
      segments.push({
        speaker: turn.speaker,
        // Not set: participant_name is a verified meeting participant (Recall's roster). An
        // imported label is only what the file says; the display label falls back to `speaker`.
        participant_name: null,
        text: piece,
        // No absolute time exists for an imported transcript. Never a placeholder date.
        timestamp: null,
        raw_payload: { [PARFAIT_IMPORT_PAYLOAD_KEY]: payload }
      });
    });
  });

  if (splitTurns > 0) {
    warnings.push({
      code: "segments_split",
      message: `Long passages were split into segments of at most ${MAX_SEGMENT_CHARS} characters.`,
      details: { turns: splitTurns, maxSegmentChars: MAX_SEGMENT_CHARS }
    });
  }
  if (hardSplitTurns > 0) {
    warnings.push({
      code: "segment_hard_split",
      message: "A very long unbroken string (such as a URL) had to be cut mid-word.",
      details: { turns: hardSplitTurns }
    });
  }

  const speakerCounts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.speaker) speakerCounts.set(segment.speaker, (speakerCounts.get(segment.speaker) ?? 0) + 1);
  }

  return {
    source: input.source,
    format: parsed.format,
    container: parsed.container,
    contentSha256,
    characterCount: input.text.length,
    turnCount: parsed.turns.length,
    segments,
    speakers: [...speakerCounts].map(([label, segmentCount]) => ({ label, segmentCount })),
    hasTimeOffsets: parsed.turns.some((turn) => turn.startOffsetMs !== null),
    warnings
  };
}

export function meetingDateMissingWarning(): TranscriptImportWarning {
  return {
    code: "meeting_date_missing",
    message:
      "No meeting date was given. Relative dates such as 'tomorrow' or 'next Friday' will be read relative to the import date and may be wrong.",
    details: { effectiveDate: "import_date" }
  };
}

export type TranscriptImportPreview = {
  source: TranscriptImportSource;
  format: DetectedTranscriptFormat;
  container: TranscriptContainer;
  segmentCount: number;
  turnCount: number;
  characterCount: number;
  speakers: Array<{ label: string; segmentCount: number }>;
  hasSpeakers: boolean;
  hasTimeOffsets: boolean;
  /** Always false: an imported transcript has offsets at most, never calendar times. */
  hasAbsoluteTimestamps: false;
  warnings: TranscriptImportWarning[];
  sampleSegments: Array<{
    index: number;
    speaker: string;
    text: string;
    startOffsetMs: number | null;
  }>;
};

const PREVIEW_HEAD = 6;
const PREVIEW_TAIL = 2;
const PREVIEW_TEXT_CHARS = 300;

/** A summary for the Phase 3 preview screen: diagnostics plus a handful of rows from the start and
 * end of the transcript. Pure; it never touches the database or a model. */
export function buildTranscriptImportPreview(
  prepared: PreparedTranscriptImport,
  options: { meetingDate: string | null }
): TranscriptImportPreview {
  const indexes = prepared.segments.length <= PREVIEW_HEAD + PREVIEW_TAIL
    ? prepared.segments.map((_, index) => index)
    : [
        ...Array.from({ length: PREVIEW_HEAD }, (_, index) => index),
        ...Array.from({ length: PREVIEW_TAIL }, (_, index) => prepared.segments.length - PREVIEW_TAIL + index)
      ];
  return {
    source: prepared.source,
    format: prepared.format,
    container: prepared.container,
    segmentCount: prepared.segments.length,
    turnCount: prepared.turnCount,
    characterCount: prepared.characterCount,
    speakers: prepared.speakers,
    hasSpeakers: prepared.speakers.length > 0,
    hasTimeOffsets: prepared.hasTimeOffsets,
    hasAbsoluteTimestamps: false,
    warnings: options.meetingDate ? prepared.warnings : [...prepared.warnings, meetingDateMissingWarning()],
    sampleSegments: indexes.map((index) => {
      const segment = prepared.segments[index];
      const payload = (segment.raw_payload as Record<string, ParfaitImportPayload>)[PARFAIT_IMPORT_PAYLOAD_KEY];
      return {
        index,
        speaker: getTranscriptSpeakerLabel(segment),
        text: segment.text.length > PREVIEW_TEXT_CHARS ? `${segment.text.slice(0, PREVIEW_TEXT_CHARS)}…` : segment.text,
        startOffsetMs: payload.start_offset_ms ?? null
      };
    })
  };
}
