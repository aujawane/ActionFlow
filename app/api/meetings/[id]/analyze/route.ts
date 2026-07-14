import { NextResponse } from "next/server";

import {
  analyzeTranscriptWithOpenAI,
  buildCleanTranscript,
  buildInsightsPayload,
  buildMeetingTasksPayload,
  buildTranscriptWithSegmentIds,
  extractTopicTasksWithOpenAI,
  segmentMeetingTopicsWithOpenAI
} from "@/lib/analysis";
import { categorizeMeetingTasksBestEffort } from "@/lib/task-categorization-batch";
import { requireApiUser } from "@/lib/api-auth";
import { applySpeakerAliases } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingSpeakerAlias, MeetingTask, MeetingTopic, TranscriptSegment } from "@/lib/types";

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
    .select("id")
    .eq("id", id)
    .is("deleted_at", null);
  if (userId) {
    meetingQuery = meetingQuery.eq("user_id", userId);
  }
  const { data: meeting } = await meetingQuery.single();

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

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

  const transcriptWordCount = countTranscriptWords(safeSegments);
  if (safeSegments.length < MIN_ANALYSIS_SEGMENTS || transcriptWordCount < MIN_ANALYSIS_WORDS) {
    console.info("[analyze] Skipping analysis for short transcript", {
      meeting_id: id,
      segment_count: safeSegments.length,
      word_count: transcriptWordCount
    });

    return NextResponse.json({
      skipped: true,
      skip_reason: "Transcript imported, but there is not enough meeting content to analyze yet.",
      segment_count: safeSegments.length,
      word_count: transcriptWordCount,
      topics: [],
      insights: [],
      tasks: []
    });
  }

  const runWholeMeetingFallback = async (reason: string) => {
    console.warn("[analyze] Falling back to whole-meeting analysis:", reason);
    const analysis = await analyzeTranscriptWithOpenAI(transcript);
    if (!analysis.ok) {
      return NextResponse.json(
        {
          error: "Transcript analysis failed",
          details: analysis.details ?? analysis.error
        },
        { status: 502 }
      );
    }

    // Reset to a consistent whole-meeting state. Best-effort topic delete so a
    // missing meeting_topics table does not break the fallback.
    await deleteMeetingTasks(id);
    await supabaseAdmin.from("meeting_topics").delete().eq("meeting_id", id);
    await supabaseAdmin.from("extracted_insights").delete().eq("meeting_id", id);

    const payload = buildInsightsPayload({
      meetingId: id,
      analysis: analysis.data,
      topicId: null
    });
    const { data: inserted, error: insertError } = await insertInsightsRows(payload);

    if (insertError) {
      return NextResponse.json(
        { error: "Failed to save insights", details: insertError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      fallback: true,
      fallback_reason: reason,
      topics: [],
      insights: inserted,
      tasks: []
    });
  };

  const segmentMap = new Map(safeSegments.map((segment) => [segment.id, segment]));
  const segmentationTranscript = buildTranscriptWithSegmentIds(safeSegments);
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

  // Only clear previous data after a successful segmentation, so a failed or empty
  // re-analysis never wipes existing topics/insights.
  const deleteTasksResult = await deleteMeetingTasks(id);
  if (deleteTasksResult.error) {
    return NextResponse.json(
      {
        error: "Failed to reset previous action items",
        details: deleteTasksResult.error.message
      },
      { status: 500 }
    );
  }

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
  const allTopicTaskRows: MeetingTask[] = [];
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

    const taskExtraction = await extractTopicTasksWithOpenAI(topic, topicSegments);
    if (taskExtraction.ok) {
      const taskRows = buildMeetingTasksPayload({
        meetingId: id,
        topicId: topic.id,
        extraction: taskExtraction.data
      });

      const { data: insertedTopicTasks, error: taskInsertError } =
        await insertMeetingTaskRows(taskRows);

      if (!taskInsertError && insertedTopicTasks) {
        allTopicTaskRows.push(...(insertedTopicTasks as MeetingTask[]));
      }
    } else {
      console.warn(
        `[analyze] Task extraction failed for topic ${topic.id}:`,
        taskExtraction.details ?? taskExtraction.error
      );
    }
  }

  let tasksForResponse = allTopicTaskRows;
  if (allTopicTaskRows.length > 0 && process.env.OPENAI_API_KEY) {
    try {
      await categorizeMeetingTasksBestEffort({
        tasks: allTopicTaskRows,
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
    tasks: tasksForResponse
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

  async function deleteMeetingTasks(meetingId: string) {
    const result = await supabaseAdmin
      .from("meeting_tasks")
      .delete()
      .eq("meeting_id", meetingId);

    if (result.error && isMissingRelationError(result.error, "meeting_tasks")) {
      return { error: null };
    }

    return result;
  }

  async function insertMeetingTaskRows(
    rows: Array<{
      meeting_id: string;
      topic_id: string;
      task: string;
      owner: string | null;
      task_type: string;
      priority: string;
      suggested_steps: string[];
      source_quote: string | null;
      confidence: number | null;
      workspace_type: string;
      workspace_summary: string | null;
    }>
  ) {
    if (rows.length === 0) {
      return { data: [], error: null };
    }

    const seen = new Set<string>();
    const dedupedRows = rows.filter((row) => {
      const key = [
        row.meeting_id,
        row.topic_id,
        row.task_type,
        row.task.toLowerCase()
      ].join(":");

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

    const result = await supabaseAdmin
      .from("meeting_tasks")
      .insert(dedupedRows)
      .select("*");

    if (result.error && isMissingRelationError(result.error, "meeting_tasks")) {
      return { data: [], error: null };
    }

    return result;
  }
}
