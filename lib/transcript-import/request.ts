import { z } from "zod";

import { meetingTitleSchema } from "@/lib/meeting-form-validation";
import { TranscriptImportError } from "@/lib/transcript-import/errors";
import {
  decodeTranscriptBytes,
  formatFromFileName,
  isClearlyNonTextMimeType,
  isTranscriptFileFormat,
  normalizeTranscriptText,
  type TranscriptFileFormat
} from "@/lib/transcript-import/input";
import { MAX_IMPORT_REQUEST_BYTES } from "@/lib/transcript-import/limits";
import type { TranscriptImportSource } from "@/lib/transcript-import/prepare";

/**
 * Reads an import or preview request. Both routes go through this one function, so they accept
 * exactly the same inputs and reject exactly the same ones.
 *
 * Accepted bodies:
 * - multipart/form-data with `file` (an uploaded .txt/.md/.vtt/.srt) OR `text` (pasted), plus the
 *   optional fields below.
 * - application/json with `text` (pasted), plus the optional fields below.
 *
 * Fields: `importId` (UUID, required for an import), `title`, `meetingDate` (YYYY-MM-DD), `projectId`
 * (UUID), and for pasted text only `format` (txt | md | vtt | srt; omitted means auto-detect).
 * Nothing here trusts the client: the body is size-capped while it streams, the file's type comes
 * from its extension plus its actual bytes, and every field is validated.
 */
export type TranscriptImportRequest = {
  source: TranscriptImportSource;
  /** Normalized transcript text (see normalizeTranscriptText). */
  text: string;
  formatHint: TranscriptFileFormat | null;
  fileName: string | null;
  importId: string | null;
  /** The title the meeting will get: the given one, else an upload's file name, else null. */
  title: string | null;
  meetingDate: string | null;
  projectId: string | null;
};

function invalid(message: string, details?: Record<string, unknown>): TranscriptImportError {
  return new TranscriptImportError("invalid_request", message, { details });
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () =>
    new TranscriptImportError("request_too_large", "The request is too large. Transcripts can be at most 1 MB.", {
      details: { maxRequestBytes: maxBytes }
    });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** A calendar date, not in the future (one day of slack for time zones), and not before 1990. */
export const historicalMeetingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Meeting date must be YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Meeting date is not a real calendar date.")
  .refine((value) => value >= "1990-01-01", "Meeting date is too far in the past.")
  .refine(
    (value) => value <= new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    "Meeting date cannot be in the future."
  );

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const fieldsSchema = z.object({
  importId: z.preprocess(emptyToUndefined, z.string().uuid("Import ID must be a UUID.").optional()),
  title: z.preprocess(emptyToUndefined, meetingTitleSchema.optional()),
  meetingDate: z.preprocess(emptyToUndefined, historicalMeetingDateSchema.optional()),
  projectId: z.preprocess(emptyToUndefined, z.string().uuid("Project ID must be a UUID.").optional()),
  format: z.preprocess(
    emptyToUndefined,
    z.enum(["txt", "md", "vtt", "srt"], { message: "Format must be txt, md, vtt or srt." }).optional()
  )
});

/** "Q3 planning (Aug 19).vtt" -> "Q3 planning (Aug 19)": the default title for an upload. */
export function titleFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]+$/, "");
  const title = stem.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim();
  return title || null;
}

export async function readTranscriptImportRequest(
  request: Request,
  options: { requireImportId: boolean }
): Promise<TranscriptImportRequest> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const isMultipart = contentType.startsWith("multipart/form-data");
  const isJson = contentType.startsWith("application/json");
  if (!isMultipart && !isJson) {
    throw new TranscriptImportError(
      "invalid_request",
      "Send the transcript as multipart/form-data or application/json.",
      { status: 415 }
    );
  }

  const body = await readBoundedBody(request, MAX_IMPORT_REQUEST_BYTES);
  let rawFields: Record<string, unknown>;
  let file: File | null = null;
  let pasted: unknown;

  if (isMultipart) {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    } catch {
      throw invalid("The form data could not be read.");
    }
    const fileEntry = form.get("file");
    const textEntry = form.get("text");
    if (fileEntry !== null && typeof fileEntry !== "string") file = fileEntry;
    else if (fileEntry !== null) throw invalid("`file` must be a file upload.");
    pasted = textEntry;
    rawFields = Object.fromEntries(
      ["importId", "title", "meetingDate", "projectId", "format"].map((key) => [key, form.get(key) ?? undefined])
    );
    for (const value of Object.values(rawFields)) {
      if (value !== undefined && typeof value !== "string") throw invalid("Form fields must be text.");
    }
  } else {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw invalid("Request body must be valid JSON.");
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw invalid("Request body must be a JSON object.");
    const record = json as Record<string, unknown>;
    if ("file" in record) throw invalid("Upload files as multipart/form-data.");
    pasted = record.text;
    rawFields = { importId: record.importId, title: record.title, meetingDate: record.meetingDate, projectId: record.projectId, format: record.format };
  }

  if (file && pasted !== null && pasted !== undefined) throw invalid("Send either a file or pasted text, not both.");
  if (!file && (pasted === null || pasted === undefined)) {
    throw new TranscriptImportError("empty_input", "Upload a transcript file or paste transcript text.");
  }
  if (!file && typeof pasted !== "string") throw invalid("`text` must be a string.");

  const fields = fieldsSchema.safeParse(rawFields);
  if (!fields.success) throw invalid("Invalid import details.", { fields: fields.error.flatten().fieldErrors });
  if (options.requireImportId && !fields.data.importId) {
    throw invalid("Invalid import details.", { fields: { importId: ["Import ID is required."] } });
  }

  let source: TranscriptImportSource;
  let text: string;
  let formatHint: TranscriptFileFormat | null;
  let fileName: string | null = null;
  if (file) {
    if (fields.data.format) throw invalid("`format` applies to pasted text only; an upload's format comes from its file name.");
    source = "manual_upload";
    fileName = file.name;
    formatHint = formatFromFileName(file.name);
    if (isClearlyNonTextMimeType(file.type)) {
      throw new TranscriptImportError("binary_content", "This file is not a text transcript. PDFs, documents, audio and video are not supported.");
    }
    text = decodeTranscriptBytes(new Uint8Array(await file.arrayBuffer()));
  } else {
    source = "manual_paste";
    formatHint = fields.data.format && isTranscriptFileFormat(fields.data.format) ? fields.data.format : null;
    text = normalizeTranscriptText(pasted as string);
  }

  return {
    source,
    text,
    formatHint,
    fileName,
    importId: fields.data.importId ?? null,
    title: fields.data.title ?? (fileName ? titleFromFileName(fileName) : null),
    meetingDate: fields.data.meetingDate ?? null,
    projectId: fields.data.projectId ?? null
  };
}
