import { TranscriptImportError } from "@/lib/transcript-import/errors";
import { MAX_TRANSCRIPT_BYTES } from "@/lib/transcript-import/limits";

/** The four accepted transcript file types. Pasted text has no container and is auto-detected. */
export type TranscriptFileFormat = "txt" | "md" | "vtt" | "srt";

const EXTENSION_FORMATS: Record<string, TranscriptFileFormat> = {
  txt: "txt",
  md: "md",
  vtt: "vtt",
  srt: "srt"
};

export function isTranscriptFileFormat(value: unknown): value is TranscriptFileFormat {
  return value === "txt" || value === "md" || value === "vtt" || value === "srt";
}

/** The format implied by a file name's extension, which is the only thing about an upload's type
 * the server trusts before reading it (browser MIME types for .vtt/.srt/.md are inconsistent). */
export function formatFromFileName(fileName: string): TranscriptFileFormat {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  const format = match ? EXTENSION_FORMATS[match[1].toLowerCase()] : undefined;
  if (!format) {
    throw new TranscriptImportError(
      "unsupported_format",
      "Unsupported file type. Upload a .txt, .md, .vtt or .srt transcript.",
      { details: { extension: match ? match[1].toLowerCase() : null } }
    );
  }
  return format;
}

/** MIME types that can never be a plain-text transcript, whatever the extension says. */
export function isClearlyNonTextMimeType(mimeType: string | null | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (!type) return false;
  return (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    type === "application/pdf" ||
    type === "application/zip" ||
    type === "application/msword" ||
    type.startsWith("application/vnd.openxmlformats") ||
    type.startsWith("application/vnd.ms-") ||
    type === "application/x-msdownload"
  );
}

/** Leading bytes of common binary formats someone might rename to .txt. */
const BINARY_SIGNATURES: Array<{ offset: number; bytes: number[] }> = [
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // zip, docx, xlsx
  { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] }, // legacy Office
  { offset: 0, bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] }, // {\rtf
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }, // png
  { offset: 0, bytes: [0xff, 0xd8, 0xff] }, // jpeg
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // gif
  { offset: 0, bytes: [0x49, 0x44, 0x33] }, // mp3 (ID3)
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // wav, avi (RIFF)
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] }, // ogg
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // mkv, webm
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] } // mp4, m4a, mov (ftyp)
];

function hasBinarySignature(bytes: Uint8Array): boolean {
  return BINARY_SIGNATURES.some(({ offset, bytes: signature }) =>
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

function binaryContent(): TranscriptImportError {
  return new TranscriptImportError(
    "binary_content",
    "This file is not a text transcript. PDFs, documents, audio and video are not supported."
  );
}

/**
 * Bytes of an uploaded file to validated, normalized transcript text. Rejects empty, oversized,
 * binary, UTF-16 and malformed UTF-8 input. A UTF-8 byte-order mark is accepted and removed.
 */
export function decodeTranscriptBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new TranscriptImportError("empty_input", "The transcript is empty.");
  }
  if (bytes.length > MAX_TRANSCRIPT_BYTES) {
    throw new TranscriptImportError("input_too_large", "The transcript is larger than 1 MB.", {
      details: { maxBytes: MAX_TRANSCRIPT_BYTES, bytes: bytes.length }
    });
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new TranscriptImportError("invalid_utf8", "The transcript is UTF-16 encoded. Save it as UTF-8 and try again.");
  }
  if (hasBinarySignature(bytes)) throw binaryContent();
  if (bytes.includes(0)) {
    throw new TranscriptImportError("nul_byte", "The transcript contains NUL bytes, so it is not a text file.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TranscriptImportError("invalid_utf8", "The transcript is not valid UTF-8 text.");
  }
  return normalizeTranscriptText(text);
}

/** Byte length of a string as UTF-8, without allocating the encoded buffer for large inputs twice. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Control characters other than tab and line breaks. A few stray ones (a form feed from a page
// break) are replaced by spaces; many of them mean the input is not text.
const CONTROL_CHARACTERS = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Validates and normalizes transcript text from either source: pasted text arrives here directly,
 * uploads after decoding. Normalization never changes words or punctuation: it removes a BOM,
 * converts CRLF/CR and Unicode line separators to \n, replaces a few stray control characters with
 * spaces, and trims trailing whitespace on each line.
 */
export function normalizeTranscriptText(input: string): string {
  if (!input.isWellFormed()) {
    throw new TranscriptImportError("invalid_utf8", "The transcript contains invalid Unicode text.");
  }
  if (input.includes("\u0000")) {
    throw new TranscriptImportError("nul_byte", "The transcript contains NUL characters, so it is not text.");
  }
  const bytes = utf8ByteLength(input);
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    throw new TranscriptImportError("input_too_large", "The transcript is larger than 1 MB.", {
      details: { maxBytes: MAX_TRANSCRIPT_BYTES, bytes }
    });
  }

  const controlCount = input.match(CONTROL_CHARACTERS)?.length ?? 0;
  if (controlCount > Math.max(8, input.length * 0.001)) throw binaryContent();

  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARACTERS, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00A0]+$/, ""))
    .join("\n");

  if (!text.trim()) {
    throw new TranscriptImportError("empty_input", "The transcript is empty.");
  }
  return text;
}
