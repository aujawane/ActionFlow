import { getLatestMeetingAnalysisJob } from "@/lib/meeting-analysis/jobs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { commitTranscriptAndEnqueueAnalysis } from "@/lib/transcript-commit";
import { isMeetingPrimaryKeyViolation } from "@/lib/transcript-import/duplicate";
import { IMPORT_CLAIM_STALE_AFTER_MS } from "@/lib/transcript-import/limits";
import type { ParfaitImportPayload } from "@/lib/transcript-import/prepare";
import type { ImportMeetingRow, TranscriptImportDeps } from "@/lib/transcript-import/service";
import { PARFAIT_IMPORT_PAYLOAD_KEY } from "@/lib/transcript-order";

const MANUAL_SOURCES = ["manual_upload", "manual_paste"];
const MEETING_COLUMNS = "id,user_id,title,status,source,meeting_date,project_id,deleted_at,created_at,transcript_import_content_sha256";

/** The service-role implementations of the import's dependencies. Server-only. */
export const supabaseTranscriptImportDeps: TranscriptImportDeps = {
  now: () => new Date(),

  async findMeeting(meetingId) {
    const { data, error } = await supabaseAdmin.from("meetings").select(MEETING_COLUMNS).eq("id", meetingId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ImportMeetingRow | null) ?? null;
  },

  async isOwnedProject(projectId, userId) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("owner_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Boolean(data);
  },

  async countImportsSince(userId, sinceIso) {
    const { count, error } = await supabaseAdmin
      .from("meetings")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("source", MANUAL_SOURCES)
      .gte("created_at", sinceIso);
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  async insertMeeting(row) {
    const { error } = await supabaseAdmin.from("meetings").insert(row);
    if (!error) return "inserted";
    if (isMeetingPrimaryKeyViolation(error)) return "duplicate";
    throw new Error(error.message);
  },

  /** Same shape as Recall's claimTranscriptImport (one guarded UPDATE ... RETURNING), limited to a
   * still-pending manual import and with the import route's shorter staleness window. */
  async claimImport(meetingId) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - IMPORT_CLAIM_STALE_AFTER_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("meetings")
      .update({ transcript_import_claimed_at: now.toISOString() })
      .eq("id", meetingId)
      .eq("status", "pending")
      .in("source", MANUAL_SOURCES)
      .is("deleted_at", null)
      .or(`transcript_import_claimed_at.is.null,transcript_import_claimed_at.lt.${staleBefore}`)
      .select("id");
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  },

  async releaseImportClaim(meetingId) {
    const { error } = await supabaseAdmin
      .from("meetings")
      .update({ transcript_import_claimed_at: null })
      .eq("id", meetingId)
      .eq("status", "pending")
      .in("source", MANUAL_SOURCES);
    if (error) throw new Error(error.message);
  },

  async readStoredImport(meetingId) {
    const [{ count, error: countError }, { data, error }] = await Promise.all([
      supabaseAdmin.from("transcript_segments").select("id", { count: "exact", head: true }).eq("meeting_id", meetingId),
      // Every imported row carries the same content hash; any one of them identifies the import.
      supabaseAdmin.from("transcript_segments").select("raw_payload").eq("meeting_id", meetingId).limit(1)
    ]);
    if (countError) throw new Error(countError.message);
    if (error) throw new Error(error.message);
    const payload = (data?.[0]?.raw_payload as Record<string, Partial<ParfaitImportPayload>> | undefined)?.[
      PARFAIT_IMPORT_PAYLOAD_KEY
    ];
    return {
      segmentCount: count ?? 0,
      contentSha256: typeof payload?.content_sha256 === "string" ? payload.content_sha256 : null
    };
  },

  commitTranscript: ({ meetingId, segments }) => commitTranscriptAndEnqueueAnalysis({ meetingId, segments }),

  async latestAnalysisJob(meetingId) {
    const job = await getLatestMeetingAnalysisJob(meetingId);
    return job ? { id: job.id, status: job.status, generation: job.generation } : null;
  }
};
