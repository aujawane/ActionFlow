import {
  analyzeTranscriptWithOpenAI,
  buildCleanTranscript,
  buildInsightsPayload,
  segmentMeetingTopicsWithOpenAI
} from "@/lib/analysis";
import type { ExecutionSourceContext } from "@/lib/execution-intelligence/stages";
import { getEffectiveMeetingDate } from "@/lib/meeting-date";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadAllMeetingTranscriptSegmentsAdmin } from "@/lib/transcript-loader";
import { buildCanonicalTranscriptWithSegmentIds, canonicalTranscriptOrder } from "@/lib/transcript-order";
import { normalizeTranscriptSpeaker } from "@/lib/transcript-speaker";
import type {
  ExtractedInsight,
  MeetingTopic,
  Project,
  TranscriptSegment
} from "@/lib/types";

const MIN_ANALYSIS_WORDS = 25;
const MIN_ANALYSIS_SEGMENTS = 2;

export type PreparedMeetingAnalysis = {
  source: ExecutionSourceContext;
  fallbackUsed: boolean;
  meetingContextByTopicId: Array<[string, string]>;
};

/** Everything in the prepared source except topics/insights. Shared by pipeline v1 and v2. */
export type PreparedSourceBase = Omit<ExecutionSourceContext, "topics" | "insights">;

export type MeetingAnalysisInput = {
  safeSegments: TranscriptSegment[];
  /** Clean transcript: whole-meeting fallback analysis input. */
  transcript: string;
  /** Segment-ID transcript: segmentation input and source.transcript. */
  segmentationTranscript: string;
  sourceBase: PreparedSourceBase;
};

function countTranscriptWords(segments: TranscriptSegment[]) {
  return segments.reduce(
    (total, segment) =>
      total + segment.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
}

export function isTranscriptTooShortForTopicAnalysis(segments: TranscriptSegment[]) {
  return (
    segments.length < MIN_ANALYSIS_SEGMENTS ||
    countTranscriptWords(segments) < MIN_ANALYSIS_WORDS
  );
}

/** Model segment IDs present in this transcript, in model order (duplicates preserved). */
export function existingTopicSegmentIds(
  segmentIds: string[],
  segmentMap: Map<string, TranscriptSegment>
) {
  return segmentIds.filter((segmentId) => segmentMap.has(segmentId));
}

/** Null when no segment exists: such a topic gets no context and no analysis call. */
export function buildTopicTranscript(
  segmentIds: string[],
  segmentMap: Map<string, TranscriptSegment>
) {
  const topicSegments = canonicalTranscriptOrder(
    segmentIds
      .map((segmentId) => segmentMap.get(segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
  );
  return topicSegments.length === 0 ? null : buildCleanTranscript(topicSegments);
}

export function buildPreparedMeetingAnalysis(
  sourceBase: PreparedSourceBase,
  topics: Array<Pick<MeetingTopic, "id" | "title" | "summary" | "segment_ids">>,
  insights: Array<Pick<ExtractedInsight, "topic_id" | "category" | "content">>,
  fallbackUsed: boolean,
  contexts: Array<[string, string]> = []
): PreparedMeetingAnalysis {
  return {
    fallbackUsed,
    meetingContextByTopicId: contexts,
    source: {
      ...sourceBase,
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
  };
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

/** Loads the meeting, transcript, and project context. Performs no writes and no model calls. */
export async function loadMeetingAnalysisInput(meetingId: string): Promise<MeetingAnalysisInput> {
  const [
    { data: meeting, error: meetingError },
    { data: segments, error: segmentsError }
  ] = await Promise.all([
    supabaseAdmin
      .from("meetings")
      .select("*")
      .eq("id", meetingId)
      .is("deleted_at", null)
      .single(),
    // Every page of the transcript: a plain select stops at PostgREST's 1,000-row cap.
    loadAllMeetingTranscriptSegmentsAdmin<TranscriptSegment>({ meetingId })
  ]);

  if (meetingError || !meeting) throw new Error("Meeting not found.");
  if (segmentsError) throw new Error(`Failed to fetch transcript: ${segmentsError.message}`);

  const meetingProjectId =
    typeof meeting.project_id === "string" ? meeting.project_id : null;
  const [
    { data: project },
    { data: projectMemory },
    { data: projectConstraints },
    { data: projectDecisions }
  ] = meetingProjectId
    ? await Promise.all([
        supabaseAdmin
          .from("projects")
          .select("id, name, goal")
          .eq("id", meetingProjectId)
          .eq("owner_id", meeting.user_id)
          .maybeSingle(),
        supabaseAdmin
          .from("project_memory")
          .select(
            "summary,goal,current_scope,future_scope,technical_context,confirmed_fields"
          )
          .eq("project_id", meetingProjectId)
          .maybeSingle(),
        supabaseAdmin
          .from("project_constraints")
          .select("id,title,description,category,manually_confirmed")
          .eq("project_id", meetingProjectId)
          .eq("status", "active")
          .limit(100),
        supabaseAdmin
          .from("project_decisions")
          .select("id,title,description,manually_confirmed")
          .eq("project_id", meetingProjectId)
          .eq("status", "active")
          .limit(100)
      ])
    : [
        { data: null },
        { data: null },
        { data: [] },
        { data: [] }
      ];

  // Reasoning (topics/insights/execution-intelligence/commitments) reads normalized_text when
  // normalization has run for a segment, falling back to the immutable raw text otherwise --
  // transcript_segments.text itself is never overwritten. This is the single point where every
  // downstream consumer of prepareMeetingAnalysis picks up normalization's result; no other
  // stage needs to know normalization happened.
  const safeSegments = canonicalTranscriptOrder((segments ?? []) as TranscriptSegment[])
    .map((segment) => ({ ...segment, text: segment.normalized_text ?? segment.text }))
    .map(normalizeTranscriptSpeaker);
  const transcript = buildCleanTranscript(safeSegments);
  if (!transcript.trim() || safeSegments.length === 0) {
    throw new Error("No transcript available yet.");
  }

  const segmentationTranscript = buildCanonicalTranscriptWithSegmentIds(safeSegments);
  // The date relative phrases ("tomorrow", "Friday") are resolved against: when the meeting
  // happened, not when a historical transcript was imported. Recall meetings: unchanged.
  const meetingDate = meeting.created_at
    ? getEffectiveMeetingDate(meeting)
    : new Date().toISOString();
  return {
    safeSegments,
    transcript,
    segmentationTranscript,
    sourceBase: {
      meetingId,
      project: project
        ? {
            id: (project as Pick<Project, "id">).id,
            name: (project as Pick<Project, "name">).name,
            goal:
              (projectMemory as { goal?: string | null } | null)?.goal ??
              (project as Pick<Project, "goal">).goal,
            memory: {
              summary:
                (projectMemory as { summary?: string | null } | null)?.summary ??
                null,
              current_scope:
                (
                  projectMemory as { current_scope?: unknown } | null
                )?.current_scope ?? [],
              future_scope:
                (
                  projectMemory as { future_scope?: unknown } | null
                )?.future_scope ?? [],
              technical_context:
                (
                  projectMemory as { technical_context?: unknown } | null
                )?.technical_context ?? {},
              constraints: projectConstraints ?? [],
              decisions: projectDecisions ?? [],
              confirmed_fields:
                (
                  projectMemory as { confirmed_fields?: unknown } | null
                )?.confirmed_fields ?? {}
            }
          }
        : null,
      meetingDate,
      transcript: segmentationTranscript,
      transcriptSegmentCount: safeSegments.length
    }
  };
}

/** Pipeline v1 topic_extraction. Pipeline v2 uses lib/meeting-analysis/v2-topic-extraction.ts. */
export async function prepareMeetingAnalysis(
  meetingId: string
): Promise<PreparedMeetingAnalysis> {
  const { safeSegments, transcript, segmentationTranscript, sourceBase } =
    await loadMeetingAnalysisInput(meetingId);
  const buildResult = (
    topics: MeetingTopic[],
    insights: ExtractedInsight[],
    fallbackUsed: boolean,
    contexts: Array<[string, string]> = []
  ) => buildPreparedMeetingAnalysis(sourceBase, topics, insights, fallbackUsed, contexts);

  if (isTranscriptTooShortForTopicAnalysis(safeSegments)) {
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
        segment_ids: existingTopicSegmentIds(topic.segment_ids, segmentMap),
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
    const topicTranscript = buildTopicTranscript(topicDefinition.segment_ids, segmentMap);
    if (topicTranscript === null) continue;

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
