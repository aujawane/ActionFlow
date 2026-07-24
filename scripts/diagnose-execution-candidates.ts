import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";

import { buildTranscriptWithSegmentIds } from "../lib/analysis";
import {
  getConfiguredOpenAIModel,
  getExecutionIntelligenceTimeoutMs
} from "../lib/env";
import {
  generateChunkedExecutionCandidates,
  generateExecutionCandidates
} from "../lib/execution-intelligence/stages";
import { applySpeakerAliases } from "../lib/speaker-aliases";
import type {
  ExtractedInsight,
  MeetingSpeakerAlias,
  MeetingTopic,
  TranscriptSegment
} from "../lib/types";

loadEnvConfig(process.cwd());

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function topicSegmentIds(topic: MeetingTopic): string[] {
  return Array.isArray(topic.segment_ids)
    ? topic.segment_ids.flatMap((value) =>
        typeof value === "string" ? [value] : []
      )
    : [];
}

async function main() {
  const [meetingId, ...extraArguments] = process.argv.slice(2);
  if (!meetingId || extraArguments.length > 0) {
    throw new Error(
      "Usage: npm run diagnose:execution-candidates -- <staging_meeting_id>"
    );
  }
  if (!UUID_PATTERN.test(meetingId)) {
    throw new Error(`Invalid staging meeting UUID: ${meetingId}`);
  }

  const stagingUrl = requireEnvironment("STAGING_SUPABASE_URL");
  const stagingKey = requireEnvironment("STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const productionUrl = process.env.PRODUCTION_SUPABASE_URL?.trim();
  if (
    productionUrl &&
    productionUrl.replace(/\/+$/, "").toLowerCase() ===
      stagingUrl.replace(/\/+$/, "").toLowerCase()
  ) {
    throw new Error(
      "Staging and production Supabase URLs are identical; diagnostic mode is staging-only."
    );
  }

  const staging = createClient(stagingUrl, stagingKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const [
    meetingResult,
    segmentsResult,
    aliasesResult,
    topicsResult,
    insightsResult
  ] = await Promise.all([
    staging
      .from("meetings")
      .select("id, created_at")
      .eq("id", meetingId)
      .single(),
    staging
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("timestamp", { ascending: true }),
    staging
      .from("meeting_speaker_aliases")
      .select("*")
      .eq("meeting_id", meetingId),
    staging
      .from("meeting_topics")
      .select("id, title, summary, segment_ids")
      .eq("meeting_id", meetingId),
    staging
      .from("extracted_insights")
      .select("topic_id, category, content")
      .eq("meeting_id", meetingId)
  ]);

  const failedRead = [
    ["meeting", meetingResult.error],
    ["transcript segments", segmentsResult.error],
    ["speaker aliases", aliasesResult.error],
    ["topics", topicsResult.error],
    ["insights", insightsResult.error]
  ].find(([, error]) => error);
  if (failedRead) {
    const [label, error] = failedRead;
    throw new Error(
      `Failed to read staging ${label}: ${
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "unknown error"
      }`
    );
  }
  if (!meetingResult.data) {
    throw new Error(`Staging meeting ${meetingId} does not exist.`);
  }

  const segments = applySpeakerAliases(
    (segmentsResult.data ?? []) as TranscriptSegment[],
    (aliasesResult.data ?? []) as MeetingSpeakerAlias[]
  );
  if (segments.length === 0) {
    throw new Error(`Staging meeting ${meetingId} has no transcript segments.`);
  }

  const topics = (topicsResult.data ?? []) as MeetingTopic[];
  const insights = (insightsResult.data ?? []) as ExtractedInsight[];
  const meetingDate =
    meetingResult.data.created_at ?? new Date().toISOString();
  console.info("[execution-intelligence-diagnostic]", {
    event: "configuration",
    staging_url: stagingUrl,
    meeting_id: meetingId,
    model: getConfiguredOpenAIModel(),
    timeout_ms: getExecutionIntelligenceTimeoutMs(),
    full_segment_count: segments.length,
    full_topic_count: topics.length,
    full_insight_count: insights.length
  });

  const cases = [
    { label: "first_20_segments", limit: 20 },
    { label: "first_50_segments", limit: 50 },
    { label: "full_meeting", limit: segments.length }
  ];

  for (const diagnosticCase of cases) {
    const selectedSegments = segments.slice(0, diagnosticCase.limit);
    const selectedIds = new Set(selectedSegments.map((segment) => segment.id));
    const selectedTopics = topics.filter((topic) =>
      topicSegmentIds(topic).some((segmentId) => selectedIds.has(segmentId))
    );
    const selectedTopicIds = new Set(
      selectedTopics.map((topic) => topic.id)
    );
    const isFullMeeting = selectedSegments.length === segments.length;
    const selectedInsights = insights.filter(
      (insight) =>
        selectedTopicIds.has(insight.topic_id ?? "") ||
        (isFullMeeting && insight.topic_id === null)
    );
    const startedAt = Date.now();
    const result = await generateExecutionCandidates({
      meetingId,
      meetingDate,
      transcript: buildTranscriptWithSegmentIds(selectedSegments),
      transcriptSegmentCount: selectedSegments.length,
      topics: selectedTopics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        segment_ids: topic.segment_ids
      })),
      insights: selectedInsights.map((insight) => ({
        topic_id: insight.topic_id,
        category: insight.category,
        content: insight.content
      }))
    });

    console.info("[execution-intelligence-diagnostic]", {
      event: "case_complete",
      case: diagnosticCase.label,
      segment_count: selectedSegments.length,
      topic_count: selectedTopics.length,
      insight_count: selectedInsights.length,
      elapsed_ms: Date.now() - startedAt,
      success: result.ok,
      commitments: result.ok ? result.graph.commitments.length : undefined,
      tasks: result.ok ? result.graph.tasks.length : undefined,
      error: result.ok ? undefined : result.error,
      details: result.ok ? undefined : result.details
    });
  }

  const chunkedStartedAt = Date.now();
  const chunkedResult = await generateChunkedExecutionCandidates({
    meetingId,
    meetingDate,
    transcript: buildTranscriptWithSegmentIds(segments),
    transcriptSegmentCount: segments.length,
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
  });
  console.info("[execution-intelligence-diagnostic]", {
    event: "chunked_full_meeting_complete",
    segment_count: segments.length,
    elapsed_ms: Date.now() - chunkedStartedAt,
    success: chunkedResult.ok,
    commitments: chunkedResult.ok
      ? chunkedResult.graph.commitments.length
      : undefined,
    tasks: chunkedResult.ok ? chunkedResult.graph.tasks.length : undefined,
    error: chunkedResult.ok ? undefined : chunkedResult.error,
    details: chunkedResult.ok ? undefined : chunkedResult.details
  });
}

void main().catch((error) => {
  console.error(
    error instanceof Error
      ? `Candidate diagnostic failed: ${error.message}`
      : "Candidate diagnostic failed."
  );
  process.exitCode = 1;
});
