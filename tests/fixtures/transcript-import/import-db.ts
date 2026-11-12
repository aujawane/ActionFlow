import { allowedPriorStatuses } from "../../../lib/recall/webhook-events";
import { commitTranscriptAndEnqueueAnalysis, type CommittableTranscriptSegment } from "../../../lib/transcript-commit";
import { IMPORT_CLAIM_STALE_AFTER_MS } from "../../../lib/transcript-import/limits";
import type { ImportMeetingRow, NewImportMeetingRow, TranscriptImportDeps } from "../../../lib/transcript-import/service";
import type { Meeting } from "../../../lib/types";

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";
export const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type StoredMeeting = NewImportMeetingRow & { created_at: string; deleted_at: string | null };
type StoredSegment = CommittableTranscriptSegment & { id: string; meeting_id: string };

/** In-memory model of exactly the guarantees the import relies on: primary-key uniqueness on
 * meetings.id, the guarded claim UPDATE, the transactional replace, and the forward-only status
 * guard. Every operation yields first, so concurrent requests genuinely interleave. */
export class ImportDb {
  meetings = new Map<string, StoredMeeting>();
  segments = new Map<string, StoredSegment[]>();
  projects = [
    { id: PROJECT_A, owner_id: USER_A },
    { id: PROJECT_B, owner_id: USER_B }
  ];
  enqueueCalls: string[] = [];
  jobs: Array<{ id: string; meeting_id: string; status: string; generation: number }> = [];
  clock = Date.parse("2026-11-11T12:00:00.000Z");
  failReplace = 0;
  failEnqueue = 0;
  failInsertWith: Error | null = null;
  crashAfterInsert = false;
  segmentSeq = 0;

  meetingRow(id: string): ImportMeetingRow | null {
    const row = this.meetings.get(id);
    if (!row) return null;
    const { id: meetingId, user_id, title, status, source, meeting_date, project_id, deleted_at, created_at } = row;
    return { id: meetingId, user_id, title, status, source, meeting_date, project_id, deleted_at, created_at } as ImportMeetingRow;
  }

  deps(): TranscriptImportDeps {
    return {
      now: () => new Date(this.clock),
      findMeeting: async (id) => {
        await tick();
        return this.meetingRow(id);
      },
      isOwnedProject: async (projectId, userId) => {
        await tick();
        return this.projects.some((project) => project.id === projectId && project.owner_id === userId);
      },
      countImportsSince: async (userId, sinceIso) => {
        await tick();
        return [...this.meetings.values()].filter(
          (meeting) => meeting.user_id === userId && meeting.created_at >= sinceIso && meeting.source.startsWith("manual_")
        ).length;
      },
      insertMeeting: async (row) => {
        await tick();
        if (this.failInsertWith) throw this.failInsertWith;
        if (this.meetings.has(row.id)) return "duplicate";
        this.meetings.set(row.id, { ...row, created_at: new Date(this.clock).toISOString(), deleted_at: null });
        if (this.crashAfterInsert) {
          this.crashAfterInsert = false;
          throw new Error("function instance killed");
        }
        return "inserted";
      },
      claimImport: async (id) => {
        await tick();
        const meeting = this.meetings.get(id);
        const staleBefore = new Date(this.clock - IMPORT_CLAIM_STALE_AFTER_MS).toISOString();
        if (
          !meeting ||
          meeting.status !== "pending" ||
          meeting.deleted_at ||
          !meeting.source.startsWith("manual_") ||
          (meeting.transcript_import_claimed_at !== null && meeting.transcript_import_claimed_at >= staleBefore)
        ) {
          return false;
        }
        meeting.transcript_import_claimed_at = new Date(this.clock).toISOString();
        return true;
      },
      releaseImportClaim: async (id) => {
        await tick();
        const meeting = this.meetings.get(id);
        if (meeting?.status === "pending") (meeting as { transcript_import_claimed_at: string | null }).transcript_import_claimed_at = null;
      },
      readStoredImport: async (id) => {
        await tick();
        const rows = this.segments.get(id) ?? [];
        const payload = (rows[0]?.raw_payload as { parfait_import?: { content_sha256?: string } } | undefined)?.parfait_import;
        return { segmentCount: rows.length, contentSha256: payload?.content_sha256 ?? null };
      },
      // The REAL shared helper, with only its storage primitives faked.
      commitTranscript: ({ meetingId, segments }) =>
        commitTranscriptAndEnqueueAnalysis(
          { meetingId, segments },
          {
            replaceTranscriptSegments: async (id, rows) => {
              await tick();
              if (this.failReplace > 0) {
                this.failReplace -= 1;
                throw new Error("replace_meeting_transcript_segments failed: statement timeout");
              }
              this.segments.set(id, rows.map((row) => ({ ...row, id: uuid(++this.segmentSeq), meeting_id: id })));
              return { insertedCount: rows.length };
            },
            applyGuardedMeetingStatus: async (id, status) => {
              await tick();
              const meeting = this.meetings.get(id);
              if (!meeting || !allowedPriorStatuses(status).includes(meeting.status as Meeting["status"])) return false;
              (meeting as { status: string }).status = status;
              return true;
            },
            enqueueMeetingAnalysis: async (id) => {
              await tick();
              this.enqueueCalls.push(id);
              if (this.failEnqueue > 0) {
                this.failEnqueue -= 1;
                return { ok: false, error: "Failed to claim an analysis job.", details: "rpc unavailable" };
              }
              const job = { id: `job-${this.jobs.length + 1}`, meeting_id: id, status: "queued", generation: this.jobs.length + 1 };
              this.jobs.push(job);
              return { ok: true, jobId: job.id, generation: job.generation, status: "queued" };
            }
          }
        ),
      latestAnalysisJob: async (id) => {
        await tick();
        return [...this.jobs].reverse().find((job) => job.meeting_id === id) ?? null;
      }
    };
  }
}

