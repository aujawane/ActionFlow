/** Machine-readable reasons an import or preview is refused. Phase 3 maps these to UI copy. */
export type TranscriptImportErrorCode =
  | "empty_input"
  | "input_too_large"
  | "request_too_large"
  | "invalid_request"
  | "unsupported_format"
  | "binary_content"
  | "invalid_utf8"
  | "nul_byte"
  | "content_format_mismatch"
  | "malformed_cue"
  | "no_transcript_content"
  | "too_many_segments";

export class TranscriptImportError extends Error {
  readonly code: TranscriptImportErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: TranscriptImportErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "TranscriptImportError";
    this.code = code;
    this.status = options.status ?? (code === "input_too_large" || code === "request_too_large" ? 413 : 400);
    this.details = options.details;
  }

  toJSON() {
    return { error: this.message, code: this.code, ...(this.details ? { details: this.details } : {}) };
  }
}
