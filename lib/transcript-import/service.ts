import type { CommitTranscriptResult, CommittableTranscriptSegment } from "@/lib/transcript-commit";
import { IMPORTS_PER_DAY, IMPORTS_PER_HOUR } from "@/lib/transcript-import/limits";
import type { TranscriptImportWarning } from "@/lib/transcript-import/parse";
import {
  meetingDateMissingWarning,
  type PreparedTranscriptImport,
  type TranscriptImportSource
} from "@/lib/transcript-import/prepare";
import type { TranscriptImportRequest } from "@/lib/transcript-import/request";
import type { Meeting } from "@/lib/types";

/**
 * Turns a validated, parsed transcript into a normal Parfait meeting.
 *
 * Idempotency without a new column: the client's import UUID becomes the meeting's primary key.
 * The database's own uniqueness on meetings.id is what makes "same import twice" create one
 * meeting, including for two truly concurrent requests (one INSERT wins, the other gets 23505).
 *
 * Exclusivity: the meeting is inserted already holding meetings.transcript_import_claimed_at (the
 * same claim column the Recall import uses; the two never touch the same meeting). Only the claim
 * holder commits the transcript. A concurrent duplicate sees an active claim and gets
 * `import_in_progress`; after the claim goes stale (the holder crashed), a retry can re-claim it
 * and finish the import.
 *
 * Analysis: only through commitTranscriptAndEnqueueAnalysis, which replaces the segments in one
 * transaction, then moves the meeting to transcript_ready through the forward-only guard, and
 * enqueues the normal analysis only if that transition was won. So a failed segment save never
 * queues analysis, and no import, retry or race can queue it twice.
 *
 * Every dependency is injected so the whole decision tree is tested without a database.
 */

export type ImportMeetingRow = Pick<
  Meeting,
  "id" | "user_id" | "title" | "status" | "source" | "meeting_date" | "project_id" | "deleted_at" | "created_at"
>;

export type NewImportMeetingRow = {
  id: string;
  user_id: string;
  title: string | null;
  meeting_url: null;
  recall_bot_id: null;
  platform: "unknown";
  status: "pending";
  source: TranscriptImportSource;
  meeting_date: string | null;
  project_id: string | null;
  transcript_import_claimed_at: string;
};

export type TranscriptImportDeps = {
  now: () => Date;
  /** By primary key, regardless of owner: the caller decides what the requester may see. */
  findMeeting: (meetingId: string) => Promise<ImportMeetingRow | null>;
  isOwnedProject: (projectId: string, userId: string) => Promise<boolean>;
  /** Manual imports this user created since `sinceIso`, deleted ones included. */
  countImportsSince: (userId: string, sinceIso: string) => Promise<number>;
  /** `duplicate` only for a primary-key collision; any other failure throws. */
  insertMeeting: (row: NewImportMeetingRow) => Promise<"inserted" | "duplicate">;
  /** Atomically takes the import claim on a still-pending manual meeting whose claim is free or
   * stale. False when someone else holds it or the meeting is no longer pending. */
  claimImport: (meetingId: string) => Promise<boolean>;
  releaseImportClaim: (meetingId: string) => Promise<void>;
  /** How many segments the meeting has, and the content hash they were imported with. */
  readStoredImport: (meetingId: string) => Promise<{ segmentCount: number; contentSha256: string | null }>;
  commitTranscript: (input: { meetingId: string; segments: CommittableTranscriptSegment[] }) => Promise<CommitTranscriptResult>;
  latestAnalysisJob: (meetingId: string) => Promise<{ id: string; status: string; generation: number } | null>;
};

export type ImportErrorCode =
  | "project_not_found"
  | "rate_limited"
  | "import_id_conflict"
  | "import_in_progress"
  | "import_failed"
  | "import_incomplete";

export type ImportAnalysisState =
  | { status: "queued"; jobId: string; generation: number }
  /** The transcript is saved and the meeting is transcript_ready, but starting analysis failed.
   * The existing Analyze Meeting action (POST /api/meetings/[id]/analyze) retries it. */
  | { status: "enqueue_failed" }
  | { status: "existing"; jobStatus: string | null; jobId: string | null };

export type TranscriptImportSuccess = {
  ok: true;
  httpStatus: 200 | 201;
  body: {
    meeting: ImportMeetingRow;
    import: {
      outcome: "created" | "recovered" | "already_imported";
      source: TranscriptImportSource;
      format: PreparedTranscriptImport["format"];
      segmentCount: number;
      warnings: TranscriptImportWarning[];
    };
    analysis: ImportAnalysisState;
  };
};

export type TranscriptImportFailure = {
  ok: false;
  httpStatus: 404 | 409 | 429 | 500;
  /** Seconds, for 409 import_in_progress and 429. */
  retryAfterSeconds?: number;
  body: { error: string; code: ImportErrorCode; retryable: boolean; meetingId?: string };
};

export type TranscriptImportOutcome = TranscriptImportSuccess | TranscriptImportFailure;

const MANUAL_SOURCES = new Set<string>(["manual_upload", "manual_paste"]);

/** One response for every "this import id is not usable by you" case, so a caller cannot tell
 * another user's meeting from a mismatched retry of their own. */
const conflict = (): TranscriptImportFailure => ({
  ok: false,
  httpStatus: 409,
  body: {
    error: "This import ID was already used for a different import. Start a new import.",
    code: "import_id_conflict",
    retryable: false
  }
});

const inProgress = (meetingId: string): TranscriptImportFailure => ({
  ok: false,
  httpStatus: 409,
  retryAfterSeconds: 15,
  body: { error: "This import is already being processed.", code: "import_in_progress", retryable: true, meetingId }
});

const incomplete = (meetingId: string, retryable: boolean): TranscriptImportFailure => ({
  ok: false,
  httpStatus: 500,
  body: {
    error: retryable
      ? "The meeting was created but its transcript could not be saved. Retry the same import to finish it."
      : "The transcript was saved but the meeting could not be finished.",
    code: "import_incomplete",
    retryable,
    meetingId
  }
});

function warningsFor(prepared: PreparedTranscriptImport, request: TranscriptImportRequest): TranscriptImportWarning[] {
  return request.meetingDate ? prepared.warnings : [...prepared.warnings, meetingDateMissingWarning()];
}

async function commitAndRespond(
  meetingId: string,
  outcome: "created" | "recovered",
  prepared: PreparedTranscriptImport,
  request: TranscriptImportRequest,
  deps: TranscriptImportDeps
): Promise<TranscriptImportOutcome> {
  let committed: CommitTranscriptResult;
  try {
    committed = await deps.commitTranscript({ meetingId, segments: prepared.segments });
  } catch (error) {
    // The transactional replace or the status guard failed: nothing was analyzed. Free the claim
    // (best effort) so a retry with the same import id can finish the meeting right away.
    console.warn("[transcript-import] Commit failed; meeting left pending for retry", {
      meeting_id: meetingId,
      error: error instanceof Error ? error.message : String(error)
    });
    await deps.releaseImportClaim(meetingId).catch(() => undefined);
    return incomplete(meetingId, true);
  }

  if (committed.status === "transition_lost") {
    // We hold the claim on a pending meeting, so only an outside status change gets here.
    console.warn("[transcript-import] transcript_ready transition lost", { meeting_id: meetingId });
    return incomplete(meetingId, false);
  }

  const meeting = await deps.findMeeting(meetingId);
  if (!meeting) return incomplete(meetingId, false);
  return {
    ok: true,
    httpStatus: outcome === "created" ? 201 : 200,
    body: {
      meeting,
      import: {
        outcome,
        source: prepared.source,
        format: prepared.format,
        segmentCount: committed.insertedCount,
        warnings: warningsFor(prepared, request)
      },
      analysis:
        committed.status === "analysis_queued"
          ? { status: "queued", jobId: committed.jobId, generation: committed.generation }
          : { status: "enqueue_failed" }
    }
  };
}

async function resumeExisting(
  meeting: ImportMeetingRow | null,
  userId: string,
  prepared: PreparedTranscriptImport,
  request: TranscriptImportRequest,
  deps: TranscriptImportDeps
): Promise<TranscriptImportOutcome> {
  if (!meeting || meeting.user_id !== userId || meeting.deleted_at || !MANUAL_SOURCES.has(meeting.source ?? "")) {
    return conflict();
  }
  if (meeting.source !== prepared.source) return conflict();

  if (meeting.status === "transcript_ready" || meeting.status === "completed") {
    // Title, date and project are editable after an import, so only the content identifies it.
    const stored = await deps.readStoredImport(meeting.id);
    if (stored.contentSha256 !== prepared.contentSha256) return conflict();
    const job = await deps.latestAnalysisJob(meeting.id);
    return {
      ok: true,
      httpStatus: 200,
      body: {
        meeting,
        import: {
          outcome: "already_imported",
          source: prepared.source,
          format: prepared.format,
          segmentCount: stored.segmentCount,
          warnings: warningsFor(prepared, request)
        },
        analysis: { status: "existing", jobStatus: job?.status ?? null, jobId: job?.id ?? null }
      }
    };
  }

  if (meeting.status === "failed") {
    return {
      ok: false,
      httpStatus: 409,
      body: { error: "This import failed and cannot be resumed. Start a new import.", code: "import_failed", retryable: false, meetingId: meeting.id }
    };
  }
  if (meeting.status !== "pending") return conflict();

  // A pending import: either still running elsewhere, or abandoned mid-way. Finishing it requires
  // the same details it was created with.
  if (
    (meeting.title ?? null) !== request.title ||
    (meeting.meeting_date ?? null) !== request.meetingDate ||
    (meeting.project_id ?? null) !== request.projectId
  ) {
    return conflict();
  }
  if (!(await deps.claimImport(meeting.id))) {
    const current = await deps.findMeeting(meeting.id);
    if (current && current.status !== "pending") return resumeExisting(current, userId, prepared, request, deps);
    return inProgress(meeting.id);
  }
  const stored = await deps.readStoredImport(meeting.id);
  if (stored.segmentCount > 0 && stored.contentSha256 !== prepared.contentSha256) {
    await deps.releaseImportClaim(meeting.id).catch(() => undefined);
    return conflict();
  }
  return commitAndRespond(meeting.id, "recovered", prepared, request, deps);
}

export async function importTranscript(
  input: { userId: string; request: TranscriptImportRequest; prepared: PreparedTranscriptImport },
  deps: TranscriptImportDeps
): Promise<TranscriptImportOutcome> {
  const { userId, request, prepared } = input;
  const importId = request.importId;
  if (!importId) throw new Error("importTranscript requires an import id.");

  const existing = await deps.findMeeting(importId);
  if (existing) return resumeExisting(existing, userId, prepared, request, deps);

  if (request.projectId && !(await deps.isOwnedProject(request.projectId, userId))) {
    return {
      ok: false,
      httpStatus: 404,
      body: { error: "Project not found.", code: "project_not_found", retryable: false }
    };
  }

  // Durable, per-user creation limits (retries of an existing import id never reach this).
  const now = deps.now();
  const [lastHour, lastDay] = await Promise.all([
    deps.countImportsSince(userId, new Date(now.getTime() - 60 * 60 * 1000).toISOString()),
    deps.countImportsSince(userId, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
  ]);
  if (lastHour >= IMPORTS_PER_HOUR || lastDay >= IMPORTS_PER_DAY) {
    return {
      ok: false,
      httpStatus: 429,
      retryAfterSeconds: lastHour >= IMPORTS_PER_HOUR ? 60 * 60 : 24 * 60 * 60,
      body: {
        error:
          lastHour >= IMPORTS_PER_HOUR
            ? `You can import up to ${IMPORTS_PER_HOUR} transcripts per hour. Try again later.`
            : `You can import up to ${IMPORTS_PER_DAY} transcripts per day. Try again tomorrow.`,
        code: "rate_limited",
        retryable: true
      }
    };
  }

  // The project is set in the same INSERT that creates the meeting (after the ownership check
  // above), so it is assigned before any transcript exists and long before analysis starts.
  const inserted = await deps.insertMeeting({
    id: importId,
    user_id: userId,
    title: request.title,
    meeting_url: null,
    recall_bot_id: null,
    platform: "unknown",
    status: "pending",
    source: prepared.source,
    meeting_date: request.meetingDate,
    project_id: request.projectId,
    transcript_import_claimed_at: now.toISOString()
  });
  if (inserted === "duplicate") {
    return resumeExisting(await deps.findMeeting(importId), userId, prepared, request, deps);
  }
  return commitAndRespond(importId, "created", prepared, request, deps);
}
