import { NextResponse } from "next/server";

import {
  analyzeTranscriptWithOpenAI,
  buildCleanTranscript,
  buildInsightsPayload,
  buildTranscriptWithSegmentIds,
  segmentMeetingTopicsWithOpenAI
} from "@/lib/analysis";
import { runExecutionIntelligence } from "@/lib/execution-intelligence/pipeline";
import { categorizeMeetingTasksBestEffort } from "@/lib/task-categorization-batch";
import { requireApiUser } from "@/lib/api-auth";
import { applySpeakerAliases } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  ExtractedInsight,
  MeetingSpeakerAlias,
  MeetingTask,
  MeetingTopic,
  TranscriptSegment
} from "@/lib/types";

/**
 * Vercel plan assumption: Pro (maxDuration up to 300s).
 * Topic segmentation + per-topic extraction + categorization can exceed 60s.
 * Hobby (10s) is not sufficient for this route.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

const MIN_ANALYSIS_WORDS = 25;
const MIN_ANALYSIS_SEGMENTS = 2;

function isMissingRelationError(
  error: { code?: string; message?: string } | null,
  relation: string
) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return error.message?.toLowerCase().includes(relation.toLowerCase()) ?? false;
}

function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  column: string
) {
  if (!error) return false;
  if (error.code === "42703") return true;
  return error.message?.toLowerCase().includes(column.toLowerCase()) ?? false;
}

function countTranscriptWords(segments: TranscriptSegment[]) {
  return segments.reduce((total, segment) => {
    const words = segment.text.trim().split(/\s+/).filter(Boolean);
    return total + words.length;
  }, 0);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const configuredInternalSecret = process.env.RECALL_WEBHOOK_SECRET?.trim();
  const suppliedInternalSecret = request.headers.get("x-parfait-internal-secret")?.trim();
  const isTrustedInternalRequest =
    Boolean(configuredInternalSecret) && suppliedInternalSecret === configuredInternalSecret;

  let userId: string | null = null;
  if (!isTrustedInternalRequest) {
    const auth = await requireApiUser();
    if (auth.response) return auth.response;
    userId = auth.user.id;
  }

  const { id } = await context.params;

  let meetingQuery = supabaseAdmin
    .from("meetings")
    .select("id, created_at")
    .eq("id", id)
    .is("deleted_at", null);
  if (userId) {
    meetingQuery = meetingQuery.eq("user_id", userId);
  }
  const { data: meeting } = await meetingQuery.single();

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  const meetingCreatedAt = meeting.created_at ?? new Date().toISOString();

  const [
    { data: segments, error: segmentsError },
    { data: aliases, error: aliasesError }
  ] = await Promise.all([
    supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", id)
      .order("timestamp", { ascending: true }),
    supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("*")
      .eq("meeting_id", id)
  ]);

  if (segmentsError) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: segmentsError.message },
      { status: 500 }
    );
  }

  if (aliasesError) {
    return NextResponse.json(
      { error: "Failed to fetch speaker aliases", details: aliasesError.message },
      { status: 500 }
    );
  }

  const safeSegments = applySpeakerAliases(
    (segments ?? []) as TranscriptSegment[],
    (aliases ?? []) as MeetingSpeakerAlias[]
  );
  const transcript = buildCleanTranscript(safeSegments);
  if (!transcript.trim() || safeSegments.length === 0) {
    return NextResponse.json(
      { error: "No transcript available yet" },
      { status: 400 }
    );
  }

  const segmentMap = new Map(safeSegments.map((segment) => [segment.id, segment]));
  const segmentationTranscript = buildTranscriptWithSegmentIds(safeSegments);

  async function executeGraph(input: {
    topics: MeetingTopic[];
    insights: ExtractedInsight[];
    fallbackUsed: boolean;
  }) {
    return runExecutionIntelligence({
      fallbackUsed: input.fallbackUsed,
      source: {
        meetingId: id,
        meetingDate: meetingCreatedAt,
        transcript: segmentationTranscript,
        topics: input.topics.map((topic) => ({
          id: topic.id,
          title: topic.title,
          summary: topic.summary,
          segment_ids: topic.segment_ids
        })),
        insights: input.insights.map((insight) => ({
          topic_id: insight.topic_id,
          category: insight.category,
          content: insight.content
        }))
      }
    });
  }

  const transcriptWordCount = countTranscriptWords(safeSegments);
  if (safeSegments.length < MIN_ANALYSIS_SEGMENTS || transcriptWordCount < MIN_ANALYSIS_WORDS) {
    console.info("[analyze] Running execution-only analysis for short transcript", {
      meeting_id: id,
      segment_count: safeSegments.length,
      word_count: transcriptWordCount
    });

    const execution = await executeGraph({
      topics: [],
      insights: [],
      fallbackUsed: true
    });
    if (!execution.ok) {
      return NextResponse.json(
        {
          error: "Short-transcript execution extraction failed",
          details: execution.error,
          metrics: execution.metrics
        },
        { status: execution.status }
      );
    }
    return NextResponse.json({
      skipped: true,
      skip_reason:
        "Transcript was too short for topic/insight analysis; execution extraction still ran.",
      segment_count: safeSegments.length,
      word_count: transcriptWordCount,
      topics: [],
      insights: [],
      commitments: execution.commitments,
      tasks: execution.tasks,
      execution_metrics: execution.metrics
    });
  }

  const runWholeMeetingFallback = async (reason: string) => {
    console.warn("[analyze] Falling back to whole-meeting analysis:", reason);
    const analysis = await analyzeTranscriptWithOpenAI(transcript);
    if (!analysis.ok) {
      console.warn("[analyze] Fallback insight analysis failed; execution extraction will continue", {
        meeting_id: id,
        error: analysis.error,
        details: analysis.details
      });
    }

    // Reset summaries/topics, but keep the previous execution graph until the
    // new graph has passed verification and can be atomically replaced.
    await supabaseAdmin.from("meeting_topics").delete().eq("meeting_id", id);
    await supabaseAdmin.from("extracted_insights").delete().eq("meeting_id", id);

    let inserted: Array<Record<string, unknown>> = [];
    if (analysis.ok) {
      const payload = buildInsightsPayload({
        meetingId: id,
        analysis: analysis.data,
        topicId: null
      });
      const insertResult = await insertInsightsRows(payload);
      if (insertResult.error) {
        console.warn("[analyze] Fallback insight persistence failed; execution extraction will continue", {
          meeting_id: id,
          error: insertResult.error.message
        });
      } else {
        inserted = insertResult.data ?? [];
      }
    }

    const execution = await executeGraph({
      topics: [],
      insights: inserted as unknown as ExtractedInsight[],
      fallbackUsed: true
    });
    if (!execution.ok) {
      return NextResponse.json(
        {
          error: "Fallback execution extraction failed",
          details: execution.error,
          metrics: execution.metrics
        },
        { status: execution.status }
      );
    }

    return NextResponse.json({
      fallback: true,
      fallback_reason: reason,
      topics: [],
      insights: inserted,
      commitments: execution.commitments,
      tasks: execution.tasks,
      execution_metrics: execution.metrics
    });
  };

  const topicSegmentation = await segmentMeetingTopicsWithOpenAI(segmentationTranscript);

  if (!topicSegmentation.ok || topicSegmentation.data.topics.length === 0) {
    const fallbackReason = !topicSegmentation.ok
      ? topicSegmentation.details ?? topicSegmentation.error
      : "No topics returned by segmentation model";
    return runWholeMeetingFallback(fallbackReason);
  }

  console.info(
    `[analyze] Segmentation produced ${topicSegmentation.data.topics.length} topic(s).`
  );

  // Clear derived summaries/topics only after successful segmentation. The
  // previous execution graph is replaced atomically after all verification.
  const { error: deleteInsightsError } = await supabaseAdmin
    .from("extracted_insights")
    .delete()
    .eq("meeting_id", id);

  if (deleteInsightsError) {
    return NextResponse.json(
      {
        error: "Failed to reset previous insights",
        details: deleteInsightsError.message
      },
      { status: 500 }
    );
  }

  const { error: deleteTopicsError } = await supabaseAdmin
    .from("meeting_topics")
    .delete()
    .eq("meeting_id", id);
  if (deleteTopicsError) {
    if (isMissingRelationError(deleteTopicsError, "meeting_topics")) {
      return runWholeMeetingFallback(
        "meeting_topics table not found; using whole-meeting analysis fallback."
      );
    }
    return NextResponse.json(
      { error: "Failed to reset previous topics", details: deleteTopicsError.message },
      { status: 500 }
    );
  }

  const topicInsertPayload = topicSegmentation.data.topics.map((topic) => ({
    meeting_id: id,
    title: topic.title,
    summary: topic.summary,
    start_timestamp: topic.start_timestamp,
    end_timestamp: topic.end_timestamp,
    segment_ids: topic.segment_ids.filter((segmentId) => segmentMap.has(segmentId)),
    confidence: topic.confidence ?? null,
    separation_reason: topic.separation_reason
  }));

  const { data: insertedTopics, error: insertTopicsError } = await supabaseAdmin
    .from("meeting_topics")
    .insert(topicInsertPayload)
    .select("*");

  if (insertTopicsError || !insertedTopics) {
    return runWholeMeetingFallback(
      insertTopicsError?.message ?? "Failed to insert segmented topics"
    );
  }

  const allTopicInsightRows: Array<Record<string, unknown>> = [];
  const meetingContextByTopicId = new Map<string, string>();

  for (let index = 0; index < insertedTopics.length; index += 1) {
    const topic = insertedTopics[index] as MeetingTopic;
    const topicDef = topicSegmentation.data.topics[index];
    const topicSegments = topicDef.segment_ids
      .map((segmentId) => segmentMap.get(segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));

    if (topicSegments.length === 0) {
      continue;
    }

    const topicTranscript = buildCleanTranscript(topicSegments);
    meetingContextByTopicId.set(topic.id, topicTranscript);
    const topicAnalysis = await analyzeTranscriptWithOpenAI(topicTranscript);
    if (!topicAnalysis.ok) {
      console.warn("[analyze] Topic insight extraction failed; execution extraction will continue", {
        meeting_id: id,
        topic_id: topic.id,
        error: topicAnalysis.error,
        details: topicAnalysis.details
      });
      continue;
    }

    const topicInsightsPayload = buildInsightsPayload({
      meetingId: id,
      topicId: topic.id,
      analysis: topicAnalysis.data
    });

    const { data: insertedTopicInsights, error: topicInsightError } =
      await insertInsightsRows(topicInsightsPayload);

    if (!topicInsightError && insertedTopicInsights) {
      allTopicInsightRows.push(...insertedTopicInsights);
    }
  }

  const execution = await executeGraph({
    topics: insertedTopics as MeetingTopic[],
    insights: allTopicInsightRows as unknown as ExtractedInsight[],
    fallbackUsed: false
  });
  if (!execution.ok) {
    return NextResponse.json(
      {
        error: "Execution graph extraction failed",
        details: execution.error,
        metrics: execution.metrics
      },
      { status: execution.status }
    );
  }

  let tasksForResponse = execution.tasks;
  if (tasksForResponse.length > 0 && process.env.OPENAI_API_KEY) {
    try {
      await categorizeMeetingTasksBestEffort({
        tasks: tasksForResponse,
        meetingContextByTopicId
      });
      const { data: refreshedTasks } = await supabaseAdmin
        .from("meeting_tasks")
        .select("*")
        .eq("meeting_id", id);
      if (refreshedTasks) {
        tasksForResponse = refreshedTasks as MeetingTask[];
      }
    } catch (error) {
      console.warn("[analyze] Task categorization failed:", error);
    }
  }

  return NextResponse.json({
    fallback: false,
    topics: insertedTopics,
    insights: allTopicInsightRows,
    commitments: execution.commitments,
    tasks: tasksForResponse,
    execution_metrics: execution.metrics
  });

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

    if (!firstAttempt.error) {
      return firstAttempt;
    }

    if (isMissingColumnError(firstAttempt.error, "topic_id")) {
      const legacyRows = rows.map((row) => ({
        meeting_id: row.meeting_id,
        category: row.category,
        content: row.content,
        confidence: row.confidence
      }));
      return supabaseAdmin.from("extracted_insights").insert(legacyRows).select("*");
    }

    return firstAttempt;
  }

}
