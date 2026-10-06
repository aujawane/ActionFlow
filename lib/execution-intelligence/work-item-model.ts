import { z } from "zod";

import { getV4StageModel, getV4StageTimeoutMs, type V4Stage } from "@/lib/env";
import { openai } from "@/lib/openai";
import { logExecutionModelEvent } from "./observability";
import {
  atomicActionHarvestCandidateSchema,
  atomicActionHarvestJsonSchema,
  completenessAdjudicationDecisionSchema,
  completenessAdjudicationJsonSchema,
  completionVerificationJsonSchema,
  completionVerificationSchema,
  globalWorkItemCorrectionSchema,
  groupingJsonSchema,
  lifecycleReviewJsonSchema,
  rawGroupProposalSchema,
  rawWorkItemSchema,
  scopeDeferralVerificationJsonSchema,
  scopeDeferralVerificationSchema,
  taskConsolidationJsonSchema,
  taskConsolidationProposalSchema,
  transcriptCorrectionSchema,
  transcriptNormalizationJsonSchema,
  verificationJsonSchema,
  verifiedGroupSchema,
  vocabularyCandidateSchema,
  workItemExtractionJsonSchema,
  type AtomicActionHarvestCandidate,
  type CompletenessAdjudicationDecision,
  type GlobalWorkItemCorrection,
  type RawGroupProposal,
  type RawWorkItem,
  type TaskConsolidationProposal,
  type TranscriptCorrection,
  type VerifiedGroup,
  type VocabularyCandidate
} from "./work-item-schemas";

const MODEL_MAX_OUTPUT_TOKENS = 16_000;
const MODEL_MAX_ATTEMPTS = 2;
const MODEL_SDK_MAX_RETRIES = 0;

/**
 * GPT-6.1 Sol work_item_extraction experiment: this stage's per-attempt timeout was raised to
 * 240_000ms (see V4_STAGE_SAFE_ATTEMPT_TIMEOUT_CEILING_MS in lib/env.ts), which alone consumes
 * most of the ~300s workflow-step budget. A second attempt starting after a long first one would
 * risk a hard step kill mid-retry with no chance to mark the job failed, so this stage gets
 * exactly one attempt for the duration of the experiment. Every other stage keeps
 * MODEL_MAX_ATTEMPTS untouched.
 */
const V4_STAGE_MAX_ATTEMPTS_OVERRIDE: Partial<Record<V4Stage, number>> = {
  work_item_extraction: 1
};

function getMaxAttemptsForStage(stage: V4Stage): number {
  return V4_STAGE_MAX_ATTEMPTS_OVERRIDE[stage] ?? MODEL_MAX_ATTEMPTS;
}

export type TokenUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

type StructuredResponse = {
  output_text?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
};
export type CreateStructuredResponse = (signal: AbortSignal) => Promise<StructuredResponse>;

function extractUsage(response: StructuredResponse): TokenUsage | null {
  if (!response.usage) return null;
  return {
    input_tokens: response.usage.input_tokens ?? null,
    output_tokens: response.usage.output_tokens ?? null,
    total_tokens: response.usage.total_tokens ?? null
  };
}

class WorkItemModelTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Execution intelligence v4 ${timeoutMs}ms call timed out.`);
    this.name = "WorkItemModelTimeoutError";
  }
}

function isTimeout(error: unknown) {
  if (error instanceof WorkItemModelTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "APIConnectionTimeoutError" ||
    /(?:timed out|timeout)/i.test(error.message)
  );
}

async function withRequestTimeout(
  request: CreateStructuredResponse,
  timeoutMs: number
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new WorkItemModelTimeoutError(timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RawJsonResult =
  | { ok: true; raw: unknown; latencyMs: number; usage: TokenUsage | null }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

async function requestStructuredJson(input: {
  stage: V4Stage;
  systemPrompt: string;
  context: unknown;
  jsonSchema: Record<string, unknown>;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<RawJsonResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? getV4StageTimeoutMs(input.stage);
  const model = getV4StageModel(input.stage);
  const requestBody = {
    model,
    max_output_tokens: MODEL_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system" as const, content: input.systemPrompt },
      { role: "user" as const, content: JSON.stringify(input.context) }
    ],
    text: {
      format: {
        type: "json_schema" as const,
        name: `execution_v4_${input.stage}`,
        strict: true,
        schema: input.jsonSchema
      }
    }
  };
  const createResponse: CreateStructuredResponse =
    input.createResponse ??
    ((signal) =>
      openai.responses.create(requestBody, {
        signal,
        timeout: timeoutMs,
        maxRetries: MODEL_SDK_MAX_RETRIES
      }));

  const maxAttempts = getMaxAttemptsForStage(input.stage);
  let lastError: RawJsonResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await withRequestTimeout(createResponse, timeoutMs);
      logExecutionModelEvent({
        stage: input.stage,
        event: "success",
        attempt,
        maxAttempts,
        timeoutMs,
        elapsedMs: Date.now() - attemptStartedAt
      });
      const raw = response.output_text?.trim();
      if (!raw) {
        lastError = {
          ok: false,
          error: `OpenAI returned empty ${input.stage} output.`,
          latencyMs: Date.now() - startedAt,
          validationFailure: false
        };
      } else {
        try {
          return {
            ok: true,
            raw: JSON.parse(raw),
            latencyMs: Date.now() - startedAt,
            usage: extractUsage(response)
          };
        } catch {
          lastError = {
            ok: false,
            error: `OpenAI returned invalid ${input.stage} JSON.`,
            details: raw.slice(0, 500),
            latencyMs: Date.now() - startedAt,
            validationFailure: true
          };
        }
      }
    } catch (error) {
      const timedOut = isTimeout(error);
      logExecutionModelEvent({
        stage: input.stage,
        event: timedOut ? "timeout" : "failure",
        attempt,
        maxAttempts,
        timeoutMs,
        elapsedMs: Date.now() - attemptStartedAt,
        details: error instanceof Error ? error.message : "Unknown error"
      });
      lastError = {
        ok: false,
        error: timedOut
          ? `Execution intelligence v4 ${input.stage} call timed out.`
          : `Execution intelligence v4 ${input.stage} call failed.`,
        details: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - startedAt,
        validationFailure: false
      };
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  return (
    lastError ?? {
      ok: false,
      error: `Execution intelligence v4 ${input.stage} failed.`,
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    }
  );
}

function salvageArray<T>(
  raw: unknown,
  key: string,
  itemSchema: z.ZodType<T>
): { items: T[]; dropped: number } {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawArray = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
  const items: T[] = [];
  let dropped = 0;
  for (const entry of rawArray) {
    const parsed = itemSchema.safeParse(entry);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      dropped += 1;
    }
  }
  return { items, dropped };
}

export type WorkItemExtractionModelResult =
  | { ok: true; items: RawWorkItem[]; latencyMs: number; salvagedItems: number; usage: TokenUsage | null }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runWorkItemExtractionModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<WorkItemExtractionModelResult> {
  const result = await requestStructuredJson({
    stage: "work_item_extraction",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: workItemExtractionJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const salvaged = salvageArray(result.raw, "items", rawWorkItemSchema);
  return {
    ok: true,
    items: salvaged.items,
    latencyMs: result.latencyMs,
    salvagedItems: salvaged.dropped,
    usage: result.usage
  };
}

export type AtomicActionHarvestModelResult =
  | {
      ok: true;
      candidates: AtomicActionHarvestCandidate[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Pass A: atomic action harvest. Ledger-blind, high-recall enumeration of grounded action
 * candidates -- never decides whether something is already known, never repairs an existing item. */
export async function runAtomicActionHarvestModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<AtomicActionHarvestModelResult> {
  const result = await requestStructuredJson({
    stage: "atomic_action_harvest",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: atomicActionHarvestJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const candidates = salvageArray(result.raw, "candidates", atomicActionHarvestCandidateSchema);
  return {
    ok: true,
    candidates: candidates.items,
    latencyMs: result.latencyMs,
    salvagedItems: candidates.dropped,
    usage: result.usage
  };
}

export type CompletenessAdjudicationModelResult =
  | {
      ok: true;
      decisions: CompletenessAdjudicationDecision[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Pass B: missing-work adjudication. Given harvested candidates (never rediscovered from the
 * transcript itself) plus the existing ledger, decides per candidate whether it represents genuine,
 * currently-absent execution work -- exhaustive coverage is enforced by the caller
 * (work-item-stages.ts's runCompletenessAdjudicationPass), not here. */
export async function runCompletenessAdjudicationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<CompletenessAdjudicationModelResult> {
  const result = await requestStructuredJson({
    stage: "completeness_adjudication",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: completenessAdjudicationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const decisions = salvageArray(result.raw, "decisions", completenessAdjudicationDecisionSchema);
  return {
    ok: true,
    decisions: decisions.items,
    latencyMs: result.latencyMs,
    salvagedItems: decisions.dropped,
    usage: result.usage
  };
}

export type LifecycleReconciliationModelResult =
  | {
      ok: true;
      reviews: GlobalWorkItemCorrection[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Pass B: exhaustive lifecycle reconciliation. One review per submitted ref -- exhaustive
 * coverage is enforced by the caller (work-item-stages.ts's runLifecycleReconciliationPass), not
 * here; this function only makes the model call and salvages whatever schema-valid reviews come
 * back. */
export async function runLifecycleReconciliationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<LifecycleReconciliationModelResult> {
  const result = await requestStructuredJson({
    stage: "lifecycle_reconciliation",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: lifecycleReviewJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const reviews = salvageArray(result.raw, "reviews", globalWorkItemCorrectionSchema);
  return {
    ok: true,
    reviews: reviews.items,
    latencyMs: result.latencyMs,
    salvagedItems: reviews.dropped,
    usage: result.usage
  };
}

export type CompletionVerificationModelResult =
  | {
      ok: true;
      confirmed: boolean;
      reasoning: string;
      supportingSegmentIds: string[];
      latencyMs: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Targeted completion verifier: one work item, one question, one schema-valid object -- not an
 * array, so no salvageArray here. A malformed response is treated as a hard failure by the caller
 * (work-item-stages.ts's runLifecycleReconciliationPass), which fails closed (keeps the item open)
 * rather than propagating the failure as a whole-meeting error. */
export async function runCompletionVerificationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<CompletionVerificationModelResult> {
  const result = await requestStructuredJson({
    stage: "completion_verification",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: completionVerificationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const parsed = completionVerificationSchema.safeParse(result.raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "OpenAI returned invalid completion_verification JSON.",
      details: JSON.stringify(result.raw).slice(0, 500),
      latencyMs: result.latencyMs,
      validationFailure: true
    };
  }
  return {
    ok: true,
    confirmed: parsed.data.confirmed,
    reasoning: parsed.data.reasoning,
    supportingSegmentIds: parsed.data.supporting_segment_ids,
    latencyMs: result.latencyMs,
    usage: result.usage
  };
}

export type ScopeDeferralVerificationModelResult =
  | {
      ok: true;
      confirmed: boolean;
      reasoning: string;
      supportingSegmentIds: string[];
      latencyMs: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Targeted scope-deferral verifier: one work item, one question, one schema-valid object -- not
 * an array, so no salvageArray here. A malformed response is treated as a hard failure by the
 * caller (work-item-stages.ts's runLifecycleReconciliationPass), which fails closed (keeps the
 * item at its current scope_state) rather than propagating the failure as a whole-meeting error. */
export async function runScopeDeferralVerificationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<ScopeDeferralVerificationModelResult> {
  const result = await requestStructuredJson({
    stage: "scope_deferral_verification",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: scopeDeferralVerificationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const parsed = scopeDeferralVerificationSchema.safeParse(result.raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "OpenAI returned invalid scope_deferral_verification JSON.",
      details: JSON.stringify(result.raw).slice(0, 500),
      latencyMs: result.latencyMs,
      validationFailure: true
    };
  }
  return {
    ok: true,
    confirmed: parsed.data.confirmed,
    reasoning: parsed.data.reasoning,
    supportingSegmentIds: parsed.data.supporting_segment_ids,
    latencyMs: result.latencyMs,
    usage: result.usage
  };
}

export type GroupingModelResult =
  | { ok: true; groups: RawGroupProposal[]; latencyMs: number; salvagedItems: number; usage: TokenUsage | null }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runGroupingModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<GroupingModelResult> {
  const result = await requestStructuredJson({
    stage: "grouping",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: groupingJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const salvaged = salvageArray(result.raw, "groups", rawGroupProposalSchema);
  return {
    ok: true,
    groups: salvaged.items,
    latencyMs: result.latencyMs,
    salvagedItems: salvaged.dropped,
    usage: result.usage
  };
}

export type GroupingVerificationModelResult =
  | { ok: true; groups: VerifiedGroup[]; latencyMs: number; salvagedItems: number; usage: TokenUsage | null }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runGroupingVerificationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<GroupingVerificationModelResult> {
  const result = await requestStructuredJson({
    stage: "grouping_verification",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: verificationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const groups = salvageArray(result.raw, "groups", verifiedGroupSchema);
  return {
    ok: true,
    groups: groups.items,
    latencyMs: result.latencyMs,
    salvagedItems: groups.dropped,
    usage: result.usage
  };
}

export type TranscriptNormalizationModelResult =
  | {
      ok: true;
      corrections: TranscriptCorrection[];
      vocabularyCandidates: VocabularyCandidate[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runTranscriptNormalizationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<TranscriptNormalizationModelResult> {
  const result = await requestStructuredJson({
    stage: "transcript_normalization",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: transcriptNormalizationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const corrections = salvageArray(result.raw, "corrections", transcriptCorrectionSchema);
  const vocabularyCandidates = salvageArray(
    result.raw,
    "vocabulary_candidates",
    vocabularyCandidateSchema
  );
  return {
    ok: true,
    corrections: corrections.items,
    vocabularyCandidates: vocabularyCandidates.items,
    latencyMs: result.latencyMs,
    salvagedItems: corrections.dropped + vocabularyCandidates.dropped,
    usage: result.usage
  };
}

export type TaskConsolidationModelResult =
  | { ok: true; proposals: TaskConsolidationProposal[]; latencyMs: number; salvagedItems: number; usage: TokenUsage | null }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runTaskConsolidationModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<TaskConsolidationModelResult> {
  const result = await requestStructuredJson({
    stage: "task_consolidation",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: taskConsolidationJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const proposals = salvageArray(result.raw, "proposals", taskConsolidationProposalSchema);
  return {
    ok: true,
    proposals: proposals.items,
    latencyMs: result.latencyMs,
    salvagedItems: proposals.dropped,
    usage: result.usage
  };
}
