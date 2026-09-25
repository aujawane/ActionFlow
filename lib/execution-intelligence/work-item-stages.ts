import { getV4StageTimeoutMs } from "@/lib/env";
import {
  COMPLETENESS_RECOVERY_PROMPT,
  GROUPING_PROMPT,
  GROUPING_VERIFICATION_PROMPT,
  LIFECYCLE_RECONCILIATION_PROMPT,
  WORK_ITEM_EXTRACTION_PROMPT
} from "./work-item-prompts";
import {
  runCompletenessRecoveryModel,
  runGroupingModel,
  runGroupingVerificationModel,
  runLifecycleReconciliationModel,
  runWorkItemExtractionModel,
  type CreateStructuredResponse,
  type TokenUsage
} from "./work-item-model";
import { assignDraftGroupRefs } from "./execution-tree";
import { EXECUTION_CHUNK_CONCURRENCY, splitExecutionSourceIntoChunks } from "./chunking";
import { transcriptSourceSegmentIds } from "./conversation-event-identity";
import type {
  EligibleWorkItemView,
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
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

function sumUsage(usages: Array<TokenUsage | null>): TokenUsage | null {
  const present = usages.filter((usage): usage is TokenUsage => usage !== null);
  if (present.length === 0) return null;
  return present.reduce(
    (total, usage) => ({
      input_tokens: (total.input_tokens ?? 0) + (usage.input_tokens ?? 0),
      output_tokens: (total.output_tokens ?? 0) + (usage.output_tokens ?? 0),
      total_tokens: (total.total_tokens ?? 0) + (usage.total_tokens ?? 0)
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  );
}

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
    work_item_role: item.work_item_role,
    source_quote: item.source_quote,
    source_segment_ids: item.source_segment_ids,
    context_turns: neighboringTranscriptTurns(transcript, item.source_segment_ids)
  };
}

export async function extractTopicWorkItems(
  source: ExecutionSourceContext
): Promise<
  | { ok: true; topics: TopicWorkItemExtraction[]; latencyMs: number; usage: TokenUsage | null }
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
    usage: sumUsage(results.map((result) => (result?.ok ? result.usage : null))),
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

/**
 * ===========================================================================
 * Global correction, split into two focused passes (V4 recall/temporal-state hardening,
 * generation-6 staging benchmark follow-up).
 *
 * The single combined "global correction" call used to be asked simultaneously to find missing
 * work, repair acceptance, repair current_scope/future_scope, detect later completion, reconcile
 * duplicate request/acceptance representations, repair owners, and inspect evidence -- all in one
 * model response over the entire transcript. The generation-6 benchmark showed it could satisfy
 * some of these responsibilities while silently skipping others in the same run (e.g. correctly
 * closing out a demo while never even evaluating a different, structurally identical completed
 * action). Splitting into Pass A (completeness recovery, windowed) and Pass B (exhaustive
 * per-ref lifecycle reconciliation) gives each responsibility its own focused call and, for Pass
 * B, a programmatically-enforced coverage guarantee instead of relying on prompt wording alone.
 *
 * Both passes reuse the EXISTING GlobalWorkItemAddition/GlobalWorkItemCorrection schemas and the
 * existing applyGlobalCorrections() merge/grounding logic in v4-pipeline.ts -- nothing downstream
 * of this file (isExecutionEligible onward) changes.
 * ===========================================================================
 */

/** Compact, per-window-independent summary of the ENTIRE existing ledger sent to every
 * completeness-recovery window, so a window never re-proposes something already captured
 * elsewhere in the meeting. Deliberately lean (no full evidence/reasoning fields) to keep each
 * window's prompt compact. */
function buildLedgerSummary(items: WorkItem[]) {
  return items.map((item) => ({
    ref: item.ref,
    title: item.title,
    owner: item.owner,
    classification: item.classification,
    source_quote: item.source_quote
  }));
}

/** Same grounding rule applyGlobalCorrections() already enforces for an addition (non-empty
 * quote, at least one segment ID that actually exists in this transcript) -- applied here too, so
 * an ungrounded completeness-recovery addition never even reaches dedup, let alone persistence.
 * Exported so the rule is independently testable without needing a full pipeline run. */
export function filterGroundedAdditions(
  additions: GlobalWorkItemAddition[],
  validSegments: Set<string>
): GlobalWorkItemAddition[] {
  return additions.filter(
    (addition) =>
      addition.source_quote.trim().length > 0 &&
      addition.source_segment_ids.some((id) => validSegments.has(id))
  );
}

/**
 * Drops a completeness-recovery addition that shares a source segment with either an existing
 * ledger item or an addition already kept earlier in this same pass -- a segment-overlap-based
 * proxy for "this describes the same statement something already covers," which is exactly the
 * situation that can arise both across two overlapping chronological windows and between a window
 * and the ledger it was shown. Order-preserving (first occurrence wins).
 */
export function dedupeCompletenessAdditions(
  existingItems: WorkItem[],
  candidateAdditions: GlobalWorkItemAddition[]
): GlobalWorkItemAddition[] {
  const seenSegments = new Set<string>();
  for (const item of existingItems) {
    for (const id of item.source_segment_ids) seenSegments.add(id);
  }
  const deduped: GlobalWorkItemAddition[] = [];
  for (const addition of candidateAdditions) {
    const overlaps = addition.source_segment_ids.some((id) => seenSegments.has(id));
    if (overlaps) continue;
    deduped.push(addition);
    for (const id of addition.source_segment_ids) seenSegments.add(id);
  }
  return deduped;
}

export type CompletenessRecoveryPassResult =
  | {
      ok: true;
      additions: GlobalWorkItemAddition[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/**
 * PASS A: completeness recovery, run over chronological transcript windows (reusing the same
 * chunker/concurrency the topic-scoped extraction stage already uses -- see chunking.ts -- rather
 * than inventing a second windowing scheme) instead of one whole-transcript call. Every window
 * sees the full existing-ledger summary but only its own slice of transcript, so a sparse,
 * easy-to-miss promise is never competing for attention against five other unrelated
 * responsibilities in one giant prompt. Never repairs an existing item -- additions only.
 */
export async function runCompletenessRecoveryPass(input: {
  source: ExecutionSourceContext;
  workItems: WorkItem[];
  createResponse?: CreateStructuredResponse;
}): Promise<CompletenessRecoveryPassResult> {
  const startedAt = Date.now();
  const chunks = splitExecutionSourceIntoChunks(input.source);
  const ledgerSummary = buildLedgerSummary(input.workItems);

  const results: Array<Awaited<ReturnType<typeof runCompletenessRecoveryModel>> | undefined> =
    new Array(chunks.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const result = await runCompletenessRecoveryModel({
        systemPrompt: COMPLETENESS_RECOVERY_PROMPT,
        timeoutMs: Math.max(getV4StageTimeoutMs("completeness_recovery"), 90_000),
        createResponse: input.createResponse,
        context: {
          meeting_id: input.source.meetingId,
          meeting_date: input.source.meetingDate,
          participants: participantMap(chunk.source.transcript),
          window_index: chunk.index,
          transcript: chunk.source.transcript,
          existing_ledger: ledgerSummary
        }
      });
      results[index] = result;
      if (!result.ok) failed = true;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(EXECUTION_CHUNK_CONCURRENCY, chunks.length) }, () => worker())
  );

  const failure = results.find((result) => result && !result.ok);
  if (failure && !failure.ok) return { ...failure, latencyMs: Date.now() - startedAt };

  const validSegments = new Set(transcriptSourceSegmentIds(input.source.transcript));
  const allAdditions = results.flatMap((result) => (result?.ok ? result.additions : []));
  const grounded = filterGroundedAdditions(allAdditions, validSegments);
  const deduped = dedupeCompletenessAdditions(input.workItems, grounded);

  return {
    ok: true,
    additions: deduped,
    latencyMs: Date.now() - startedAt,
    salvagedItems: results.reduce((sum, result) => sum + (result?.ok ? result.salvagedItems : 0), 0),
    usage: sumUsage(results.map((result) => (result?.ok ? result.usage : null)))
  };
}

/** Statuses/classifications/roles/acceptance/scope combinations worth a lifecycle review --
 * mirrors isExecutionEligible's own vocabulary (execution-tree.ts) plus "request"/"future_scope",
 * since an item that ISN'T YET eligible (still merely requested, or misclassified as future_scope)
 * is exactly the kind of item this pass exists to potentially move into eligibility. Deliberately
 * reuses the repository's real enum values rather than a separately-maintained list. */
const LIFECYCLE_REVIEW_CLASSIFICATIONS = new Set([
  "open_task",
  "assignment",
  "promise",
  "accepted_request",
  "scheduling",
  "in_progress",
  "request"
]);
const LIFECYCLE_REVIEW_ROLES = new Set(["action", "input_dependency"]);
const LIFECYCLE_REVIEW_ACCEPTANCE_STATES = new Set(["accepted", "requested"]);
const LIFECYCLE_REVIEW_SCOPE_STATES = new Set(["current_scope", "future_scope"]);

export function isLifecycleReviewCandidate(item: WorkItem): boolean {
  return (
    item.execution_scope === "project_work" &&
    LIFECYCLE_REVIEW_ROLES.has(item.work_item_role) &&
    LIFECYCLE_REVIEW_CLASSIFICATIONS.has(item.classification) &&
    LIFECYCLE_REVIEW_ACCEPTANCE_STATES.has(item.acceptance_state) &&
    LIFECYCLE_REVIEW_SCOPE_STATES.has(item.scope_state)
  );
}

/** The full current-field view a lifecycle-review candidate is shown as, so the model can either
 * repair a field or echo it back unchanged -- richer than EligibleWorkItemView (grouping's lean
 * view), since this pass must see every field it might need to review or preserve. */
export type LifecycleReviewCandidateView = {
  ref: string;
  classification: WorkItem["classification"];
  status: WorkItem["status"];
  acceptance_state: WorkItem["acceptance_state"];
  execution_scope: WorkItem["execution_scope"];
  scope_state: WorkItem["scope_state"];
  work_item_role: WorkItem["work_item_role"];
  owner: string | null;
  owners: string[];
  source_quote: string;
  source_segment_ids: string[];
};

export function toLifecycleReviewCandidateView(item: WorkItem): LifecycleReviewCandidateView {
  return {
    ref: item.ref,
    classification: item.classification,
    status: item.status,
    acceptance_state: item.acceptance_state,
    execution_scope: item.execution_scope,
    scope_state: item.scope_state,
    work_item_role: item.work_item_role,
    owner: item.owner,
    owners: item.owners,
    source_quote: item.source_quote,
    source_segment_ids: item.source_segment_ids
  };
}

/** Batch size for Pass B's candidate refs. The FULL transcript is sent unchanged with every
 * batch (never windowed -- temporal-completion evidence for an early item can be arbitrarily far
 * later in the meeting, so only the candidate-ref list is batched, not the transcript itself).
 * Kept intentionally small/conservative so a single batch's response stays easy for the model to
 * fully enumerate; typical meetings produce well under this many lifecycle-review candidates. */
export const LIFECYCLE_REVIEW_BATCH_SIZE = 15;

function chunkIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * Exhaustive-coverage enforcement (never trusted on prompt wording alone): only reviews for refs
 * actually requested are kept (a hallucinated extra ref is dropped), only the first review per ref
 * is kept (a duplicated ref in the response can't count twice), and every requested ref not
 * present in the response is reported back as missing rather than silently treated as reviewed.
 */
export function validateLifecycleReviewCoverage(
  requestedRefs: readonly string[],
  reviews: GlobalWorkItemCorrection[]
): { covered: GlobalWorkItemCorrection[]; missingRefs: string[] } {
  const requested = new Set(requestedRefs);
  const seen = new Set<string>();
  const covered: GlobalWorkItemCorrection[] = [];
  for (const review of reviews) {
    if (!requested.has(review.ref) || seen.has(review.ref)) continue;
    seen.add(review.ref);
    covered.push(review);
  }
  return { covered, missingRefs: requestedRefs.filter((ref) => !seen.has(ref)) };
}

async function requestLifecycleReviews(input: {
  source: ExecutionSourceContext;
  itemsByRef: Map<string, WorkItem>;
  refs: readonly string[];
  createResponse?: CreateStructuredResponse;
}) {
  const candidates = input.refs.flatMap((ref) => {
    const item = input.itemsByRef.get(ref);
    return item ? [toLifecycleReviewCandidateView(item)] : [];
  });
  return runLifecycleReconciliationModel({
    systemPrompt: LIFECYCLE_RECONCILIATION_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("lifecycle_reconciliation"), 90_000),
    createResponse: input.createResponse,
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      participants: participantMap(input.source.transcript),
      transcript: input.source.transcript,
      candidates
    }
  });
}

export type LifecycleReconciliationPassResult =
  | {
      ok: true;
      reviews: GlobalWorkItemCorrection[];
      missingRefsAfterRetry: string[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/**
 * PASS B: exhaustive lifecycle reconciliation. Candidate refs (see isLifecycleReviewCandidate) are
 * batched (LIFECYCLE_REVIEW_BATCH_SIZE); the FULL transcript accompanies every batch so temporal-
 * completion reasoning always has complete chronological context regardless of how far apart an
 * item's origin and its completion evidence are. Coverage is checked per batch: any ref the model
 * omits is retried once, scoped to just the missing refs (same full transcript). A ref still
 * missing after that retry is left unreviewed rather than failing the whole meeting -- it simply
 * passes through to isExecutionEligible with whatever state it already had, exactly as if this
 * pass had never run for it at all. This is the "smallest robust" salvage behavior consistent with
 * the rest of this pipeline's failure handling (see e.g. transcript-normalization's per-batch
 * failure handling) -- never silently counted as reviewed, always logged.
 */
export async function runLifecycleReconciliationPass(input: {
  source: ExecutionSourceContext;
  workItems: WorkItem[];
  createResponse?: CreateStructuredResponse;
}): Promise<LifecycleReconciliationPassResult> {
  const startedAt = Date.now();
  const itemsByRef = new Map(input.workItems.map((item) => [item.ref, item]));
  const candidateRefs = input.workItems.filter(isLifecycleReviewCandidate).map((item) => item.ref);

  if (candidateRefs.length === 0) {
    return {
      ok: true,
      reviews: [],
      missingRefsAfterRetry: [],
      latencyMs: Date.now() - startedAt,
      salvagedItems: 0,
      usage: null
    };
  }

  const batches = chunkIntoBatches(candidateRefs, LIFECYCLE_REVIEW_BATCH_SIZE);
  const reviews: GlobalWorkItemCorrection[] = [];
  const missingRefsAfterRetry: string[] = [];
  let salvagedItems = 0;
  const usages: Array<TokenUsage | null> = [];

  for (const batchRefs of batches) {
    const attempt = await requestLifecycleReviews({
      source: input.source,
      itemsByRef,
      refs: batchRefs,
      createResponse: input.createResponse
    });
    if (!attempt.ok) return { ...attempt, latencyMs: Date.now() - startedAt };
    salvagedItems += attempt.salvagedItems;
    usages.push(attempt.usage);

    const { covered, missingRefs } = validateLifecycleReviewCoverage(batchRefs, attempt.reviews);
    reviews.push(...covered);
    if (missingRefs.length === 0) continue;

    console.warn(
      "[execution-intelligence-v4] Lifecycle reconciliation omitted refs; retrying missing refs only",
      { meeting_id: input.source.meetingId, missing_refs: missingRefs }
    );

    const retry = await requestLifecycleReviews({
      source: input.source,
      itemsByRef,
      refs: missingRefs,
      createResponse: input.createResponse
    });
    if (!retry.ok) {
      console.warn(
        "[execution-intelligence-v4] Lifecycle reconciliation retry call failed; leaving refs unreviewed",
        { meeting_id: input.source.meetingId, missing_refs: missingRefs, error: retry.error }
      );
      missingRefsAfterRetry.push(...missingRefs);
      continue;
    }
    salvagedItems += retry.salvagedItems;
    usages.push(retry.usage);

    const retryCoverage = validateLifecycleReviewCoverage(missingRefs, retry.reviews);
    reviews.push(...retryCoverage.covered);
    if (retryCoverage.missingRefs.length > 0) {
      console.warn(
        "[execution-intelligence-v4] Lifecycle reconciliation still omitted refs after retry; leaving them unreviewed",
        { meeting_id: input.source.meetingId, missing_refs: retryCoverage.missingRefs }
      );
      missingRefsAfterRetry.push(...retryCoverage.missingRefs);
    }
  }

  return {
    ok: true,
    reviews,
    missingRefsAfterRetry,
    latencyMs: Date.now() - startedAt,
    salvagedItems,
    usage: sumUsage(usages)
  };
}

export async function runGroupingPass(input: {
  source: ExecutionSourceContext;
  eligibleItems: WorkItem[];
  acceptanceCriteria: WorkItem[];
}): Promise<
  | { ok: true; groups: GroupProposal[]; latencyMs: number; salvagedItems: number; usage: TokenUsage | null }
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
      ),
      acceptance_criteria: input.acceptanceCriteria.map((item) =>
        toEligibleView(item, input.source.transcript)
      )
    }
  });
  if (!result.ok) return result;
  return {
    ok: true,
    groups: assignDraftGroupRefs(result.groups as RawGroupProposal[]),
    latencyMs: result.latencyMs,
    salvagedItems: result.salvagedItems,
    usage: result.usage
  };
}

export async function runGroupingVerificationPass(input: {
  source: ExecutionSourceContext;
  eligibleItems: WorkItem[];
  acceptanceCriteria: WorkItem[];
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
      acceptance_criteria: input.acceptanceCriteria.map((item) =>
        toEligibleView(item, input.source.transcript)
      ),
      proposed_groups: input.draftGroups
    }
  });
}
