import {
  analyzeTranscriptWithOpenAI,
  buildCleanTranscript,
  buildInsightsPayload,
  buildTranscriptWithSegmentIds,
  segmentMeetingTopicsWithOpenAI
} from "@/lib/analysis";
import type { ExecutionSourceContext } from "@/lib/execution-intelligence/stages";
import { applySpeakerAliases } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  ExtractedInsight,
  MeetingSpeakerAlias,
  MeetingTopic,
  TranscriptSegment
} from "@/lib/types";

const MIN_ANALYSIS_WORDS = 25;
const MIN_ANALYSIS_SEGMENTS = 2;

export type PreparedMeetingAnalysis = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  meetingContextByTopicId: Array<[string, string]>;
};

function countTranscriptWords(segments: TranscriptSegment[]) {
  return segments.reduce(
    (total, segment) =>
      total + segment.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
}

function isMissingRelationError(
  error: { code?: string; message?: string } | null,
  relation: string
) {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    Boolean(error.message?.toLowerCase().includes(relation.toLowerCase()))
  );
}

function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  column: string
) {
  if (!error) return false;
  return (
    error.code === "42703" ||
    Boolean(error.message?.toLowerCase().includes(column.toLowerCase()))
  );
}

async function insertInsightsRows(
  rows: Array<{
    meeting_id: string;
    topic_id: string | null;
    category: string;
    content: string;
    confidence: number | null;
  }>
) {
  const firstAttempt = await supabaseAdmin
    .from("extracted_insights")
    .insert(rows)
    .select("*");
  if (!firstAttempt.error || !isMissingColumnError(firstAttempt.error, "topic_id")) {
    return firstAttempt;
  }

  return supabaseAdmin
    .from("extracted_insights")
    .insert(
      rows.map((row) => ({
        meeting_id: row.meeting_id,
        category: row.category,
        content: row.content,
        confidence: row.confidence
      }))
    )
    .select("*");
}

export async function prepareMeetingAnalysis(
  meetingId: string
): Promise<PreparedMeetingAnalysis> {
  const [
    { data: meeting, error: meetingError },
    { data: segments, error: segmentsError },
    { data: aliases, error: aliasesError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("id, created_at")
      .eq("id", meetingId)
      .is("deleted_at", null)
      .single(),
    supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("timestamp", { ascending: true }),
    supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("*")
      .eq("meeting_id", meetingId)
  ]);

  if (meetingError || !meeting) throw new Error("Meeting not found.");
  if (segmentsError) throw new Error(`Failed to fetch transcript: ${segmentsError.message}`);
  if (aliasesError) throw new Error(`Failed to fetch speaker aliases: ${aliasesError.message}`);

  const safeSegments = applySpeakerAliases(
    (segments ?? []) as TranscriptSegment[],
    (aliases ?? []) as MeetingSpeakerAlias[]
  );
  const transcript = buildCleanTranscript(safeSegments);
  if (!transcript.trim() || safeSegments.length === 0) {
    throw new Error("No transcript available yet.");
  }

  const segmentationTranscript = buildTranscriptWithSegmentIds(safeSegments);
  const meetingDate = meeting.created_at ?? new Date().toISOString();
  const buildResult = (
    topics: MeetingTopic[],
    insights: ExtractedInsight[],
    fallbackUsed: boolean,
    contexts: Array<[string, string]> = []
  ): PreparedMeetingAnalysis => ({
    fallbackUsed,
    meetingContextByTopicId: contexts,
    source: {
      meetingId,
      meetingDate,
      transcript: segmentationTranscript,
      transcriptSegmentCount: safeSegments.length,
      topics: topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        segment_ids: topic.segment_ids
      })),
      insights: insights.map((insight) => ({
        topic_id: insight.topic_id,
        category: insight.category,
        content: insight.content
      }))
    }
  });

  if (
    safeSegments.length < MIN_ANALYSIS_SEGMENTS ||
    countTranscriptWords(safeSegments) < MIN_ANALYSIS_WORDS
  ) {
    return buildResult([], [], true);
  }

  const fallback = async (reason: string) => {
    console.warn("[meeting-analysis] Falling back to whole-meeting analysis:", reason);
    const analysis = await analyzeTranscriptWithOpenAI(transcript);
    await supabaseAdmin.from("meeting_topics").delete().eq("meeting_id", meetingId);
    await supabaseAdmin.from("extracted_insights").delete().eq("meeting_id", meetingId);

    let inserted: ExtractedInsight[] = [];
    if (analysis.ok) {
      const result = await insertInsightsRows(
        buildInsightsPayload({
          meetingId,
          analysis: analysis.data,
          topicId: null
        })
      );
      if (!result.error) inserted = (result.data ?? []) as ExtractedInsight[];
    }
    return buildResult([], inserted, true);
  };

  const segmentation = await segmentMeetingTopicsWithOpenAI(segmentationTranscript);
  if (!segmentation.ok || segmentation.data.topics.length === 0) {
    return fallback(
      segmentation.ok
        ? "No topics returned by segmentation model"
        : segmentation.details ?? segmentation.error
    );
  }

  const { error: deleteInsightsError } = await supabaseAdmin
    .from("extracted_insights")
    .delete()
    .eq("meeting_id", meetingId);
  if (deleteInsightsError) throw new Error(deleteInsightsError.message);

  const { error: deleteTopicsError } = await supabaseAdmin
    .from("meeting_topics")
    .delete()
    .eq("meeting_id", meetingId);
  if (deleteTopicsError) {
    if (isMissingRelationError(deleteTopicsError, "meeting_topics")) {
      return fallback("meeting_topics table not found; using whole-meeting analysis fallback.");
    }
    throw new Error(deleteTopicsError.message);
  }

  const segmentMap = new Map(safeSegments.map((segment) => [segment.id, segment]));
  const { data: insertedTopics, error: insertTopicsError } = await supabaseAdmin
    .from("meeting_topics")
    .insert(
      segmentation.data.topics.map((topic) => ({
        meeting_id: meetingId,
        title: topic.title,
        summary: topic.summary,
        start_timestamp: topic.start_timestamp,
        end_timestamp: topic.end_timestamp,
        segment_ids: topic.segment_ids.filter((segmentId) => segmentMap.has(segmentId)),
        confidence: topic.confidence ?? null,
        separation_reason: topic.separation_reason
      }))
    )
    .select("*");
  if (insertTopicsError || !insertedTopics) {
    return fallback(insertTopicsError?.message ?? "Failed to insert segmented topics");
  }

  const insights: ExtractedInsight[] = [];
  const contexts: Array<[string, string]> = [];
  for (let index = 0; index < insertedTopics.length; index += 1) {
    const topic = insertedTopics[index] as MeetingTopic;
    const topicDefinition = segmentation.data.topics[index];
    const topicSegments = topicDefinition.segment_ids
      .map((segmentId) => segmentMap.get(segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
    if (topicSegments.length === 0) continue;

    const topicTranscript = buildCleanTranscript(topicSegments);
    contexts.push([topic.id, topicTranscript]);
    const analysis = await analyzeTranscriptWithOpenAI(topicTranscript);
    if (!analysis.ok) continue;
    const result = await insertInsightsRows(
      buildInsightsPayload({
        meetingId,
        topicId: topic.id,
        analysis: analysis.data
      })
    );
    if (!result.error) insights.push(...((result.data ?? []) as ExtractedInsight[]));
  }

  return buildResult(insertedTopics as MeetingTopic[], insights, false, contexts);
}
