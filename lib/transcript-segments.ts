import { applySpeakerAliases } from "@/lib/speaker-aliases";
import type { MeetingSpeakerAlias, TranscriptSegment } from "@/lib/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSegmentId(value: string) {
  return UUID_PATTERN.test(value.trim());
}

export function filterValidSegmentIds(
  segmentIds: string[] | null | undefined
): string[] {
  if (!Array.isArray(segmentIds)) {
    return [];
  }

  return segmentIds
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && isValidSegmentId(value));
}

export function getSegmentIdsFromTopic(
  segmentIds: unknown,
  validIds?: Iterable<string>
): string[] {
  const allowed = validIds ? new Set(validIds) : null;
  return filterValidSegmentIds(
    Array.isArray(segmentIds)
      ? segmentIds.filter((value): value is string => {
          if (typeof value !== "string") return false;
          if (!isValidSegmentId(value)) return false;
          return allowed ? allowed.has(value.trim()) : true;
        })
      : []
  );
}

export async function loadMeetingTranscriptSegments(input: {
  meetingId: string;
  segmentIds?: string[] | null;
  limit?: number;
}) {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const limit = input.limit ?? 12;
  const segmentIds = filterValidSegmentIds(input.segmentIds);
  const baseQuery = () =>
    supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", input.meetingId)
      .order("timestamp", { ascending: true });

  if (segmentIds.length > 0) {
    const scoped = await baseQuery().in("id", segmentIds);
    if (!scoped.error && (scoped.data?.length ?? 0) > 0) {
      return {
        segments: (scoped.data ?? []) as TranscriptSegment[],
        error: null as null
      };
    }

    if (scoped.error) {
      console.warn("[loadMeetingTranscriptSegments] Scoped transcript query failed; falling back", {
        meeting_id: input.meetingId,
        segment_id_count: segmentIds.length,
        details: scoped.error.message
      });
    }
  }

  const fallback = await baseQuery().limit(limit);
  return {
    segments: (fallback.data ?? []) as TranscriptSegment[],
    error: fallback.error
  };
}

export async function loadResolvedMeetingTranscriptSegments(input: {
  meetingId: string;
  segmentIds?: string[] | null;
  limit?: number;
}) {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const [{ segments, error: segmentsError }, { data: aliases, error: aliasesError }] =
    await Promise.all([
      loadMeetingTranscriptSegments(input),
      supabaseAdmin
        .from("meeting_speaker_aliases")
        .select("*")
        .eq("meeting_id", input.meetingId)
    ]);

  return {
    segments: applySpeakerAliases(segments, (aliases ?? []) as MeetingSpeakerAlias[]),
    aliases: (aliases ?? []) as MeetingSpeakerAlias[],
    segmentsError,
    aliasesError
  };
}
