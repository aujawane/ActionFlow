import { z } from "zod";

import { getV4StageModel, getV4StageTimeoutMs, type V4Stage } from "@/lib/env";
import { openai } from "@/lib/openai";
import { logExecutionModelEvent } from "./observability";
import {
  completenessRecoveryJsonSchema,
  globalWorkItemAdditionSchema,
  globalWorkItemCorrectionSchema,
  groupingJsonSchema,
  lifecycleReviewJsonSchema,
  rawGroupProposalSchema,
  rawWorkItemSchema,
  taskConsolidationJsonSchema,
  taskConsolidationProposalSchema,
  transcriptCorrectionSchema,
  transcriptNormalizationJsonSchema,
  verificationJsonSchema,
  verifiedGroupSchema,
  vocabularyCandidateSchema,
  workItemExtractionJsonSchema,
  type GlobalWorkItemAddition,
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

  let lastError: RawJsonResult | null = null;
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await withRequestTimeout(createResponse, timeoutMs);
      logExecutionModelEvent({
        stage: input.stage,
        event: "success",
        attempt,
        maxAttempts: MODEL_MAX_ATTEMPTS,
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
        maxAttempts: MODEL_MAX_ATTEMPTS,
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
    if (attempt < MODEL_MAX_ATTEMPTS) {
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

export type CompletenessRecoveryModelResult =
  | {
      ok: true;
      additions: GlobalWorkItemAddition[];
      latencyMs: number;
      salvagedItems: number;
      usage: TokenUsage | null;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

/** Pass A: completeness recovery. Additions only -- never repairs an existing item. */
export async function runCompletenessRecoveryModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<CompletenessRecoveryModelResult> {
  const result = await requestStructuredJson({
    stage: "completeness_recovery",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: completenessRecoveryJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const additions = salvageArray(result.raw, "additions", globalWorkItemAdditionSchema);
  return {
    ok: true,
    additions: additions.items,
    latencyMs: result.latencyMs,
    salvagedItems: additions.dropped,
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
