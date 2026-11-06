/**
 * Body of POST /api/meetings/[id]/analyze-v2, with its I/O injected so the gate -> auth ->
 * ownership -> transcript -> enqueue order is testable without a request context.
 *
 * A closed gate answers exactly like a missing route (404 "Not found") before any auth or DB
 * read, so callers cannot tell v2 exists for a meeting that is not allowlisted. An open gate
 * never bypasses authorization: the caller must be signed in and own the meeting.
 */
export type AnalyzeV2Deps = {
  isEnabledForMeeting: (meetingId: string) => boolean;
  authenticate: () => Promise<{ userId: string } | null>;
  findOwnedMeeting: (meetingId: string, userId: string) => Promise<boolean>;
  countTranscriptSegments: (meetingId: string) => Promise<{ count: number; error: string | null }>;
  enqueue: (meetingId: string) => Promise<
    | { ok: true; jobId: string; generation: number; status: string }
    | { ok: false; error: string; details?: string }
  >;
};

export type AnalyzeV2Response = { status: number; body: Record<string, unknown> };

export async function handleAnalyzeV2Request(meetingId: string, deps: AnalyzeV2Deps): Promise<AnalyzeV2Response> {
  if (!deps.isEnabledForMeeting(meetingId)) {
    return { status: 404, body: { error: "Not found" } };
  }
  const user = await deps.authenticate();
  if (!user) return { status: 401, body: { error: "Unauthorized" } };

  if (!(await deps.findOwnedMeeting(meetingId, user.userId))) {
    return { status: 404, body: { error: "Meeting not found" } };
  }

  const segments = await deps.countTranscriptSegments(meetingId);
  if (segments.error) {
    return { status: 500, body: { error: "Failed to fetch transcript", details: segments.error } };
  }
  if (segments.count < 1) {
    return { status: 400, body: { error: "No transcript available yet" } };
  }

  const enqueued = await deps.enqueue(meetingId);
  if (!enqueued.ok) {
    return { status: 500, body: { error: enqueued.error, details: enqueued.details } };
  }
  return {
    status: 202,
    body: {
      accepted: true,
      pipelineVersion: 2,
      jobId: enqueued.jobId,
      generation: enqueued.generation,
      status: enqueued.status,
      message: "Meeting analysis (pipeline v2) queued."
    }
  };
}
