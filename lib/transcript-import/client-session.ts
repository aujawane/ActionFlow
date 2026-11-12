import { historicalMeetingDateSchema, titleFromFileName } from "@/lib/transcript-import/fields";
import { MAX_TRANSCRIPT_BYTES } from "@/lib/transcript-import/limits";
import type { TranscriptImportPreview } from "@/lib/transcript-import/prepare";

/**
 * The browser side of a transcript import, as a plain state machine with no React in it, so every
 * rule below is covered by deterministic tests.
 *
 * Retry identity. The import UUID is created once per import and is the meeting's id on the server
 * (see service.ts), which is what makes a retry safe. It is reused for every retry and rotates only
 * on an explicit "Start new import" or after the import finished. A request whose outcome is not
 * known (timeout, dropped connection, a server error) may have created the meeting, so from the
 * moment a request is sent the import is "maybe created": its content and details are frozen, and
 * the only way forward is to retry the identical request or start a new import deliberately.
 * A request the server refused before touching the database (bad input, unavailable project, rate
 * limit, expired session) did not create anything, so the same UUID simply stays in use.
 *
 * The UUID and the non-sensitive details survive a page refresh in sessionStorage. The transcript
 * itself and anything auth-related are never stored; after a refresh the user supplies the same
 * content again and the server's content hash confirms it is the same import.
 */

export const IMPORT_TIMEOUT_MS = 75_000; // the route's maxDuration is 60 s
export const DRAFT_STORAGE_KEY = "parfait:transcript-import-draft";
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IMPORT_TITLE = "Imported transcript";
export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".vtt", ".srt"] as const;

export type ImportMode = "upload" | "paste";

export type ImportInput = {
  mode: ImportMode;
  file: File | null;
  text: string;
  title: string;
  /** YYYY-MM-DD, or "" for none. */
  meetingDate: string;
  /** A project id, or "" for none. */
  projectId: string;
};

export const EMPTY_INPUT: ImportInput = { mode: "upload", file: null, text: "", title: "", meetingDate: "", projectId: "" };

export type ImportPhase =
  | "editing"
  | "previewing"
  | "previewed"
  | "submitting"
  /** A request may have created the meeting; the identical request can be retried. */
  | "retry_needed"
  /** The import id cannot be used (conflict) or the meeting ended in a state a retry cannot fix. */
  | "blocked"
  /** The meeting exists and the transcript is saved, but analysis did not start. */
  | "saved_not_queued"
  | "complete";

export type ImportErrorKind =
  | "input"
  | "session"
  | "project"
  | "rate_limit"
  | "in_progress"
  | "incomplete"
  | "unknown_outcome"
  | "conflict";

export type ImportError = {
  kind: ImportErrorKind;
  code: string;
  message: string;
  field?: "file" | "text" | "title" | "meetingDate" | "projectId";
  meetingId?: string;
};

export type FieldErrors = Partial<Record<NonNullable<ImportError["field"]>, string>>;

export type DraftRecord = {
  v: 1;
  importId: string;
  mode: ImportMode;
  fileName: string | null;
  title: string;
  meetingDate: string;
  projectId: string;
  startedAt: number;
};

export type SessionState = {
  phase: ImportPhase;
  importId: string;
  input: ImportInput;
  preview: TranscriptImportPreview | null;
  /** Signature of the input the preview was made from. */
  previewKey: string | null;
  confirmed: boolean;
  /** A request that might have created the meeting has been sent. */
  maybeCreated: boolean;
  /** The exact input the first request was sent with; retries resend this. */
  snapshot: ImportInput | null;
  /** Set after a refresh: the details to keep, awaiting the same content again. */
  resumedFrom: DraftRecord | null;
  error: ImportError | null;
  fieldErrors: FieldErrors;
  /** Epoch ms before which submitting is not allowed (Retry-After). */
  retryAt: number | null;
  meetingId: string | null;
  redirectTo: string | null;
  analysis: "queued" | "existing" | "not_started" | null;
  segmentCount: number | null;
  warnings: Array<{ code: string; message: string }>;
};

export type SessionDeps = {
  fetch: typeof fetch;
  newId: () => string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now: () => number;
  timeoutMs?: number;
};

export function meetingPath(meetingId: string): string {
  return `/meetings/${meetingId}`;
}

// ------------------------------------------------------------------------------ input rules

export function fileExtension(name: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match ? `.${match[1].toLowerCase()}` : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The title the meeting will get when the user leaves the field empty. */
export function effectiveTitle(input: ImportInput): string {
  const typed = input.title.trim();
  if (typed) return typed;
  if (input.mode === "upload" && input.file) return titleFromFileName(input.file.name) ?? DEFAULT_IMPORT_TITLE;
  return DEFAULT_IMPORT_TITLE;
}

/** Convenience checks only; the server validates everything again and is the authority. */
export function validateInput(input: ImportInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.mode === "upload") {
    if (!input.file) errors.file = "Choose a transcript file to upload.";
    else if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(fileExtension(input.file.name) ?? "")) {
      errors.file = "Unsupported file type. Upload a .txt, .md, .vtt or .srt transcript.";
    } else if (input.file.size === 0) errors.file = "This file is empty.";
    else if (input.file.size > MAX_TRANSCRIPT_BYTES) {
      errors.file = `This file is ${formatBytes(input.file.size)}. Transcripts can be at most 1 MB.`;
    }
  } else if (!input.text.trim()) {
    errors.text = "Paste the transcript text.";
  } else if (textByteLength(input.text) > MAX_TRANSCRIPT_BYTES) {
    errors.text = `This text is ${formatBytes(textByteLength(input.text))}. Transcripts can be at most 1 MB.`;
  }
  if (input.title.trim().length > 200) errors.title = "Meeting title must be 200 characters or fewer.";
  if (input.meetingDate) {
    const parsed = historicalMeetingDateSchema.safeParse(input.meetingDate);
    if (!parsed.success) errors.meetingDate = parsed.error.issues[0]?.message ?? "Enter a valid meeting date.";
  }
  return errors;
}

function inputKey(input: ImportInput): string {
  const content =
    input.mode === "upload"
      ? `file:${input.file?.name}:${input.file?.size}:${input.file?.lastModified}`
      : `text:${input.text.length}:${input.text}`;
  return JSON.stringify([input.mode, content, input.meetingDate]);
}

// ------------------------------------------------------------------------------ requests

export type RequestParts = { url: string; init: RequestInit };

/** The request for either route. Preview sends only what it needs; import adds the identity. */
export function buildRequest(
  kind: "preview" | "import",
  input: ImportInput,
  identity: { importId: string; title: string }
): RequestParts {
  const url = kind === "preview" ? "/api/meetings/import/preview" : "/api/meetings/import";
  const fields: Record<string, string> = {};
  if (input.meetingDate) fields.meetingDate = input.meetingDate;
  if (kind === "import") {
    fields.importId = identity.importId;
    fields.title = identity.title;
    if (input.projectId) fields.projectId = input.projectId;
  }
  if (input.mode === "upload") {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("file", input.file as File);
    return { url, init: { method: "POST", body: form } };
  }
  return {
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, text: input.text })
    }
  };
}

// ------------------------------------------------------------------------------ responses

export function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

const UNKNOWN_OUTCOME_MESSAGE =
  "We couldn't confirm whether the import went through. Retry to check: Parfait reuses the same import ID, so it won't create a duplicate.";

type Body = Record<string, unknown>;
const asBody = (value: unknown): Body => (value && typeof value === "object" ? (value as Body) : {});
const asString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export type ClassifiedImportResponse =
  | {
      kind: "success";
      meetingId: string;
      outcome: string;
      analysis: "queued" | "existing" | "not_started";
      segmentCount: number | null;
      warnings: Array<{ code: string; message: string }>;
    }
  | {
      kind: "error";
      error: ImportError;
      /** The request provably did not create or change a meeting. */
      definitiveRejection: boolean;
      retryAfterSeconds: number | null;
    };

/** Refusals that are about the transcript itself; they are shown beside the file or text input. */
const TRANSCRIPT_CONTENT_CODES = new Set([
  "empty_input", "input_too_large", "request_too_large", "unsupported_format", "binary_content",
  "invalid_utf8", "nul_byte", "content_format_mismatch", "malformed_cue", "no_transcript_content",
  "too_many_segments"
]);

function withContentField(error: ImportError, mode: ImportMode): ImportError {
  if (error.kind !== "input" || error.field || !TRANSCRIPT_CONTENT_CODES.has(error.code)) return error;
  return { ...error, field: mode === "upload" ? "file" : "text" };
}

/** Maps a route response to an outcome. Messages from the server are written for users and carry no
 * internals (the routes log those); an unrecognized failure gets the generic unknown-outcome text. */
export function classifyImportResponse(
  status: number,
  bodyValue: unknown,
  retryAfterHeader: string | null
): ClassifiedImportResponse {
  const body = asBody(bodyValue);
  const code = asString(body.code) ?? "";
  const serverMessage = asString(body.error);
  const retryAfter = Number(retryAfterHeader);
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  const meetingId = asString(body.meetingId) ?? undefined;

  if (status === 200 || status === 201) {
    const meeting = asBody(body.meeting);
    const imported = asBody(body.import);
    const analysis = asBody(body.analysis);
    const id = asString(meeting.id);
    if (id) {
      return {
        kind: "success",
        meetingId: id,
        outcome: asString(imported.outcome) ?? "created",
        analysis:
          analysis.status === "queued" ? "queued" : analysis.status === "enqueue_failed" ? "not_started" : "existing",
        segmentCount: typeof imported.segmentCount === "number" ? imported.segmentCount : null,
        warnings: Array.isArray(imported.warnings)
          ? imported.warnings.flatMap((warning) => {
              const w = asBody(warning);
              return asString(w.code) && asString(w.message)
                ? [{ code: w.code as string, message: w.message as string }]
                : [];
            })
          : []
      };
    }
  }

  const reject = (error: ImportError): ClassifiedImportResponse => ({
    kind: "error",
    error,
    definitiveRejection: true,
    retryAfterSeconds
  });
  const unknown = (message = UNKNOWN_OUTCOME_MESSAGE): ClassifiedImportResponse => ({
    kind: "error",
    error: { kind: "unknown_outcome", code: code || `http_${status}`, message, meetingId },
    definitiveRejection: false,
    retryAfterSeconds
  });

  if (status === 401) {
    return reject({
      kind: "session",
      code: "unauthorized",
      message: "Your session expired. Sign in again, then come back here. Nothing was imported."
    });
  }
  if (status === 404 && code === "project_not_found") {
    return reject({
      kind: "project",
      code,
      field: "projectId",
      message: "That project isn't available to your account. Choose another project or leave it unassigned."
    });
  }
  if (status === 429) {
    const wait = retryAfterSeconds ? ` Try again in about ${formatWait(retryAfterSeconds)}.` : "";
    return reject({
      kind: "rate_limit",
      code: "rate_limited",
      message: `${serverMessage ?? "You've reached the import limit."}${serverMessage?.includes("Try again") ? "" : wait}`
    });
  }
  if (status === 409 && code === "import_in_progress") {
    return {
      kind: "error",
      error: {
        kind: "in_progress",
        code,
        meetingId,
        message: "This import is still being processed. Retrying is safe: it continues the same import."
      },
      definitiveRejection: false,
      retryAfterSeconds
    };
  }
  if (status === 409 && (code === "import_id_conflict" || code === "import_failed")) {
    return reject({
      kind: "conflict",
      code,
      meetingId,
      message:
        code === "import_failed"
          ? "This import failed and can't be resumed. Start a new import."
          : "This import was already started with different content or details, so Parfait changed nothing. Start a new import to continue."
    });
  }
  if (status === 500 && code === "import_incomplete") {
    const retryable = body.retryable === true;
    return {
      kind: "error",
      error: {
        kind: retryable ? "incomplete" : "conflict",
        code,
        meetingId,
        message: retryable
          ? "The meeting was created but its transcript couldn't be saved. Retry to finish the same import without creating a duplicate."
          : "The transcript was saved but the meeting couldn't be finished. Open the meeting to check it."
      },
      definitiveRejection: false,
      retryAfterSeconds
    };
  }
  if (status >= 400 && status < 500 && serverMessage && code && code !== "internal_error") {
    return reject({
      kind: "input",
      code,
      message: serverMessage
    });
  }
  return unknown(status >= 500 ? "Something went wrong on our side. " + UNKNOWN_OUTCOME_MESSAGE : undefined);
}

// ------------------------------------------------------------------------------ draft storage

export function readDraft(storage: SessionDeps["storage"], now: number): DraftRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DraftRecord>;
    const valid =
      value.v === 1 &&
      typeof value.importId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.importId) &&
      (value.mode === "upload" || value.mode === "paste") &&
      typeof value.title === "string" &&
      typeof value.meetingDate === "string" &&
      typeof value.projectId === "string" &&
      typeof value.startedAt === "number" &&
      now - value.startedAt < DRAFT_MAX_AGE_MS;
    if (!valid) {
      storage.removeItem(DRAFT_STORAGE_KEY);
      return null;
    }
    return { ...(value as DraftRecord), fileName: typeof value.fileName === "string" ? value.fileName : null };
  } catch {
    return null;
  }
}

function writeDraft(storage: SessionDeps["storage"], draft: DraftRecord) {
  try {
    storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory session still works.
  }
}

function clearDraft(storage: SessionDeps["storage"]) {
  try {
    storage?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------------------------ the session

function freshState(importId: string, input: ImportInput): SessionState {
  return {
    phase: "editing",
    importId,
    input,
    preview: null,
    previewKey: null,
    confirmed: false,
    maybeCreated: false,
    snapshot: null,
    resumedFrom: null,
    error: null,
    fieldErrors: {},
    retryAt: null,
    meetingId: null,
    redirectTo: null,
    analysis: null,
    segmentCount: null,
    warnings: []
  };
}

export type FieldLock = "none" | "details" | "all";

export class ImportSession {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;

  constructor(private deps: SessionDeps) {
    this.state = freshState(deps.newId(), EMPTY_INPUT);
  }

  /** Picks up an import that was started before a page refresh. Call once on the client, after
   * mount (storage does not exist while rendering on the server). A no-op if the user already began
   * something new, or there is nothing to resume. */
  restore(): boolean {
    const pristine = this.state.phase === "editing" && !this.state.snapshot && !this.state.resumedFrom && !this.state.preview;
    if (!pristine) return false;
    const draft = readDraft(this.deps.storage, this.deps.now());
    if (!draft) return false;
    this.set({
      importId: draft.importId,
      input: { ...EMPTY_INPUT, mode: draft.mode, title: draft.title, meetingDate: draft.meetingDate, projectId: draft.projectId },
      maybeCreated: true,
      resumedFrom: draft
    });
    return true;
  }

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** What the user may still change. After a request that may have created the meeting, nothing
   * (the identical request is retried). After a refresh, the content only. */
  lock(): FieldLock {
    if (this.state.snapshot) return "all";
    if (this.state.resumedFrom) return "details";
    return "none";
  }

  setInput(patch: Partial<ImportInput>): boolean {
    const { phase } = this.state;
    if (phase === "previewing" || phase === "submitting" || phase === "complete" || phase === "saved_not_queued" || phase === "blocked") {
      return false;
    }
    const lock = this.lock();
    if (lock === "all") return false;
    const contentOnly = new Set<keyof ImportInput>(["file", "text"]);
    if (lock === "details" && Object.keys(patch).some((key) => !contentOnly.has(key as keyof ImportInput))) return false;

    const input = { ...this.state.input, ...patch };
    const changed = inputKey(input) !== (this.state.previewKey ?? "");
    this.set({
      input,
      fieldErrors: {},
      error: this.state.error?.kind === "input" || this.state.error?.kind === "project" ? null : this.state.error,
      ...(changed ? { preview: null, previewKey: null, confirmed: false, phase: "editing" as const } : {})
    });
    return true;
  }

  async preview(): Promise<void> {
    if (this.state.phase === "previewing" || this.state.phase === "submitting") return;
    if (this.state.snapshot) return;
    const fieldErrors = validateInput(this.state.input);
    const resumedName = this.state.resumedFrom?.fileName;
    if (!fieldErrors.file && resumedName && this.state.input.file) {
      if (fileExtension(this.state.input.file.name) !== fileExtension(resumedName)) {
        fieldErrors.file = `This import started with a ${fileExtension(resumedName)} file. Choose the same file again, or start a new import.`;
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      this.set({ fieldErrors, error: null });
      return;
    }
    const input = this.state.input;
    this.set({ phase: "previewing", error: null, fieldErrors: {}, preview: null, previewKey: null, confirmed: false });
    try {
      const { url, init } = buildRequest("preview", input, { importId: this.state.importId, title: effectiveTitle(input) });
      const response = await this.fetchWithTimeout(url, init);
      const body = await response.json().catch(() => ({}));
      if (response.ok && asBody(body).preview) {
        this.set({
          phase: "previewed",
          preview: asBody(body).preview as TranscriptImportPreview,
          previewKey: inputKey(input)
        });
        return;
      }
      const classified = classifyImportResponse(response.status, body, response.headers.get("Retry-After"));
      const error: ImportError = withContentField(
        classified.kind === "error"
          ? { ...classified.error, message: classified.error.kind === "unknown_outcome" ? "The preview couldn't be created. Try again." : classified.error.message }
          : { kind: "unknown_outcome", code: "preview_failed", message: "The preview couldn't be created. Try again." },
        input.mode
      );
      this.set({ phase: "editing", error, fieldErrors: error.field ? { [error.field]: error.message } : {} });
    } catch {
      this.set({ phase: "editing", error: { kind: "unknown_outcome", code: "network", message: "The preview couldn't be created. Check your connection and try again." } });
    }
  }

  setConfirmed(confirmed: boolean) {
    if (this.state.phase !== "previewed" || !this.state.preview) return;
    this.set({ confirmed });
  }

  /** Whether the Analyze/Retry action may run right now. */
  canSubmit(): boolean {
    const { phase, confirmed, retryAt, snapshot } = this.state;
    if (this.inflight) return false;
    if (retryAt !== null && this.deps.now() < retryAt) return false;
    if (phase === "retry_needed") return snapshot !== null || confirmed;
    if (phase === "previewed") return confirmed && this.state.previewKey === inputKey(this.state.input);
    return false;
  }

  /** Sends the import. A second call while one is in flight returns the same promise, so a
   * double-click can never send two requests. */
  submit(): Promise<void> | null {
    if (this.inflight) return this.inflight;
    if (!this.canSubmit()) return null;
    this.inflight = this.runSubmit().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runSubmit(): Promise<void> {
    const wasMaybeCreated = this.state.maybeCreated;
    const wasSnapshot = this.state.snapshot;
    const input = wasSnapshot ?? this.state.input;
    const title = effectiveTitle(input);
    const resumed = this.state.resumedFrom;
    const snapshot: ImportInput = { ...input, title };

    // From here the meeting may exist. Persist the identity before sending, so even a refresh
    // during the request can resume it.
    writeDraft(this.deps.storage, {
      v: 1,
      importId: this.state.importId,
      mode: input.mode,
      fileName: input.file?.name ?? resumed?.fileName ?? null,
      title,
      meetingDate: input.meetingDate,
      projectId: input.projectId,
      startedAt: resumed?.startedAt ?? this.deps.now()
    });
    this.set({ phase: "submitting", snapshot, maybeCreated: true, error: null, retryAt: null });

    let classified: ClassifiedImportResponse;
    try {
      const { url, init } = buildRequest("import", snapshot, { importId: this.state.importId, title });
      const response = await this.fetchWithTimeout(url, init);
      const body = await response.json().catch(() => ({}));
      classified = classifyImportResponse(response.status, body, response.headers.get("Retry-After"));
    } catch {
      classified = {
        kind: "error",
        definitiveRejection: false,
        retryAfterSeconds: null,
        error: { kind: "unknown_outcome", code: "network", message: UNKNOWN_OUTCOME_MESSAGE }
      };
    }

    if (classified.kind === "success") {
      clearDraft(this.deps.storage);
      const notStarted = classified.analysis === "not_started";
      this.set({
        phase: notStarted ? "saved_not_queued" : "complete",
        meetingId: classified.meetingId,
        redirectTo: meetingPath(classified.meetingId),
        analysis: classified.analysis,
        segmentCount: classified.segmentCount,
        warnings: classified.warnings,
        maybeCreated: false,
        snapshot: null,
        resumedFrom: null,
        error: null
      });
      return;
    }

    const { definitiveRejection, retryAfterSeconds } = classified;
    const error = withContentField(classified.error, snapshot.mode);
    const retryAt = retryAfterSeconds ? this.deps.now() + retryAfterSeconds * 1000 : null;
    const fieldErrors = error.field ? { [error.field]: error.message } : {};

    if (error.kind === "conflict") {
      // The id can't be used (or the meeting can't be finished by retrying): only a new import helps.
      this.set({ phase: "blocked", error, fieldErrors: {}, retryAt: null, meetingId: error.meetingId ?? null });
      return;
    }
    if (definitiveRejection) {
      // Nothing was created by this request. If nothing was before it either, the draft is moot and
      // the same id stays in use for the corrected request.
      if (!wasMaybeCreated) {
        clearDraft(this.deps.storage);
        this.set({ phase: "previewed", error, fieldErrors, retryAt, maybeCreated: false, snapshot: null });
      } else {
        this.set({ phase: wasSnapshot ? "retry_needed" : "previewed", error, fieldErrors, retryAt, snapshot: wasSnapshot });
      }
      return;
    }
    this.set({
      phase: "retry_needed",
      error,
      fieldErrors: {},
      retryAt: error.kind === "in_progress" ? this.deps.now() + (retryAfterSeconds ?? 15) * 1000 : retryAt,
      meetingId: error.meetingId ?? this.state.meetingId
    });
  }

  /** Abandons the current import for good and begins a new one with a new id. The user's inputs
   * are kept so they can adjust and re-submit. */
  startNewImport() {
    clearDraft(this.deps.storage);
    const input = this.state.input;
    this.state = freshState(this.deps.newId(), input);
    for (const listener of this.listeners) listener();
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? IMPORT_TIMEOUT_MS);
    try {
      return await this.deps.fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    } finally {
      clearTimeout(timer);
    }
  }
}
