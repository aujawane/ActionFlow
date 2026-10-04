import { getV4StageTimeoutMs } from "@/lib/env";
import {
  ATOMIC_ACTION_HARVEST_PROMPT,
  COMPLETENESS_ADJUDICATION_PROMPT,
  COMPLETION_VERIFICATION_PROMPT,
  GROUPING_PROMPT,
  GROUPING_VERIFICATION_PROMPT,
  LIFECYCLE_RECONCILIATION_PROMPT,
  WORK_ITEM_EXTRACTION_PROMPT
} from "./work-item-prompts";
import {
  runAtomicActionHarvestModel,
  runCompletenessAdjudicationModel,
  runCompletionVerificationModel,
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
  AtomicActionHarvestCandidate,
  CompletenessAdjudicationDecision,
  EligibleWorkItemView,
  GlobalWorkItemAddition,
  GlobalWorkItemCorrection,
  GroupProposal,
  RawGroupProposal,
  RawWorkItem,
  WorkItem
} from "./work-item-schemas";
import type { TopicWorkItemExtraction } from "./work-item-merge";
import { isNearDuplicateWorkItem } from "./work-item-merge";
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
 * Completeness recovery, split into two focused internal steps (missed-voluntary-promise recall
 * follow-up, generation-11 staging benchmark).
 *
 * The single windowed completeness call used to both enumerate what the transcript said AND decide
 * whether it was already known, in one response, over one window at a time, WITH ledger visibility.
 * The generation-11 benchmark showed this conflated two different questions: "what actions does
 * this turn express" and "is any of that already covered" -- when a compound turn's more prominent
 * outcome happened to look already-covered (or was simply the one the model picked to represent
 * the turn), a smaller or secondary outcome sharing the same turn was silently never enumerated at
 * all, with no separate mechanism able to catch what was never proposed in the first place.
 *
 * PASS A (ATOMIC ACTION HARVEST, see runAtomicActionHarvestPass) is windowed exactly as before, but
 * is deliberately LEDGER-BLIND and high-recall: its only question is "what concrete actions/outcomes
 * does this window express," never "is this already known." PASS B (MISSING-WORK ADJUDICATION, see
 * runCompletenessAdjudicationPass) receives the harvested candidates directly (never re-derives them
 * from the transcript), plus full ledger visibility and the full transcript, and is the only place
 * that decides whether a candidate is genuinely absent, active work -- and if so, assigns its final
 * WorkItem-shaped fields. Exhaustive per-candidate coverage is programmatically enforced the same
 * way lifecycle reconciliation's coverage already is, with the same targeted-retry-then-leave-
 * unresolved salvage behavior. A final semantic same-outcome dedup layer (reusing
 * isNearDuplicateWorkItem, already used by the initial extraction-merge stage for the identical
 * "same real-world outcome, not same topic" judgment) catches same-outcome candidates that cite
 * different transcript segments, which the original segment-set-based dedup structurally cannot.
 *
 * Both original single-pass architecture's outputs -- GlobalWorkItemAddition/GlobalWorkItemCorrection
 * schemas and applyGlobalCorrections()'s merge/grounding logic in v4-pipeline.ts -- are unchanged and
 * still what this two-step internal refactor ultimately produces; nothing downstream of this file
 * (isExecutionEligible onward), and no other pass (lifecycle candidate selection, lifecycle
 * reconciliation, completion safety), is affected.
 * ===========================================================================
 */

/** Compact, per-window-independent summary of the ENTIRE existing ledger sent to every
 * missing-work-adjudication batch, so adjudication never proposes "add" for something already
 * captured elsewhere in the meeting. Deliberately lean (no full evidence/reasoning fields) to keep
 * each batch's prompt compact. (Atomic action harvest deliberately does NOT see this -- see the
 * module header comment.) */
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

/** Same rule, applied to Pass A's raw harvest candidates before they are ever shown to Pass B --
 * an ungrounded candidate never reaches adjudication, exactly as an ungrounded addition never
 * reached dedup under the old single-pass design. */
export function filterGroundedHarvestCandidates(
  candidates: AtomicActionHarvestCandidate[],
  validSegments: Set<string>
): AtomicActionHarvestCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.source_quote.trim().length > 0 &&
      candidate.source_segment_ids.some((id) => validSegments.has(id))
  );
}

export type HarvestGroundingRejectionReason = "empty_quote" | "invalid_segment_ids" | "both";

/** Read-only mirror of filterGroundedHarvestCandidates's own predicate, used ONLY to explain (for
 * diagnostics) why a candidate that predicate already rejected was rejected -- never changes what
 * gets rejected, since it is never called by filterGroundedHarvestCandidates itself. */
function classifyHarvestGroundingRejection(
  candidate: AtomicActionHarvestCandidate,
  validSegments: Set<string>
): HarvestGroundingRejectionReason {
  const emptyQuote = candidate.source_quote.trim().length === 0;
  const noValidSegment = !candidate.source_segment_ids.some((id) => validSegments.has(id));
  if (emptyQuote && noValidSegment) return "both";
  return emptyQuote ? "empty_quote" : "invalid_segment_ids";
}

function normalizeQuoteForDedup(quote: string): string {
  return quote.trim().toLowerCase().replace(/\s+/g, " ");
}

function segmentSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

export type CompletenessDedupRemoval = {
  title: string;
  matchedTitle: string;
};

export type CompletenessDedupResult = {
  kept: GlobalWorkItemAddition[];
  removed: CompletenessDedupRemoval[];
};

/**
 * LAYER 1 (cheap, deterministic, exact-match): drops a completeness addition only when it
 * represents the SAME real-world outcome as something already seen (an existing ledger item, or an
 * addition already kept earlier in this same pass) -- not merely the same transcript segment, turn,
 * or topic. A compound turn can legitimately produce two distinct additions that cite the exact same
 * segment ID (see ACTION-LEVEL ATOMICITY in ATOMIC_ACTION_HARVEST_PROMPT -- e.g. "I'll finish X and
 * then confirm Y works" is one segment, two outcomes); segment-ID overlap alone is therefore not a
 * safe duplicate signal by itself. A candidate is only treated as a duplicate here when its FULL
 * segment set exactly matches something already seen AND its quote is the same statement (equal, or
 * one fully contains the other, after normalization). This layer cannot catch a same-outcome
 * candidate citing a DIFFERENT segment (e.g. the same real commitment mentioned in two different
 * turns) -- see semanticDedupeCompletenessAdditions (LAYER 2) for that. Order-preserving (first
 * occurrence wins).
 */
export function dedupeCompletenessAdditions(
  existingItems: WorkItem[],
  candidateAdditions: GlobalWorkItemAddition[]
): CompletenessDedupResult {
  const seen: Array<{ title: string; segmentIds: readonly string[]; normalizedQuote: string }> =
    existingItems.map((item) => ({
      title: item.title,
      segmentIds: item.source_segment_ids,
      normalizedQuote: normalizeQuoteForDedup(item.source_quote)
    }));
  const kept: GlobalWorkItemAddition[] = [];
  const removed: CompletenessDedupRemoval[] = [];
  for (const addition of candidateAdditions) {
    const candidateQuote = normalizeQuoteForDedup(addition.source_quote);
    const match = seen.find(
      (entry) =>
        segmentSetsEqual(entry.segmentIds, addition.source_segment_ids) &&
        (entry.normalizedQuote === candidateQuote ||
          entry.normalizedQuote.includes(candidateQuote) ||
          candidateQuote.includes(entry.normalizedQuote))
    );
    if (match) {
      removed.push({ title: addition.title, matchedTitle: match.title });
      continue;
    }
    kept.push(addition);
    seen.push({ title: addition.title, segmentIds: addition.source_segment_ids, normalizedQuote: candidateQuote });
  }
  return { kept, removed };
}

/** Adapts a WorkItem/GlobalWorkItemAddition (both already RawWorkItem-shaped) to the ScopedWorkItem
 * shape isNearDuplicateWorkItem expects. topic_id is never inspected by that function's own logic
 * (confirmed by reading its body) -- it exists only to satisfy the shared type, so `null` is always
 * safe here regardless of which real topic (if any) the item came from. */
function toScopedForSemanticDedup(item: RawWorkItem): RawWorkItem & { topic_id: string | null } {
  return { ...item, topic_id: null };
}

/**
 * LAYER 2 (semantic, reused primitive): catches a same-real-world-outcome duplicate that cites a
 * DIFFERENT transcript segment than the item it duplicates -- structurally invisible to LAYER 1's
 * segment-set-equality check, and exactly the shape of the generation-11 "wi_g7/wi_g8" leak (same
 * "connect agent to phone" commitment, two different turns/segments, both survived because their
 * segment sets never matched). Reuses isNearDuplicateWorkItem verbatim from work-item-merge.ts --
 * the SAME "same classification and status, and (near-identical title OR (shared evidence AND
 * moderately similar title))" judgment already used to merge topic-scoped extraction's own
 * duplicates -- rather than inventing a second, parallel semantic-duplicate heuristic. Deliberately
 * does NOT weaken LAYER 1: this runs only on LAYER 1's survivors, as a second, independent pass.
 */
export function semanticDedupeCompletenessAdditions(
  existingItems: WorkItem[],
  candidateAdditions: GlobalWorkItemAddition[]
): CompletenessDedupResult {
  const seen: Array<{ title: string; scoped: RawWorkItem & { topic_id: string | null } }> = existingItems.map(
    (item) => ({ title: item.title, scoped: toScopedForSemanticDedup(item) })
  );
  const kept: GlobalWorkItemAddition[] = [];
  const removed: CompletenessDedupRemoval[] = [];
  for (const addition of candidateAdditions) {
    const scoped = toScopedForSemanticDedup(addition);
    const match = seen.find((entry) => isNearDuplicateWorkItem(entry.scoped, scoped));
    if (match) {
      removed.push({ title: addition.title, matchedTitle: match.title });
      continue;
    }
    kept.push(addition);
    seen.push({ title: addition.title, scoped });
  }
  return { kept, removed };
}

// ---------------------------------------------------------------------------
// PASS A: ATOMIC ACTION HARVEST
// ---------------------------------------------------------------------------

export type HarvestedCandidate = AtomicActionHarvestCandidate & { canonicalRef: string; windowIndex: number };

export type CompletenessHarvestWindowCount = { windowIndex: number; harvested: number };

/** Generous safety cap for Pass-A/Pass-B diagnostic trace retention (generation-12 forensic-audit
 * follow-up: the raw Pass-A candidate list was never persisted, which is exactly why a future
 * benchmark could not distinguish a Pass-A enumeration miss from a Pass-B rewrite without inference).
 * Real meetings produce tens of candidates, not thousands -- this exists purely as a runaway-input
 * safety valve for the checkpoint payload, not a practical limit. If ever hit, the itemized trace is
 * truncated but candidate/decision COUNTS remain fully accurate regardless (they come from the
 * existing, untruncated aggregate metrics, e.g. candidatesHarvested/candidatesExpectedForAdjudication
 * -- only the per-candidate diagnostic detail below this cap is capped), and the truncation itself is
 * recorded (see traceTruncated on each pass result) rather than silently dropped. */
export const PASS_A_TRACE_MAX_ENTRIES = 2000;

/** Bounded, per-candidate diagnostic record of what Pass A itself harvested -- window, candidate_id
 * (the application-assigned canonicalRef, stable and joinable to Pass B's trace), owner/owners,
 * outcome, and grounding evidence. Deliberately excludes harvest_reason: this is structured,
 * observable output only, not a store of the model's reasoning/chain-of-thought. */
export type PassAHarvestTraceEntry = {
  windowIndex: number;
  candidateId: string;
  owner: string | null;
  owners: string[];
  outcome: string;
  sourceSegmentIds: string[];
  sourceQuote: string;
};

/** Bounded diagnostic record of a harvest candidate Pass A proposed that grounding then rejected --
 * identified by the model's own window-local candidate_id (never a canonicalRef, since a rejected
 * candidate is never assigned one -- see runAtomicActionHarvestPass). */
export type PassAGroundingRejectionTraceEntry = {
  windowIndex: number;
  candidateId: string;
  sourceSegmentIds: string[];
  rejectionReason: HarvestGroundingRejectionReason;
};

export type AtomicActionHarvestPassResult =
  | {
      ok: true;
      candidates: HarvestedCandidate[];
      harvestedByWindow: CompletenessHarvestWindowCount[];
      groundingRejected: number;
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
      /** Diagnostic-only (see PASS_A_TRACE_MAX_ENTRIES); never used by any downstream decision. */
      harvestTrace: PassAHarvestTraceEntry[];
      groundingRejectionTrace: PassAGroundingRejectionTraceEntry[];
      traceTruncated: boolean;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/**
 * PASS A: atomic action harvest, run over the SAME chronological transcript windows completeness
 * recovery has always used (reusing the same chunker/concurrency the topic-scoped extraction stage
 * also uses -- see chunking.ts -- rather than inventing a second windowing scheme). Ledger-blind and
 * deliberately high-recall (see ATOMIC_ACTION_HARVEST_PROMPT) -- never decides what is already known,
 * only enumerates. Candidate identity (canonicalRef) is always assigned here by application code,
 * never trusted from the model's own window-local candidate_id, so candidates from different windows
 * can be safely pooled together for Pass B without ID collisions.
 */
export async function runAtomicActionHarvestPass(input: {
  source: ExecutionSourceContext;
  createResponse?: CreateStructuredResponse;
}): Promise<AtomicActionHarvestPassResult> {
  const startedAt = Date.now();
  const chunks = splitExecutionSourceIntoChunks(input.source);

  const results: Array<Awaited<ReturnType<typeof runAtomicActionHarvestModel>> | undefined> =
    new Array(chunks.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const result = await runAtomicActionHarvestModel({
        systemPrompt: ATOMIC_ACTION_HARVEST_PROMPT,
        timeoutMs: Math.max(getV4StageTimeoutMs("atomic_action_harvest"), 90_000),
        createResponse: input.createResponse,
        context: {
          meeting_id: input.source.meetingId,
          meeting_date: input.source.meetingDate,
          participants: participantMap(chunk.source.transcript),
          window_index: chunk.index,
          transcript: chunk.source.transcript
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
  const harvestedByWindow: CompletenessHarvestWindowCount[] = [];
  const allCandidates: HarvestedCandidate[] = [];
  const harvestTrace: PassAHarvestTraceEntry[] = [];
  const groundingRejectionTrace: PassAGroundingRejectionTraceEntry[] = [];
  let groundingRejected = 0;
  let traceTruncated = false;

  results.forEach((result, index) => {
    const windowIndex = chunks[index].index;
    if (!result?.ok) {
      harvestedByWindow.push({ windowIndex, harvested: 0 });
      return;
    }
    harvestedByWindow.push({ windowIndex, harvested: result.candidates.length });
    const grounded = filterGroundedHarvestCandidates(result.candidates, validSegments);
    groundingRejected += result.candidates.length - grounded.length;
    const groundedIds = new Set(grounded.map((candidate) => candidate.candidate_id));
    for (const candidate of result.candidates) {
      if (groundedIds.has(candidate.candidate_id)) continue;
      if (groundingRejectionTrace.length >= PASS_A_TRACE_MAX_ENTRIES) {
        traceTruncated = true;
        continue;
      }
      groundingRejectionTrace.push({
        windowIndex,
        candidateId: candidate.candidate_id,
        sourceSegmentIds: candidate.source_segment_ids,
        rejectionReason: classifyHarvestGroundingRejection(candidate, validSegments)
      });
    }
    grounded.forEach((candidate, candidateIndex) => {
      const canonicalRef = `hc_w${windowIndex}_${candidateIndex + 1}`;
      allCandidates.push({ ...candidate, canonicalRef, windowIndex });
      if (harvestTrace.length >= PASS_A_TRACE_MAX_ENTRIES) {
        traceTruncated = true;
        return;
      }
      harvestTrace.push({
        windowIndex,
        candidateId: canonicalRef,
        owner: candidate.owner,
        owners: candidate.owners,
        outcome: candidate.outcome,
        sourceSegmentIds: candidate.source_segment_ids,
        sourceQuote: candidate.source_quote
      });
    });
  });

  return {
    ok: true,
    candidates: allCandidates,
    harvestedByWindow,
    groundingRejected,
    latencyMs: Date.now() - startedAt,
    salvagedItems: results.reduce((sum, result) => sum + (result?.ok ? result.salvagedItems : 0), 0),
    usage: sumUsage(results.map((result) => (result?.ok ? result.usage : null))),
    harvestTrace,
    groundingRejectionTrace,
    traceTruncated
  };
}

// ---------------------------------------------------------------------------
// PASS B: MISSING-WORK ADJUDICATION
// ---------------------------------------------------------------------------

/** Batch size for Pass B's harvested candidates -- mirrors LIFECYCLE_REVIEW_BATCH_SIZE exactly
 * (same rationale: small/conservative so a single batch's response stays easy for the model to
 * fully enumerate). The FULL transcript accompanies every batch regardless of which window(s) its
 * candidates came from, so adjudication always has complete chronological context. */
export const COMPLETENESS_ADJUDICATION_BATCH_SIZE = 15;

// chunkIntoBatches is defined once, later in this file, and reused here (see the lifecycle
// reconciliation section) -- declarations in this module are hoisted, so the forward reference
// below is safe.

/**
 * Exhaustive-coverage enforcement for Pass B, mirroring validateLifecycleReviewCoverage's exact
 * logic (never trusted on prompt wording alone): only decisions for candidate_ids actually
 * requested are kept, only the first decision per candidate_id is kept, and every requested
 * candidate_id not present in the response is reported back as missing rather than silently
 * treated as adjudicated. A new, parallel function rather than generalizing/reusing
 * validateLifecycleReviewCoverage directly, since that function lives in the lifecycle
 * reconciliation section of this file, which this task must not modify.
 */
export function validateCompletenessAdjudicationCoverage(
  requestedCandidateRefs: readonly string[],
  decisions: CompletenessAdjudicationDecision[]
): { covered: CompletenessAdjudicationDecision[]; missingCandidateRefs: string[] } {
  const requested = new Set(requestedCandidateRefs);
  const seen = new Set<string>();
  const covered: CompletenessAdjudicationDecision[] = [];
  for (const decision of decisions) {
    if (!requested.has(decision.candidate_id) || seen.has(decision.candidate_id)) continue;
    seen.add(decision.candidate_id);
    covered.push(decision);
  }
  return {
    covered,
    missingCandidateRefs: requestedCandidateRefs.filter((ref) => !seen.has(ref))
  };
}

export type CompletenessAdjudicationCounts = {
  completenessDecisionAdd: number;
  completenessDecisionAlreadyRepresented: number;
  completenessDecisionSpeculativeOrInactive: number;
  completenessDecisionRetrospectiveOrCompleted: number;
  completenessDecisionNonExecution: number;
  completenessDecisionInsufficientGrounding: number;
};

/** Bounded, per-decision diagnostic record (see PASS_A_TRACE_MAX_ENTRIES) -- candidate_id joins
 * directly back to a PassAHarvestTraceEntry.candidateId, and (for disposition="add") forward to the
 * resulting WorkItem ref once runCompletenessRecoveryPass's orchestration resolves it (Pass B itself
 * never assigns a final ref -- see additionCandidateIds on CompletenessRecoveryPassResult). `reason`
 * is the same concise field the decision schema already requires and Pass B already returns -- not
 * new reasoning storage, just retention of what the model was already asked to state. */
export type PassBAdjudicationTraceEntry = {
  candidateId: string;
  disposition: CompletenessAdjudicationDecision["disposition"];
  reason: string;
};

export type CompletenessAdjudicationPassResult =
  | ({
      ok: true;
      additions: GlobalWorkItemAddition[];
      candidatesExpected: number;
      decisionsReceived: number;
      missingCandidateRefsAfterRetry: string[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
      adjudicationTrace: PassBAdjudicationTraceEntry[];
      traceTruncated: boolean;
    } & CompletenessAdjudicationCounts)
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

async function requestCompletenessAdjudication(input: {
  source: ExecutionSourceContext;
  candidatesByRef: Map<string, HarvestedCandidate>;
  ledgerSummary: ReturnType<typeof buildLedgerSummary>;
  refs: readonly string[];
  createResponse?: CreateStructuredResponse;
}) {
  const candidates = input.refs.flatMap((ref) => {
    const candidate = input.candidatesByRef.get(ref);
    if (!candidate) return [];
    return [
      {
        candidate_id: candidate.canonicalRef,
        owner: candidate.owner,
        owners: candidate.owners,
        outcome: candidate.outcome,
        source_quote: candidate.source_quote,
        source_segment_ids: candidate.source_segment_ids
      }
    ];
  });
  return runCompletenessAdjudicationModel({
    systemPrompt: COMPLETENESS_ADJUDICATION_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("completeness_adjudication"), 90_000),
    createResponse: input.createResponse,
    context: {
      meeting_id: input.source.meetingId,
      meeting_date: input.source.meetingDate,
      project: input.source.project ?? null,
      participants: participantMap(input.source.transcript),
      transcript: input.source.transcript,
      existing_ledger: input.ledgerSummary,
      candidates
    }
  });
}

/**
 * PASS B: missing-work adjudication. Harvested candidates (see runAtomicActionHarvestPass) are
 * batched (COMPLETENESS_ADJUDICATION_BATCH_SIZE); the FULL transcript and existing ledger
 * accompany every batch regardless of which window(s) the candidates in it came from. Coverage is
 * checked per batch: any candidate_id the model omits is retried once, scoped to just the missing
 * candidate_ids (same full transcript/ledger). A candidate_id still missing after that retry is
 * left unadjudicated rather than failing the whole meeting -- it is simply never added (never
 * silently treated as "already_represented" or any other disposition), exactly mirroring lifecycle
 * reconciliation's own "leave unreviewed rather than silently counted" salvage philosophy.
 */
export async function runCompletenessAdjudicationPass(input: {
  source: ExecutionSourceContext;
  existingWorkItems: WorkItem[];
  candidates: HarvestedCandidate[];
  createResponse?: CreateStructuredResponse;
}): Promise<CompletenessAdjudicationPassResult> {
  const startedAt = Date.now();
  const candidatesByRef = new Map(input.candidates.map((candidate) => [candidate.canonicalRef, candidate]));
  const requestedRefs = input.candidates.map((candidate) => candidate.canonicalRef);
  const counts: CompletenessAdjudicationCounts = {
    completenessDecisionAdd: 0,
    completenessDecisionAlreadyRepresented: 0,
    completenessDecisionSpeculativeOrInactive: 0,
    completenessDecisionRetrospectiveOrCompleted: 0,
    completenessDecisionNonExecution: 0,
    completenessDecisionInsufficientGrounding: 0
  };

  if (requestedRefs.length === 0) {
    return {
      ok: true,
      additions: [],
      candidatesExpected: 0,
      decisionsReceived: 0,
      missingCandidateRefsAfterRetry: [],
      latencyMs: Date.now() - startedAt,
      salvagedItems: 0,
      usage: null,
      adjudicationTrace: [],
      traceTruncated: false,
      ...counts
    };
  }

  const ledgerSummary = buildLedgerSummary(input.existingWorkItems);
  const batches = chunkIntoBatches(requestedRefs, COMPLETENESS_ADJUDICATION_BATCH_SIZE);
  const decisions: CompletenessAdjudicationDecision[] = [];
  const missingCandidateRefsAfterRetry: string[] = [];
  let salvagedItems = 0;
  const usages: Array<TokenUsage | null> = [];

  for (const batchRefs of batches) {
    const attempt = await requestCompletenessAdjudication({
      source: input.source,
      candidatesByRef,
      ledgerSummary,
      refs: batchRefs,
      createResponse: input.createResponse
    });
    if (!attempt.ok) return { ...attempt, latencyMs: Date.now() - startedAt };
    salvagedItems += attempt.salvagedItems;
    usages.push(attempt.usage);

    const { covered, missingCandidateRefs } = validateCompletenessAdjudicationCoverage(batchRefs, attempt.decisions);
    decisions.push(...covered);
    if (missingCandidateRefs.length === 0) continue;

    console.warn(
      "[execution-intelligence-v4] Completeness adjudication omitted candidates; retrying missing candidates only",
      { meeting_id: input.source.meetingId, missing_candidate_refs: missingCandidateRefs }
    );

    const retry = await requestCompletenessAdjudication({
      source: input.source,
      candidatesByRef,
      ledgerSummary,
      refs: missingCandidateRefs,
      createResponse: input.createResponse
    });
    if (!retry.ok) {
      console.warn(
        "[execution-intelligence-v4] Completeness adjudication retry call failed; leaving candidates unadjudicated",
        { meeting_id: input.source.meetingId, missing_candidate_refs: missingCandidateRefs, error: retry.error }
      );
      missingCandidateRefsAfterRetry.push(...missingCandidateRefs);
      continue;
    }
    salvagedItems += retry.salvagedItems;
    usages.push(retry.usage);

    const retryCoverage = validateCompletenessAdjudicationCoverage(missingCandidateRefs, retry.decisions);
    decisions.push(...retryCoverage.covered);
    if (retryCoverage.missingCandidateRefs.length > 0) {
      console.warn(
        "[execution-intelligence-v4] Completeness adjudication still omitted candidates after retry; leaving them unadjudicated",
        { meeting_id: input.source.meetingId, missing_candidate_refs: retryCoverage.missingCandidateRefs }
      );
      missingCandidateRefsAfterRetry.push(...retryCoverage.missingCandidateRefs);
    }
  }

  const additions: GlobalWorkItemAddition[] = [];
  for (const decision of decisions) {
    switch (decision.disposition) {
      case "add":
        counts.completenessDecisionAdd += 1;
        // Malformed fallback (C3): "add" without a schema-valid addition payload is never silently
        // treated as any other disposition -- it simply contributes nothing, exactly like a
        // candidate that was never adjudicated at all.
        if (decision.addition) additions.push(decision.addition);
        break;
      case "already_represented":
        counts.completenessDecisionAlreadyRepresented += 1;
        break;
      case "speculative_or_inactive":
        counts.completenessDecisionSpeculativeOrInactive += 1;
        break;
      case "retrospective_or_completed":
        counts.completenessDecisionRetrospectiveOrCompleted += 1;
        break;
      case "non_execution":
        counts.completenessDecisionNonExecution += 1;
        break;
      case "insufficient_grounding":
        counts.completenessDecisionInsufficientGrounding += 1;
        break;
    }
  }

  let traceTruncated = false;
  const adjudicationTrace: PassBAdjudicationTraceEntry[] = [];
  for (const decision of decisions) {
    if (adjudicationTrace.length >= PASS_A_TRACE_MAX_ENTRIES) {
      traceTruncated = true;
      break;
    }
    adjudicationTrace.push({
      candidateId: decision.candidate_id,
      disposition: decision.disposition,
      reason: decision.reason
    });
  }

  return {
    ok: true,
    additions,
    candidatesExpected: requestedRefs.length,
    decisionsReceived: decisions.length,
    missingCandidateRefsAfterRetry,
    latencyMs: Date.now() - startedAt,
    salvagedItems,
    usage: sumUsage(usages),
    adjudicationTrace,
    traceTruncated,
    ...counts
  };
}

// ---------------------------------------------------------------------------
// Orchestration: harvest -> adjudicate -> ground -> dedup (layer 1, layer 2)
// ---------------------------------------------------------------------------

export type CompletenessWindowProposalCount = { windowIndex: number; proposed: number };
export type CompletenessAcceptedAddition = { windowIndex: number | null; title: string };

export type CompletenessRecoveryPassResult =
  | {
      ok: true;
      additions: GlobalWorkItemAddition[];
      /** Preserved name/shape for backward compatibility with existing consumers (v4-pipeline.ts):
       * now populated from Pass A's harvest counts per window rather than a single combined call's
       * proposal count -- still "how many candidates did this window produce," just one step
       * earlier in the new two-step pipeline. */
      proposedByWindow: CompletenessWindowProposalCount[];
      /** Final accepted additions (post harvest, adjudication, grounding, and both dedup layers)
       * paired with the window that originally harvested them -- observability only. */
      acceptedByWindow: CompletenessAcceptedAddition[];
      /** Additions dropped by EITHER dedup layer (deterministic exact-match, then semantic
       * same-outcome) -- observability only. See duplicatesRemovedDeterministic/
       * duplicatesRemovedSemantic for the breakdown by layer. */
      duplicatesRemoved: CompletenessDedupRemoval[];
      duplicatesRemovedDeterministic: CompletenessDedupRemoval[];
      duplicatesRemovedSemantic: CompletenessDedupRemoval[];
      groundedCount: number;
      /** New (Pass A) harvest-level diagnostics. */
      candidatesHarvested: number;
      candidatesGroundingRejected: number;
      /** New (Pass B) adjudication-level diagnostics. */
      candidatesExpectedForAdjudication: number;
      decisionsReceived: number;
      missingCandidateRefsAfterRetry: string[];
      adjudicationCounts: CompletenessAdjudicationCounts;
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
      /** Diagnostic-only (generation-12 forensic-audit follow-up): Pass A's own per-candidate
       * output, grounding rejections, and Pass B's per-candidate decisions, all joinable purely by
       * candidate_id -- see PassAHarvestTraceEntry/PassAGroundingRejectionTraceEntry/
       * PassBAdjudicationTraceEntry. `additionCandidateIds[i]` is the candidate_id that produced
       * `additions[i]` (parallel arrays, same order dedup already preserves), which callers can join
       * against applyGlobalCorrections's own `wi_g${i + 1}` ref-assignment convention to resolve
       * "Pass A candidate -> grounding -> Pass B decision -> resulting WorkItem" without inference. */
      harvestTrace: PassAHarvestTraceEntry[];
      groundingRejectionTrace: PassAGroundingRejectionTraceEntry[];
      adjudicationTrace: PassBAdjudicationTraceEntry[];
      additionCandidateIds: Array<string | null>;
      traceTruncated: boolean;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/**
 * Completeness recovery's external entry point -- unchanged name and call shape
 * (source/workItems/createResponse in, the same ok/additions/latencyMs/salvagedItems/usage/
 * groundedCount/proposedByWindow/acceptedByWindow/duplicatesRemoved fields out) so v4-pipeline.ts
 * needs no changes at all. Internally now orchestrates PASS A (harvest) then PASS B (adjudicate)
 * then two dedup layers, instead of one combined windowed call. `createResponse` continues to mean
 * "Pass A's (harvest) model responses"; a new, optional `createAdjudicationResponse` controls Pass
 * B's (adjudication) model responses -- mirroring the createResponse/createVerificationResponse
 * dual-DI pattern already used by runLifecycleReconciliationPass.
 */
export async function runCompletenessRecoveryPass(input: {
  source: ExecutionSourceContext;
  workItems: WorkItem[];
  createResponse?: CreateStructuredResponse;
  createAdjudicationResponse?: CreateStructuredResponse;
}): Promise<CompletenessRecoveryPassResult> {
  const startedAt = Date.now();

  const harvest = await runAtomicActionHarvestPass({
    source: input.source,
    createResponse: input.createResponse
  });
  if (!harvest.ok) return { ...harvest, latencyMs: Date.now() - startedAt };

  const proposedByWindow: CompletenessWindowProposalCount[] = harvest.harvestedByWindow.map((w) => ({
    windowIndex: w.windowIndex,
    proposed: w.harvested
  }));

  const adjudication = await runCompletenessAdjudicationPass({
    source: input.source,
    existingWorkItems: input.workItems,
    candidates: harvest.candidates,
    createResponse: input.createAdjudicationResponse
  });
  if (!adjudication.ok) {
    return { ...adjudication, latencyMs: Date.now() - startedAt };
  }

  const windowByCanonicalRef = new Map(harvest.candidates.map((c) => [c.canonicalRef, c.windowIndex]));
  const additionWindow = new Map<GlobalWorkItemAddition, number | null>();
  const additionCandidateId = new Map<GlobalWorkItemAddition, string>();
  // Re-associate each "add" addition with its originating window AND candidate_id by matching
  // evidence back to the harvested candidate it came from (additions don't carry the candidate ref
  // themselves). The candidate_id side of this same match is what makes the Pass-A/Pass-B trace
  // joinable end to end (see additionCandidateIds below).
  for (const candidate of harvest.candidates) {
    const match = adjudication.additions.find(
      (addition) =>
        addition.source_quote.trim() === candidate.source_quote.trim() &&
        segmentSetsEqual(addition.source_segment_ids, candidate.source_segment_ids)
    );
    if (match && !additionWindow.has(match)) {
      additionWindow.set(match, windowByCanonicalRef.get(candidate.canonicalRef) ?? null);
      additionCandidateId.set(match, candidate.canonicalRef);
    }
  }

  const validSegments = new Set(transcriptSourceSegmentIds(input.source.transcript));
  const grounded = filterGroundedAdditions(adjudication.additions, validSegments);

  const deterministic = dedupeCompletenessAdditions(input.workItems, grounded);
  const semantic = semanticDedupeCompletenessAdditions(input.workItems, deterministic.kept);

  const acceptedByWindow: CompletenessAcceptedAddition[] = semantic.kept.map((addition) => ({
    windowIndex: additionWindow.get(addition) ?? null,
    title: addition.title
  }));
  const additionCandidateIds: Array<string | null> = semantic.kept.map(
    (addition) => additionCandidateId.get(addition) ?? null
  );

  return {
    ok: true,
    additions: semantic.kept,
    proposedByWindow,
    acceptedByWindow,
    duplicatesRemoved: [...deterministic.removed, ...semantic.removed],
    duplicatesRemovedDeterministic: deterministic.removed,
    duplicatesRemovedSemantic: semantic.removed,
    groundedCount: grounded.length,
    candidatesHarvested: harvest.candidates.length,
    candidatesGroundingRejected: harvest.groundingRejected,
    candidatesExpectedForAdjudication: adjudication.candidatesExpected,
    decisionsReceived: adjudication.decisionsReceived,
    missingCandidateRefsAfterRetry: adjudication.missingCandidateRefsAfterRetry,
    adjudicationCounts: {
      completenessDecisionAdd: adjudication.completenessDecisionAdd,
      completenessDecisionAlreadyRepresented: adjudication.completenessDecisionAlreadyRepresented,
      completenessDecisionSpeculativeOrInactive: adjudication.completenessDecisionSpeculativeOrInactive,
      completenessDecisionRetrospectiveOrCompleted: adjudication.completenessDecisionRetrospectiveOrCompleted,
      completenessDecisionNonExecution: adjudication.completenessDecisionNonExecution,
      completenessDecisionInsufficientGrounding: adjudication.completenessDecisionInsufficientGrounding
    },
    latencyMs: Date.now() - startedAt,
    salvagedItems: harvest.salvagedItems + adjudication.salvagedItems,
    usage: sumUsage([harvest.usage, adjudication.usage]),
    harvestTrace: harvest.harvestTrace,
    groundingRejectionTrace: harvest.groundingRejectionTrace,
    adjudicationTrace: adjudication.adjudicationTrace,
    additionCandidateIds,
    traceTruncated: harvest.traceTruncated || adjudication.traceTruncated
  };
}

/**
 * Statuses/classifications/roles/acceptance/scope/execution_scope combinations worth a lifecycle
 * review (generation-9 recall-benchmark follow-up: candidate selection previously assumed these
 * same fields were already correct, but they are EXACTLY the fields lifecycle reconciliation exists
 * to repair -- a bad initial classification therefore permanently excluded an item from the one
 * pass that could have fixed it. GT1 ("proposal"/"proposed") and GT4 ("proposal"/"proposed"/
 * "personal_logistics"/"idea") were both real, grounded, self-committed statements that never
 * became lifecycle candidates for exactly this reason.
 *
 * Each set below is deliberately widened just enough to admit a plausible MISCLASSIFICATION of a
 * grounded, owned, action-bearing item -- not widened to "everything." Values that are excluded
 * here are excluded because they are structurally non-actionable even when correctly assigned:
 * classification=completed_work/decision/idea/question/blocker/reminder never represents an open
 * action a candidate review should reopen; work_item_role=acceptance_criterion/scope_decision/
 * reference/question/status_update are never themselves a step someone performs, independent of
 * whether the rest of the item was classified correctly; acceptance_state=none means acceptance
 * genuinely does not apply (completed work, a bare question); execution_scope=informational means
 * no future action is attached at all. Grounding (source_quote/source_segment_ids) is required
 * defensively even though the extraction/addition schemas already enforce it upstream.
 */
const LIFECYCLE_REVIEW_CLASSIFICATIONS = new Set([
  "open_task",
  "assignment",
  "promise",
  "accepted_request",
  "scheduling",
  "in_progress",
  "request",
  "proposal"
]);
/** future_feature/idea/incidental_troubleshooting admitted because a real accepted action can be
 * mistagged as any of these three at extraction time (a genuine commitment described in tentative
 * language reads as "idea"; a real, consequential fix reads as "incidental_troubleshooting"; a
 * feature already being built now can still be filed as "future_feature"). Structurally non-action
 * roles (acceptance_criterion, scope_decision, reference, question, status_update) stay excluded --
 * no repair to those specific roles turns them into a task lifecycle should track. */
const LIFECYCLE_REVIEW_ROLES = new Set(["action", "input_dependency", "idea", "future_feature", "incidental_troubleshooting"]);
const LIFECYCLE_REVIEW_ACCEPTANCE_STATES = new Set(["accepted", "requested", "proposed"]);
const LIFECYCLE_REVIEW_SCOPE_STATES = new Set(["current_scope", "future_scope"]);
/** personal_logistics admitted because a personal-tool action performed to accomplish or enable
 * project work ("I'll restart Chrome so we can test the app," "I'll take a screenshot of the UI for
 * the review," "I can try that with my agent") is real project execution, not logistics, even
 * though extraction sometimes classifies it by the tool/actor rather than the purpose. informational
 * stays excluded -- a pure status update or fact has no future action attached regardless of how
 * this field gets repaired. */
const LIFECYCLE_REVIEW_EXECUTION_SCOPES = new Set(["project_work", "personal_logistics"]);

export function isLifecycleReviewCandidate(item: WorkItem): boolean {
  return (
    LIFECYCLE_REVIEW_EXECUTION_SCOPES.has(item.execution_scope) &&
    LIFECYCLE_REVIEW_ROLES.has(item.work_item_role) &&
    LIFECYCLE_REVIEW_CLASSIFICATIONS.has(item.classification) &&
    LIFECYCLE_REVIEW_ACCEPTANCE_STATES.has(item.acceptance_state) &&
    LIFECYCLE_REVIEW_SCOPE_STATES.has(item.scope_state) &&
    item.source_quote.trim().length > 0 &&
    item.source_segment_ids.length > 0
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

/**
 * ===========================================================================
 * Temporal-completion precision (generation-8 staging benchmark follow-up).
 *
 * Generation 8 showed the lifecycle model can mark a genuinely still-open item completed on the
 * basis of unrelated later discussion (a demo of the same product, "ongoing discussion") -- the
 * broad lifecycle-reconciliation judgment alone is not a high-precision enough signal to actually
 * flip status=completed/classification=completed_work. This section adds a programmatic gate (no
 * completion without non-empty, meeting-valid, strictly-later evidence) plus a narrow, separate
 * targeted verifier call for exactly that one semantic question, fully isolated to this pass --
 * applyGlobalCorrections and everything downstream of it is untouched.
 * ===========================================================================
 */

/** Chronological position of every segment ID in this transcript, by order of first appearance --
 * the transcript is already speaker-turn-ordered, so this is a correct, dependency-free proxy for
 * "when did this happen" without needing a separate persisted ordering field. */
export function buildTranscriptPositionIndex(transcript: string): Map<string, number> {
  const index = new Map<string, number>();
  transcriptSourceSegmentIds(transcript).forEach((id, position) => {
    if (!index.has(id)) index.set(id, position);
  });
  return index;
}

/** A review "proposes completion" if it sets EITHER field that would remove the item from
 * isExecutionEligible's ELIGIBLE_STATUSES/ELIGIBLE_CLASSIFICATIONS via completion -- checking both
 * independently (not just the well-formed pairing) is exactly what closes the generation-8 gap,
 * where status flipped to "completed" while classification stayed "promise". */
export function isCompletionDecision(correction: GlobalWorkItemCorrection): boolean {
  return correction.status === "completed" || correction.classification === "completed_work";
}

export type CompletionEvidenceRejectionReason = "missing_evidence" | "invalid_segment" | "chronology";

/**
 * Programmatic gate a completion decision must pass before it is even eligible for the targeted
 * verifier call: non-empty completion_segment_ids, every one of them a real segment ID in this
 * meeting's transcript, and every one of them strictly later than the LATEST segment already
 * backing this item's own existing evidence. Never trusted on prompt wording alone -- this runs
 * regardless of what the model claims in completion_reason.
 */
export function validateCompletionEvidence(input: {
  originalItem: WorkItem;
  correction: GlobalWorkItemCorrection;
  transcriptPositionIndex: Map<string, number>;
}): { ok: true } | { ok: false; reason: CompletionEvidenceRejectionReason } {
  const { originalItem, correction, transcriptPositionIndex } = input;
  if (correction.completion_segment_ids.length === 0) {
    return { ok: false, reason: "missing_evidence" };
  }
  const completionPositions = correction.completion_segment_ids.map((id) => transcriptPositionIndex.get(id));
  if (completionPositions.some((position) => position === undefined)) {
    return { ok: false, reason: "invalid_segment" };
  }
  const originPositions = originalItem.source_segment_ids.map((id) => transcriptPositionIndex.get(id));
  if (originPositions.length === 0 || originPositions.some((position) => position === undefined)) {
    // Cannot safely establish when this item's own commitment/acceptance evidence occurred.
    return { ok: false, reason: "chronology" };
  }
  const originPosition = Math.max(...(originPositions as number[]));
  const earliestCompletionPosition = Math.min(...(completionPositions as number[]));
  if (!(earliestCompletionPosition > originPosition)) {
    return { ok: false, reason: "chronology" };
  }
  return { ok: true };
}

/**
 * Fail-closed rewrite: when a completion decision is rejected (by the evidence gate or the
 * targeted verifier), the ref's status/classification/acceptance_state revert to whatever they
 * were BEFORE this lifecycle pass ran -- not whatever else the model proposed alongside the
 * rejected completion -- so a malformed completion attempt can never leave the item stranded in an
 * inconsistent state (e.g. acceptance_state=none with a non-completed status). Every other field
 * the model proposed (owner, scope_state, superseding/duplicate fields, evidence quote) is left
 * untouched, since this gate is scoped to completion safety only, not a general veto.
 */
export function revertCompletionFields(
  correction: GlobalWorkItemCorrection,
  originalItem: WorkItem,
  reason: string
): GlobalWorkItemCorrection {
  return {
    ...correction,
    status: originalItem.status,
    classification: originalItem.classification,
    acceptance_state: originalItem.acceptance_state,
    completion_segment_ids: [],
    completion_reason: null,
    reconciliation_reason: reason
  };
}

const COMPLETION_VERIFICATION_CONCURRENCY = 2;

async function runTargetedCompletionVerification(input: {
  source: ExecutionSourceContext;
  originalItem: WorkItem;
  correction: GlobalWorkItemCorrection;
  createResponse?: CreateStructuredResponse;
}) {
  const contextTurns = neighboringTranscriptTurns(
    input.source.transcript,
    [...input.originalItem.source_segment_ids, ...input.correction.completion_segment_ids],
    1
  );
  return runCompletionVerificationModel({
    systemPrompt: COMPLETION_VERIFICATION_PROMPT,
    timeoutMs: Math.max(getV4StageTimeoutMs("completion_verification"), 60_000),
    createResponse: input.createResponse,
    context: {
      meeting_id: input.source.meetingId,
      work_item: {
        ref: input.originalItem.ref,
        title: input.originalItem.title,
        owner: input.originalItem.owner,
        classification: input.originalItem.classification
      },
      originating_evidence: {
        source_quote: input.originalItem.source_quote,
        source_segment_ids: input.originalItem.source_segment_ids
      },
      proposed_completion_evidence: {
        completion_reason: input.correction.completion_reason,
        completion_segment_ids: input.correction.completion_segment_ids
      },
      context_turns: contextTurns
    }
  });
}

export type CompletionSafetyCounts = {
  completionProposals: number;
  completionVerified: number;
  completionRejectedMissingEvidence: number;
  completionRejectedChronology: number;
  completionRejectedVerifier: number;
};

/**
 * Applies the temporal-completion precision gate to a batch of already-covered lifecycle reviews.
 * Every review that isn't a completion decision passes through unchanged. Every review that IS a
 * completion decision must pass the programmatic evidence/chronology gate (no model call) and then
 * the targeted verifier (one focused model call) before the completion is allowed to stand; failing
 * either reverts that ref's completion fields via revertCompletionFields, keeping the item exactly
 * as it was before this pass ran. A verifier call failure (timeout, malformed response) is treated
 * as non-confirmation, not a pipeline failure -- ambiguous/malformed/missing always means "keep the
 * item open," never "propagate an error."
 */
async function applyCompletionSafety(input: {
  source: ExecutionSourceContext;
  reviews: GlobalWorkItemCorrection[];
  itemsByRef: Map<string, WorkItem>;
  createVerificationResponse?: CreateStructuredResponse;
}): Promise<{ reviews: GlobalWorkItemCorrection[]; counts: CompletionSafetyCounts; usages: Array<TokenUsage | null> }> {
  const transcriptPositionIndex = buildTranscriptPositionIndex(input.source.transcript);
  const passthrough: GlobalWorkItemCorrection[] = [];
  const structurallyRejected: GlobalWorkItemCorrection[] = [];
  const structurallyValid: GlobalWorkItemCorrection[] = [];
  const counts: CompletionSafetyCounts = {
    completionProposals: 0,
    completionVerified: 0,
    completionRejectedMissingEvidence: 0,
    completionRejectedChronology: 0,
    completionRejectedVerifier: 0
  };

  for (const review of input.reviews) {
    if (!isCompletionDecision(review)) {
      passthrough.push(review);
      continue;
    }
    counts.completionProposals += 1;
    const originalItem = input.itemsByRef.get(review.ref);
    if (!originalItem) {
      // Defensive only -- coverage validation already restricts reviews to known candidate refs.
      passthrough.push(review);
      continue;
    }
    const evidenceCheck = validateCompletionEvidence({ originalItem, correction: review, transcriptPositionIndex });
    if (!evidenceCheck.ok) {
      if (evidenceCheck.reason === "missing_evidence") counts.completionRejectedMissingEvidence += 1;
      else counts.completionRejectedChronology += 1;
      structurallyRejected.push(
        revertCompletionFields(
          review,
          originalItem,
          `Lifecycle proposed completion (${review.classification}/${review.status}) but completion evidence failed programmatic validation (${evidenceCheck.reason}); kept at its prior state.`
        )
      );
      continue;
    }
    structurallyValid.push(review);
  }

  const usages: Array<TokenUsage | null> = [];
  const verifiedResults: GlobalWorkItemCorrection[] = new Array(structurallyValid.length);
  let next = 0;
  async function verifierWorker() {
    while (next < structurallyValid.length) {
      const index = next++;
      const review = structurallyValid[index];
      const originalItem = input.itemsByRef.get(review.ref)!;
      const verification = await runTargetedCompletionVerification({
        source: input.source,
        originalItem,
        correction: review,
        createResponse: input.createVerificationResponse
      });
      if (verification.ok) {
        usages.push(verification.usage);
        if (verification.confirmed) {
          counts.completionVerified += 1;
          verifiedResults[index] = review;
          continue;
        }
        counts.completionRejectedVerifier += 1;
        verifiedResults[index] = revertCompletionFields(
          review,
          originalItem,
          `Targeted completion verifier did not confirm this action was actually performed: ${verification.reasoning}`
        );
      } else {
        counts.completionRejectedVerifier += 1;
        verifiedResults[index] = revertCompletionFields(
          review,
          originalItem,
          `Targeted completion verifier call failed (${verification.error}); kept at its prior state rather than trusting the unverified completion.`
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(COMPLETION_VERIFICATION_CONCURRENCY, structurallyValid.length) }, () =>
      verifierWorker()
    )
  );

  return {
    reviews: [...passthrough, ...structurallyRejected, ...verifiedResults],
    counts,
    usages
  };
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

export type LifecycleCandidateObservability = {
  lifecycleCandidatesConsidered: number;
  lifecycleCandidatesAdmittedViaProposal: number;
  lifecycleCandidatesAdmittedViaFutureScope: number;
  lifecycleCandidatesAdmittedViaPersonalLogistics: number;
  lifecycleCandidatesAdmittedViaProposedAcceptance: number;
  lifecycleRepairedExecutionScope: number;
  lifecycleRepairedAcceptanceState: number;
  lifecycleRepairedScopeState: number;
};

/**
 * Diagnostic counts for the widened candidate-selection rule (generation-9 recall-benchmark
 * follow-up): how many candidates were admitted only because of the broadened fields, and how many
 * of those fields lifecycle actually went on to repair. Pure and independently testable so the
 * broadening's effect can be benchmarked without needing to inspect the persisted debug trace.
 * "Admitted via X" counts the candidate's PRE-review value; "repaired X" counts reviews whose
 * POST-review value differs from the candidate's pre-review value, for any candidate (not only the
 * ones admitted via that specific field) -- both are population-level signals about this pass, not
 * a claim that a specific admission caused a specific repair.
 */
export function computeLifecycleCandidateObservability(
  candidates: WorkItem[],
  reviews: GlobalWorkItemCorrection[]
): LifecycleCandidateObservability {
  const reviewsByRef = new Map(reviews.map((review) => [review.ref, review]));
  const result: LifecycleCandidateObservability = {
    lifecycleCandidatesConsidered: candidates.length,
    lifecycleCandidatesAdmittedViaProposal: 0,
    lifecycleCandidatesAdmittedViaFutureScope: 0,
    lifecycleCandidatesAdmittedViaPersonalLogistics: 0,
    lifecycleCandidatesAdmittedViaProposedAcceptance: 0,
    lifecycleRepairedExecutionScope: 0,
    lifecycleRepairedAcceptanceState: 0,
    lifecycleRepairedScopeState: 0
  };
  for (const candidate of candidates) {
    if (candidate.classification === "proposal") result.lifecycleCandidatesAdmittedViaProposal += 1;
    if (candidate.scope_state === "future_scope") result.lifecycleCandidatesAdmittedViaFutureScope += 1;
    if (candidate.execution_scope === "personal_logistics") {
      result.lifecycleCandidatesAdmittedViaPersonalLogistics += 1;
    }
    if (candidate.acceptance_state === "proposed") {
      result.lifecycleCandidatesAdmittedViaProposedAcceptance += 1;
    }
    const review = reviewsByRef.get(candidate.ref);
    if (!review) continue;
    if (review.execution_scope !== candidate.execution_scope) result.lifecycleRepairedExecutionScope += 1;
    if (review.acceptance_state !== candidate.acceptance_state) result.lifecycleRepairedAcceptanceState += 1;
    if (review.scope_state !== candidate.scope_state) result.lifecycleRepairedScopeState += 1;
  }
  return result;
}

export type LifecycleReconciliationPassResult =
  | ({
      ok: true;
      reviews: GlobalWorkItemCorrection[];
      missingRefsAfterRetry: string[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    } & CompletionSafetyCounts &
      LifecycleCandidateObservability)
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
  createVerificationResponse?: CreateStructuredResponse;
}): Promise<LifecycleReconciliationPassResult> {
  const startedAt = Date.now();
  const itemsByRef = new Map(input.workItems.map((item) => [item.ref, item]));
  const candidates = input.workItems.filter(isLifecycleReviewCandidate);
  const candidateRefs = candidates.map((item) => item.ref);

  if (candidateRefs.length === 0) {
    return {
      ok: true,
      reviews: [],
      missingRefsAfterRetry: [],
      latencyMs: Date.now() - startedAt,
      salvagedItems: 0,
      usage: null,
      completionProposals: 0,
      completionVerified: 0,
      completionRejectedMissingEvidence: 0,
      completionRejectedChronology: 0,
      completionRejectedVerifier: 0,
      ...computeLifecycleCandidateObservability([], [])
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

  const candidateObservability = computeLifecycleCandidateObservability(candidates, reviews);

  const completionSafety = await applyCompletionSafety({
    source: input.source,
    reviews,
    itemsByRef,
    createVerificationResponse: input.createVerificationResponse
  });
  usages.push(...completionSafety.usages);

  return {
    ok: true,
    reviews: completionSafety.reviews,
    missingRefsAfterRetry,
    latencyMs: Date.now() - startedAt,
    salvagedItems,
    usage: sumUsage(usages),
    ...completionSafety.counts,
    ...candidateObservability
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
