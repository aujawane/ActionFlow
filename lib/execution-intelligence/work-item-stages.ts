import { getV4StageTimeoutMs } from "@/lib/env";
import {
  GLOBAL_WORK_ITEM_CORRECTION_PROMPT,
  GROUPING_PROMPT,
  GROUPING_VERIFICATION_PROMPT,
  WORK_ITEM_EXTRACTION_PROMPT
} from "./work-item-prompts";
import {
  runGlobalCorrectionModel,
  runGroupingModel,
  runGroupingVerificationModel,
  runWorkItemExtractionModel
} from "./work-item-model";
import { assignDraftGroupRefs } from "./execution-tree";
import type {
  EligibleWorkItemView,
  GroupProposal,
  RawGroupProposal,
  RawWorkItem,
  WorkItem
} from "./work-item-schemas";
import type { TopicWorkItemExtraction } from "./work-item-merge";
import {
  participantMap,
  transcriptForSegmentIds,
  type ExecutionSourceContext
} from "./stages";

const SEGMENT_LINE = /^\[([0-9a-f-]{36})\]/i;

/** One or two neighboring transcript turns around a work item's own evidence, for grouping
 * context only -- never the full transcript, so proximity to unrelated conversation can't leak
 * into a clustering decision. */
export function neighboringTranscriptTurns(
  transcript: string,
  segmentIds: string[],
  radius = 1
): string[] {
  const lines = transcript.split("\n");
  const idSet = new Set(segmentIds);
  const indices = new Set<number>();
  lines.forEach((line, index) => {
    const id = line.match(SEGMENT_LINE)?.[1];
    if (id && idSet.has(id)) {
      for (let offset = -radius; offset <= radius; offset += 1) {
        const neighborIndex = index + offset;
        if (neighborIndex >= 0 && neighborIndex < lines.length) indices.add(neighborIndex);
      }
    }
  });
  return Array.from(indices)
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter((line) => line.trim().length > 0);
}

function toEligibleView(item: WorkItem, transcript: string): EligibleWorkItemView {
  return {
    ref: item.ref,
    title: item.title,
    description: item.description,
    owner: item.owner,
    status: item.status,
    source_quote: item.source_quote,
    source_segment_ids: item.source_segment_ids,
    context_turns: neighboringTranscriptTurns(transcript, item.source_segment_ids)
  };
}

export async function extractTopicWorkItems(
  source: ExecutionSourceContext
): Promise<
  | { ok: true; topics: TopicWorkItemExtraction[]; latencyMs: number }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean }
> {
  const startedAt = Date.now();
  const scopes = source.topics.length > 0
    ? source.topics.map((topic) => {
        const ids = new Set(
          Array.isArray(topic.segment_ids)
            ? topic.segment_ids.filter((id): id is string => typeof id === "string")
            : []
        );
        return {
          topicId: topic.id,
          topicTitle: topic.title,
          topicSummary: topic.summary,
          transcript: transcriptForSegmentIds(source.transcript, ids)
        };
      }).filter((topic) => topic.transcript.trim())
    : [{
        topicId: null,
        topicTitle: "Whole meeting",
        topicSummary: null,
        transcript: source.transcript
      }];

  const results: Array<Awaited<ReturnType<typeof runWorkItemExtractionModel>> | undefined> =
    new Array(scopes.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= scopes.length) return;
      const scope = scopes[index];
      const result = await runWorkItemExtractionModel({
        systemPrompt: WORK_ITEM_EXTRACTION_PROMPT,
        context: {
          meeting_id: source.meetingId,
          meeting_date: source.meetingDate,
          project: source.project ?? null,
          topic: { id: scope.topicId, title: scope.topicTitle, summary: scope.topicSummary },
          conversation_events: source.conversationEvents ?? [],
          transcript: scope.transcript
        }
      });
      results[index] = result;
      if (!result.ok) failed = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, scopes.length) }, () => worker()));
  const failure = results.find((result) => result && !result.ok);
  if (failure && !failure.ok) return { ...failure, latencyMs: Date.now() - startedAt };
  if (results.some((result) => !result)) {
    return {
      ok: false,
      error: "Work-item extraction stopped before every topic completed.",
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    };
  }
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    topics: scopes.map((scope, index) => {
      const result = results[index]!;
      if (!result.ok) throw new Error("Unexpected failed work-item extraction result.");
      return {
        topicId: scope.topicId,
        topicTitle: scope.topicTitle,
        transcript: scope.transcript,
        items: result.items as RawWorkItem[]
      };
    })
  };
}

/** The one global, meeting-wide work-item correction/completeness pass (Phase B). Work items
 * only -- it never proposes groups or commitments. */
export async function runGlobalCorrectionPass(input: {
  source: ExecutionSourceContext;
  workItems: WorkItem[];
}) {
  return runGlobalCorrectionModel({
    systemPrompt: GLOBAL_WORK_ITEM_CORRECTION_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("global_correction"), 90_000),
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      participants: participantMap(input.source.transcript),
      transcript: input.source.transcript,
      work_items: input.workItems
    }
  });
}

export async function runGroupingPass(input: {
  source: ExecutionSourceContext;
  eligibleItems: WorkItem[];
}): Promise<
  | { ok: true; groups: GroupProposal[]; latencyMs: number; salvagedItems: number }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean }
> {
  const result = await runGroupingModel({
    systemPrompt: GROUPING_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("grouping"), 90_000),
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      participants: participantMap(input.source.transcript),
      eligible_work_items: input.eligibleItems.map((item) =>
        toEligibleView(item, input.source.transcript)
      )
    }
  });
  if (!result.ok) return result;
  return {
    ok: true,
    groups: assignDraftGroupRefs(result.groups as RawGroupProposal[]),
    latencyMs: result.latencyMs,
    salvagedItems: result.salvagedItems
  };
}

export async function runGroupingVerificationPass(input: {
  source: ExecutionSourceContext;
  eligibleItems: WorkItem[];
  draftGroups: GroupProposal[];
}) {
  return runGroupingVerificationModel({
    systemPrompt: GROUPING_VERIFICATION_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("grouping_verification"), 90_000),
    context: {
      meeting_id: input.source.meetingId,
      eligible_work_items: input.eligibleItems.map((item) =>
        toEligibleView(item, input.source.transcript)
      ),
      proposed_groups: input.draftGroups
    }
  });
}
