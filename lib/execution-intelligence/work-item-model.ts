import { z } from "zod";

import { getV4StageModel, getV4StageTimeoutMs, type V4Stage } from "@/lib/env";
import { openai } from "@/lib/openai";
import { logExecutionModelEvent } from "./observability";
import {
  globalCorrectionJsonSchema,
  globalWorkItemAdditionSchema,
  globalWorkItemCorrectionSchema,
  groupingJsonSchema,
  rawGroupProposalSchema,
  rawWorkItemSchema,
  verificationJsonSchema,
  verifiedGroupSchema,
  workItemExtractionJsonSchema,
  type GlobalWorkItemAddition,
  type GlobalWorkItemCorrection,
  type RawGroupProposal,
  type RawWorkItem,
  type VerifiedGroup
} from "./work-item-schemas";

const MODEL_MAX_OUTPUT_TOKENS = 16_000;
const MODEL_MAX_ATTEMPTS = 2;
const MODEL_SDK_MAX_RETRIES = 0;

type StructuredResponse = { output_text?: string | null };
type CreateStructuredResponse = (signal: AbortSignal) => Promise<StructuredResponse>;

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
  | { ok: true; raw: unknown; latencyMs: number }
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
          return { ok: true, raw: JSON.parse(raw), latencyMs: Date.now() - startedAt };
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
  | { ok: true; items: RawWorkItem[]; latencyMs: number; salvagedItems: number }
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
    salvagedItems: salvaged.dropped
  };
}

export type GlobalCorrectionModelResult =
  | {
      ok: true;
      corrections: GlobalWorkItemCorrection[];
      additions: GlobalWorkItemAddition[];
      latencyMs: number;
      salvagedItems: number;
    }
  | { ok: false; error: string; details?: string; latencyMs: number; validationFailure: boolean };

export async function runGlobalCorrectionModel(input: {
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateStructuredResponse;
}): Promise<GlobalCorrectionModelResult> {
  const result = await requestStructuredJson({
    stage: "global_correction",
    systemPrompt: input.systemPrompt,
    context: input.context,
    jsonSchema: globalCorrectionJsonSchema,
    timeoutMs: input.timeoutMs,
    createResponse: input.createResponse
  });
  if (!result.ok) return result;
  const corrections = salvageArray(result.raw, "corrections", globalWorkItemCorrectionSchema);
  const additions = salvageArray(result.raw, "additions", globalWorkItemAdditionSchema);
  return {
    ok: true,
    corrections: corrections.items,
    additions: additions.items,
    latencyMs: result.latencyMs,
    salvagedItems: corrections.dropped + additions.dropped
  };
}

export type GroupingModelResult =
  | { ok: true; groups: RawGroupProposal[]; latencyMs: number; salvagedItems: number }
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
    salvagedItems: salvaged.dropped
  };
}

export type GroupingVerificationModelResult =
  | { ok: true; groups: VerifiedGroup[]; latencyMs: number; salvagedItems: number }
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
    salvagedItems: groups.dropped
  };
}
