import {
  CANDIDATE_GENERATION_PROMPT,
  COMPLETENESS_PROMPT,
  VERIFICATION_PROMPT
} from "./prompts";
import { runExecutionGraphModel, type ModelStageResult } from "./model";
import type { ExecutionGraph } from "./schemas";

export type ExecutionSourceContext = {
  meetingId: string;
  transcript: string;
  topics: Array<{
    id: string;
    title: string;
    summary: string | null;
    segment_ids: unknown;
  }>;
  insights: Array<{
    topic_id: string | null;
    category: string;
    content: string;
  }>;
  meetingDate: string;
};

function sourcePayload(source: ExecutionSourceContext) {
  return {
    meeting_id: source.meetingId,
    meeting_date: source.meetingDate,
    topics: source.topics,
    meeting_summaries: source.insights.filter(
      (insight) => insight.category === "product_summary"
    ),
    insight_next_steps: source.insights.filter(
      (insight) => insight.category === "next_steps"
    ),
    transcript: source.transcript
  };
}

export function generateExecutionCandidates(
  source: ExecutionSourceContext
): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "candidates",
    systemPrompt: CANDIDATE_GENERATION_PROMPT,
    context: sourcePayload(source)
  });
}

export function verifyExecutionGraph(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "verification",
    systemPrompt: VERIFICATION_PROMPT,
    context: {
      ...sourcePayload(input.source),
      candidate_graph: input.graph
    }
  });
}

export function findMissingExecutionWork(input: {
  source: ExecutionSourceContext;
  graph: ExecutionGraph;
}): Promise<ModelStageResult> {
  return runExecutionGraphModel({
    stage: "completeness",
    systemPrompt: COMPLETENESS_PROMPT,
    context: {
      ...sourcePayload(input.source),
      verified_graph: input.graph
    }
  });
}
