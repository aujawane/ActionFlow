import { z } from "zod";

import { openai } from "@/lib/openai";
import { getConfiguredOpenAIModel } from "@/lib/env";

/**
 * The structured semantic judge -- Layer 3 of the hybrid matching architecture (see
 * hybrid-matcher.ts). Deliberately isolated from lib/execution-intelligence/work-item-model.ts's
 * V4Stage-coupled `requestStructuredJson` (which is wired to the extraction pipeline's own
 * per-stage model/timeout env configuration) -- this is evaluation tooling only, never touches
 * `lib/env.ts`'s V4Stage machinery, and must never be mistaken for a Pass-A/Pass-B/extraction call.
 *
 * BATCHED CALL SHAPE (retrieval-hardening follow-up): the first hybrid-matching pass called the
 * judge once PER CANDIDATE, which combined with overly-broad retrieval produced 109 live calls (84
 * of which hit real connection failures) for a single 9-item meeting. The judge now receives ONE
 * call per GT (sub-)outcome with its whole ranked shortlist (see hybrid-matcher.ts's
 * rankCandidates/shortlistCandidates), and returns one decision per candidate_ref in a single
 * structured response -- bounding both the call count and the token cost per call.
 *
 * ONLY QUESTION THIS JUDGE ANSWERS, per candidate: "Do frozen GT outcome X and grounded pipeline
 * item Y represent the same real-world execution outcome?" It never sees or can modify ground truth
 * (it receives a read-only text/owner/segment snapshot, never a reference to the fixture object
 * itself), never proposes a replacement GT or a new candidate, never scores 0-100, and never
 * comments on whether the extraction system is good. Its structured verdict is advisory input to
 * the evaluator, not an authoritative final result -- see hybrid-matcher.ts for how "ambiguous" is
 * kept visible as `needs_review` rather than silently resolved either way.
 */

export const SEMANTIC_MATCH_VALUES = ["same", "partial", "different", "ambiguous"] as const;
export type SemanticMatchValue = (typeof SEMANTIC_MATCH_VALUES)[number];

export const SEMANTIC_EVIDENCE_ALIGNMENT_VALUES = ["strong", "weak", "none"] as const;
export type SemanticEvidenceAlignment = (typeof SEMANTIC_EVIDENCE_ALIGNMENT_VALUES)[number];

export const semanticAdjudicationResultSchema = z
  .object({
    match: z.enum(SEMANTIC_MATCH_VALUES),
    owner_match: z.boolean(),
    evidence_alignment: z.enum(SEMANTIC_EVIDENCE_ALIGNMENT_VALUES),
    concise_reason: z.string().min(1)
  })
  .strict();
export type SemanticAdjudicationResult = z.infer<typeof semanticAdjudicationResultSchema>;

/** Fail-safe default: any malformed/missing/errored judge response resolves to "ambiguous" (i.e.
 * needs_review) rather than being silently treated as "same" or "different" -- mirrors the
 * fail-closed philosophy already established for completion-safety/adjudication coverage elsewhere
 * in this codebase (never let a parsing failure masquerade as a confident answer). */
export function failSafeAdjudicationResult(reason: string): SemanticAdjudicationResult {
  return {
    match: "ambiguous",
    owner_match: false,
    evidence_alignment: "none",
    concise_reason: `Judge response could not be used (${reason}); failing safe to ambiguous/needs_review.`
  };
}

// ---------------------------------------------------------------------------
// Batch request/response shape
// ---------------------------------------------------------------------------

export type RetrievalFeatureSummary = {
  segmentOverlap: boolean;
  passLinkage: boolean;
  textSimilarity: number;
  ownerOverlap: boolean;
};

export type SemanticBatchCandidate = {
  candidateRef: string;
  title: string;
  owner: string | null;
  sourceQuote: string | null;
  sourceSegmentIds: string[];
  /** Deterministic retrieval features that produced this candidate's rank -- given to the judge as
   * read-only context (never as an instruction on how to decide), and echoed back in the trace so
   * "why was this candidate even shown to the judge" is always answerable. */
  retrievalFeatures: RetrievalFeatureSummary;
};

export type SemanticBatchAdjudicationRequest = {
  groundTruth: {
    /** The specific (sub-)outcome text being adjudicated -- either a GT item's whole
     * `semantic_outcome`, or one entry of its `compound_outcomes`. */
    outcomeText: string;
    isSubOutcome: boolean;
    owners: string[];
    /** Real transcript text for the GT's own declared evidence segments, when known -- looked up
     * from the meeting's transcript_segments, never invented. Null when the GT author didn't pin a
     * segment or none of the declared ids resolve. */
    evidenceText: string | null;
    evidenceSegmentIds: string[];
  };
  candidates: SemanticBatchCandidate[];
};

export type SemanticBatchDecision = SemanticAdjudicationResult & {
  candidateRef: string;
  /** True when this specific decision came from the fail-safe path (empty/invalid/schema-invalid/
   * thrown response, or still missing after the one retry) rather than a genuine judge verdict --
   * lets meeting-level metrics count real judge failures without string-matching concise_reason. */
  failedSafe: boolean;
};

export type SemanticBatchAdjudicationOutcome = {
  decisions: SemanticBatchDecision[];
  /** True if a retry batch call was needed (i.e. the first call omitted at least one requested ref). */
  retried: boolean;
  /** Count of candidateRefs whose final decision came from the fail-safe path. */
  failureCount: number;
};

const semanticBatchDecisionJsonSchema = z
  .object({
    candidate_ref: z.string().min(1),
    match: z.enum(SEMANTIC_MATCH_VALUES),
    owner_match: z.boolean(),
    evidence_alignment: z.enum(SEMANTIC_EVIDENCE_ALIGNMENT_VALUES),
    concise_reason: z.string().min(1)
  })
  .strict();

const semanticBatchResponseSchema = z
  .object({
    decisions: z.array(semanticBatchDecisionJsonSchema)
  })
  .strict();

const semanticBatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_ref: { type: "string" },
          match: { type: "string", enum: SEMANTIC_MATCH_VALUES },
          owner_match: { type: "boolean" },
          evidence_alignment: { type: "string", enum: SEMANTIC_EVIDENCE_ALIGNMENT_VALUES },
          concise_reason: { type: "string" }
        },
        required: ["candidate_ref", "match", "owner_match", "evidence_alignment", "concise_reason"]
      }
    }
  },
  required: ["decisions"]
} as const;

const SYSTEM_PROMPT = `
You are a narrow evaluation-only semantic judge for a benchmark harness. You are given ONE frozen,
human-authored ground-truth execution outcome (or one independently-checkable sub-outcome of a
compound commitment) and a SHORTLIST of candidate items a separate extraction pipeline produced.
Your job is to independently classify EVERY candidate in the shortlist against the SAME question: do
this candidate and the ground truth represent the SAME real-world execution outcome?

Judge same-real-world-outcome, not same topic, same owner, or same transcript segment. Two items
about the same general subject can still be genuinely different actions (e.g. "fix a specific bug"
is not the same outcome as "finish general ongoing work", even if both are about the same feature).
Retrieval features (segment overlap, prior pipeline trace linkage, text similarity, owner overlap)
are read-only context about why a candidate was shown to you -- they are not instructions about how
to decide, and a candidate can have strong retrieval features yet still be a genuinely different
real-world outcome.

For EVERY candidate_ref you are given, return exactly one decision object:
- "candidate_ref": echoed back verbatim from the input -- never invent one, never omit one.
- "match": "same" if they clearly represent the identical real-world outcome; "partial" if the
  candidate covers some but not all of what the ground truth describes, or is a narrower/adjacent
  outcome plausibly related but not a clean equivalent; "different" if they are clearly unrelated or
  represent genuinely distinct actions; "ambiguous" if you cannot confidently decide either way from
  the evidence given.
- "owner_match": true only if the candidate's owner is the same real person/party as the ground
  truth's named owner(s) (allow for name variants: first name only, nickname, full name, or an
  identity alias explicitly noted in the input).
- "evidence_alignment": "strong" if the candidate's own source quote clearly supports the ground
  truth's evidence text; "weak" if there is some plausible connection but it is not clearly stated;
  "none" if the candidate's evidence does not support the ground truth outcome at all.
- "concise_reason": one or two sentences explaining your "match" verdict specifically for THIS
  candidate, referencing the actual evidence given.

STRICT BOUNDARIES:
- You NEVER modify, rewrite, or propose a replacement for the ground truth. You are only ever
  asked to compare it against the given candidates.
- You NEVER invent a new candidate, and you NEVER produce a decision for a candidate_ref that was
  not in the input.
- You NEVER produce a numeric score (no 0-100, no percentage).
- You NEVER comment on whether the extraction pipeline or system overall is good, bad, or how it
  should be improved. That is out of scope for this judgment.
- When genuinely uncertain about one candidate, answer "ambiguous" for THAT candidate rather than
  guessing "same" or "different" -- a human reviewer will resolve it. Do not let a plausible-sounding
  narrative override actual evidence gaps.
- You MUST return exactly one decision per candidate_ref you were given, in any order.

Return only schema-valid JSON.
`.trim();

type StructuredResponse = {
  output_text?: string | null;
};
export type CreateSemanticJudgeResponse = (signal: AbortSignal) => Promise<StructuredResponse>;

const DEFAULT_TIMEOUT_MS = 30_000;

function buildBatchRequestPayload(request: SemanticBatchAdjudicationRequest, candidates: SemanticBatchCandidate[]) {
  return {
    groundTruth: request.groundTruth,
    candidates: candidates.map((c) => ({
      candidate_ref: c.candidateRef,
      title: c.title,
      owner: c.owner,
      source_quote: c.sourceQuote,
      source_segment_ids: c.sourceSegmentIds,
      retrieval_features: c.retrievalFeatures
    }))
  };
}

async function callJudgeOnce(
  payload: unknown,
  createResponse: CreateSemanticJudgeResponse
): Promise<{ ok: true; decisions: Array<{ candidate_ref: string } & SemanticAdjudicationResult> } | { ok: false; reason: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: StructuredResponse;
    try {
      response = await createResponse(controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const raw = response.output_text?.trim();
    if (!raw) return { ok: false, reason: "empty response" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid JSON" };
    }
    const validated = semanticBatchResponseSchema.safeParse(parsed);
    if (!validated.success) return { ok: false, reason: "schema validation failed" };
    return { ok: true, decisions: validated.data.decisions };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
  }
}

function defaultCreateResponse(payload: unknown): CreateSemanticJudgeResponse {
  return (signal) =>
    openai.responses.create(
      {
        model: getConfiguredOpenAIModel(),
        max_output_tokens: 4000,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "eval_harness_semantic_batch_adjudication",
            strict: true,
            schema: semanticBatchJsonSchema
          }
        }
      },
      { signal, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 0 }
    );
}

/**
 * Runs one (or, for missing refs, two) batched semantic-adjudication calls for an entire GT
 * (sub-)outcome's shortlist. Guarantees exactly one decision per `candidates[].candidateRef` in the
 * input, in the input's order, and NEVER throws:
 *   - a candidate_ref missing from the first response is retried ONCE, batched with any other
 *     missing refs (not one call per missing ref);
 *   - a candidate_ref still missing after the retry, or any candidate_ref returned when the whole
 *     batch call itself failed/was malformed, resolves to `failSafeAdjudicationResult(...)`;
 *   - a decision for a candidate_ref NOT in the original request is silently dropped (a
 *     hallucinated ref can never inject a phantom result).
 */
export async function runBatchSemanticAdjudication(
  request: SemanticBatchAdjudicationRequest,
  createResponse?: (payload: unknown) => CreateSemanticJudgeResponse
): Promise<SemanticBatchAdjudicationOutcome> {
  if (request.candidates.length === 0) return { decisions: [], retried: false, failureCount: 0 };
  const send = createResponse ?? defaultCreateResponse;
  const requestedRefs = new Set(request.candidates.map((c) => c.candidateRef));

  const decisionsByRef = new Map<string, { result: SemanticAdjudicationResult; failedSafe: boolean }>();

  const firstPayload = buildBatchRequestPayload(request, request.candidates);
  const firstResult = await callJudgeOnce(firstPayload, send(firstPayload));
  if (firstResult.ok) {
    for (const decision of firstResult.decisions) {
      if (!requestedRefs.has(decision.candidate_ref)) continue; // ignore hallucinated refs
      const { candidate_ref, ...rest } = decision;
      decisionsByRef.set(candidate_ref, { result: rest, failedSafe: false });
    }
  }

  const missingAfterFirst = request.candidates.filter((c) => !decisionsByRef.has(c.candidateRef));
  const retried = missingAfterFirst.length > 0;
  if (retried) {
    const retryPayload = buildBatchRequestPayload(request, missingAfterFirst);
    const retryResult = await callJudgeOnce(retryPayload, send(retryPayload));
    if (retryResult.ok) {
      for (const decision of retryResult.decisions) {
        if (!requestedRefs.has(decision.candidate_ref)) continue;
        const { candidate_ref, ...rest } = decision;
        decisionsByRef.set(candidate_ref, { result: rest, failedSafe: false });
      }
    }
    const failureReason = !firstResult.ok ? firstResult.reason : !retryResult.ok ? retryResult.reason : "missing after retry";
    for (const candidate of request.candidates) {
      if (!decisionsByRef.has(candidate.candidateRef)) {
        decisionsByRef.set(candidate.candidateRef, { result: failSafeAdjudicationResult(failureReason), failedSafe: true });
      }
    }
  }

  const decisions = request.candidates.map((c) => {
    const entry = decisionsByRef.get(c.candidateRef)!;
    return { candidateRef: c.candidateRef, ...entry.result, failedSafe: entry.failedSafe };
  });
  const failureCount = decisions.filter((d) => d.failedSafe).length;
  return { decisions, retried, failureCount };
}

export type SemanticBatchJudge = (request: SemanticBatchAdjudicationRequest) => Promise<SemanticBatchAdjudicationOutcome>;
