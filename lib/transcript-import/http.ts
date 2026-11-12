import { NextResponse } from "next/server";

import { TranscriptImportError } from "@/lib/transcript-import/errors";
import { buildTranscriptImportPreview, prepareTranscriptImport } from "@/lib/transcript-import/prepare";
import { readTranscriptImportRequest } from "@/lib/transcript-import/request";
import { importTranscript, type TranscriptImportDeps } from "@/lib/transcript-import/service";

/**
 * The two route handlers, with authentication and data access injected so tests drive the real
 * request path. Order in both: authenticate, then read and validate the body, then parse. Nothing
 * touches the database before the input is known to be a valid transcript, and nothing here ever
 * calls a model; the import's only route to analysis is the normal queue (see service.ts).
 */

type RequireUser = () => Promise<{ user: { id: string } | null; response: Response | null }>;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function errorResponse(error: unknown, context: string): Response {
  if (error instanceof TranscriptImportError) {
    return NextResponse.json(error.toJSON(), { status: error.status, headers: NO_STORE });
  }
  // Database or platform errors stay in the server log; the client gets no internals.
  console.error(`[transcript-import] ${context} failed`, {
    error: error instanceof Error ? error.message : String(error)
  });
  return NextResponse.json(
    { error: "The transcript could not be processed. Try again.", code: "internal_error" },
    { status: 500, headers: NO_STORE }
  );
}

/** POST /api/meetings/import/preview: parse and describe, never persist. */
export async function handleTranscriptPreview(request: Request, deps: { requireUser: RequireUser }): Promise<Response> {
  const auth = await deps.requireUser();
  if (auth.response || !auth.user) return auth.response ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = await readTranscriptImportRequest(request, { requireImportId: false });
    const prepared = prepareTranscriptImport({ text: input.text, source: input.source, formatHint: input.formatHint });
    return NextResponse.json(
      { preview: buildTranscriptImportPreview(prepared, { meetingDate: input.meetingDate }) },
      { headers: NO_STORE }
    );
  } catch (error) {
    return errorResponse(error, "preview");
  }
}

/** POST /api/meetings/import: create the meeting, save the transcript, queue normal analysis. */
export async function handleTranscriptImport(
  request: Request,
  deps: {
    requireUser: RequireUser;
    importDeps: TranscriptImportDeps;
    onImported?: (meeting: { id: string; project_id?: string | null }) => void;
  }
): Promise<Response> {
  const auth = await deps.requireUser();
  if (auth.response || !auth.user) return auth.response ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const input = await readTranscriptImportRequest(request, { requireImportId: true });
    const prepared = prepareTranscriptImport({ text: input.text, source: input.source, formatHint: input.formatHint });
    const outcome = await importTranscript({ userId: auth.user.id, request: input, prepared }, deps.importDeps);
    if (!outcome.ok) {
      return NextResponse.json(outcome.body, {
        status: outcome.httpStatus,
        headers: outcome.retryAfterSeconds ? { ...NO_STORE, "Retry-After": String(outcome.retryAfterSeconds) } : NO_STORE
      });
    }
    try {
      deps.onImported?.(outcome.body.meeting);
    } catch {
      // Cache revalidation is best effort and never changes the import's result.
    }
    return NextResponse.json(outcome.body, { status: outcome.httpStatus, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error, "import");
  }
}
