import {
  DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS,
  getExecutionIntelligenceTimeoutMs
} from "@/lib/env";
import { getOpenAIModel, openai } from "@/lib/openai";

import {
  executionGraphJsonSchema,
  type ExecutionGraph
} from "./schemas";
import {
  logExecutionCandidateDiagnostics,
  logExecutionModelEvent
} from "./observability";
import { salvageExecutionGraph } from "./salvage";

export type ExecutionModelStage = "candidates" | "verification" | "completeness";
export const EXECUTION_MODEL_TIMEOUT_MS =
  DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS;
export const EXECUTION_MODEL_MAX_ATTEMPTS = 2;
export const EXECUTION_MODEL_MAX_OUTPUT_TOKENS = 16_000;
export const EXECUTION_MODEL_SDK_MAX_RETRIES = 0;

type ExecutionResponse = { output_text?: string | null };
type CreateExecutionResponse = (signal: AbortSignal) => Promise<ExecutionResponse>;

export function buildExecutionModelRequest(input: {
  stage: ExecutionModelStage;
  model: string;
  systemPrompt: string;
  context: unknown;
}) {
  return {
    model: input.model,
    max_output_tokens: EXECUTION_MODEL_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system" as const, content: input.systemPrompt },
      {
        role: "user" as const,
        content: JSON.stringify(input.context)
      }
    ],
    text: {
      format: {
        type: "json_schema" as const,
        name: `execution_graph_${input.stage}`,
        strict: true,
        schema: executionGraphJsonSchema
      }
    }
  };
}

function candidateDiagnostics(input: {
  model: string;
  systemPrompt: string;
  context: unknown;
}) {
  const context =
    input.context && typeof input.context === "object"
      ? (input.context as Record<string, unknown>)
      : {};
  const transcript =
    typeof context.transcript === "string" ? context.transcript : "";
  const topics = Array.isArray(context.topics) ? context.topics : [];
  const summaries = Array.isArray(context.meeting_summaries)
    ? context.meeting_summaries
    : [];
  const nextSteps = Array.isArray(context.insight_next_steps)
    ? context.insight_next_steps
    : [];
  const contextJson = JSON.stringify(input.context);
  const schemaJson = JSON.stringify(executionGraphJsonSchema);
  const totalInputCharacters =
    input.systemPrompt.length + contextJson.length + schemaJson.length;
  const normalizedSupportingContent = [
    ...topics.map((item) =>
      item && typeof item === "object" && "summary" in item
        ? String(item.summary ?? "")
        : ""
    ),
    ...summaries.map((item) =>
      item && typeof item === "object" && "content" in item
        ? String(item.content ?? "")
        : ""
    ),
    ...nextSteps.map((item) =>
      item && typeof item === "object" && "content" in item
        ? String(item.content ?? "")
        : ""
    )
  ]
    .map((content) => content.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean);
  const duplicateSupportingItems =
    normalizedSupportingContent.length -
    new Set(normalizedSupportingContent).size;

  return {
    model: input.model,
    transcript_segment_count:
      typeof context.transcript_segment_count === "number"
        ? context.transcript_segment_count
        : transcript.split("\n").filter(Boolean).length,
    transcript_character_count: transcript.length,
    estimated_input_token_count: Math.ceil(totalInputCharacters / 4),
    topic_count: topics.length,
    prompt_character_count: input.systemPrompt.length,
    schema_character_count: schemaJson.length,
    prompt_schema_character_count:
      input.systemPrompt.length + schemaJson.length,
    context_character_count: contextJson.length,
    meeting_summary_count: summaries.length,
    insight_next_step_count: nextSteps.length,
    duplicate_supporting_content_count: duplicateSupportingItems,
    max_output_tokens: EXECUTION_MODEL_MAX_OUTPUT_TOKENS,
    reasoning_effort: "not_set",
    sdk_max_retries: EXECUTION_MODEL_SDK_MAX_RETRIES
  };
}

class ExecutionModelTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Execution intelligence model call timed out after ${timeoutMs}ms.`);
    this.name = "ExecutionModelTimeoutError";
  }
}

function isExecutionModelTimeout(error: unknown) {
  if (error instanceof ExecutionModelTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "APIConnectionTimeoutError" ||
    /(?:timed out|timeout)/i.test(error.message)
  );
}

async function withRequestTimeout(
  request: CreateExecutionResponse,
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
          reject(new ExecutionModelTimeoutError(timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ModelStageResult =
  | {
      ok: true;
      graph: ExecutionGraph;
      latencyMs: number;
      salvagedItems?: number;
    }
  | {
      ok: false;
      error: string;
      details?: string;
      latencyMs: number;
      validationFailure: boolean;
    };

export async function runExecutionGraphModel(input: {
  stage: ExecutionModelStage;
  systemPrompt: string;
  context: unknown;
  timeoutMs?: number;
  createResponse?: CreateExecutionResponse;
}): Promise<ModelStageResult> {
  const startedAt = Date.now();
  const timeoutMs =
    input.timeoutMs ?? getExecutionIntelligenceTimeoutMs();
  const model = getOpenAIModel();
  const requestBody = buildExecutionModelRequest({
    stage: input.stage,
    model,
    systemPrompt: input.systemPrompt,
    context: input.context
  });
  if (input.stage === "candidates") {
    logExecutionCandidateDiagnostics(
      candidateDiagnostics({
        model,
        systemPrompt: input.systemPrompt,
        context: input.context
      })
    );
  }
  const createResponse: CreateExecutionResponse =
    input.createResponse ??
    ((signal) =>
      openai.responses.create(
        requestBody,
        {
          signal,
          timeout: timeoutMs,
          maxRetries: EXECUTION_MODEL_SDK_MAX_RETRIES
        }
      ));
  let lastError: ModelStageResult | null = null;
  for (let attempt = 1; attempt <= EXECUTION_MODEL_MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = Date.now();
    const requestStartedAt = new Date(attemptStartedAt).toISOString();
    if (input.stage === "candidates") {
      logExecutionCandidateDiagnostics({
        event: "request_start",
        model,
        attempt,
        max_attempts: EXECUTION_MODEL_MAX_ATTEMPTS,
        request_started_at: requestStartedAt
      });
    }
    try {
      const response = await withRequestTimeout(createResponse, timeoutMs);
      const requestEndedAt = new Date().toISOString();
      logExecutionModelEvent({
        stage: input.stage,
        event: "success",
        attempt,
        maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
        timeoutMs,
        elapsedMs: Date.now() - attemptStartedAt,
        requestStartedAt:
          input.stage === "candidates" ? requestStartedAt : undefined,
        requestEndedAt:
          input.stage === "candidates" ? requestEndedAt : undefined
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          logExecutionModelEvent({
            stage: input.stage,
            event: "validation_failure",
            attempt,
            maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
            details: "invalid_json"
          });
          lastError = {
            ok: false,
            error: `OpenAI returned invalid ${input.stage} JSON.`,
            details: raw.slice(0, 500),
            latencyMs: Date.now() - startedAt,
            validationFailure: true
          };
          parsed = null;
        }

        if (parsed !== null) {
          const salvaged = salvageExecutionGraph(parsed);
          if (
            salvaged.ok &&
            (salvaged.inputItemCount === 0 ||
              salvaged.graph.commitments.length + salvaged.graph.tasks.length > 0)
          ) {
            if (salvaged.dropped.length > 0) {
              logExecutionModelEvent({
                stage: input.stage,
                event: "validation_failure",
                attempt,
                maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
                details: JSON.stringify({
                  salvaged_items: salvaged.dropped.length,
                  dropped: salvaged.dropped.map((item) => ({
                    kind: item.kind,
                    index: item.index,
                    client_ref: item.clientRef
                  }))
                })
              });
            }
            return {
              ok: true,
              graph: salvaged.graph,
              latencyMs: Date.now() - startedAt,
              salvagedItems: salvaged.dropped.length
            };
          }
          const details = salvaged.ok
            ? `All ${salvaged.inputItemCount} execution items were malformed.`
            : salvaged.details;
          logExecutionModelEvent({
            stage: input.stage,
            event: "validation_failure",
            attempt,
            maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
            details
          });
          lastError = {
            ok: false,
            error: `${input.stage} output did not match the execution graph schema.`,
            details,
            latencyMs: Date.now() - startedAt,
            validationFailure: true
          };
        }
      }
    } catch (error) {
      const timedOut = isExecutionModelTimeout(error);
      const requestEndedAt = new Date().toISOString();
      if (timedOut) {
        logExecutionModelEvent({
          stage: input.stage,
          event: "timeout",
          attempt,
          maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
          timeoutMs,
          elapsedMs: Date.now() - attemptStartedAt,
          requestStartedAt:
            input.stage === "candidates" ? requestStartedAt : undefined,
          requestEndedAt:
            input.stage === "candidates" ? requestEndedAt : undefined
        });
      } else if (input.stage === "candidates") {
        logExecutionModelEvent({
          stage: input.stage,
          event: "failure",
          attempt,
          maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
          timeoutMs,
          elapsedMs: Date.now() - attemptStartedAt,
          requestStartedAt,
          requestEndedAt,
          details: error instanceof Error ? error.message : "Unknown error"
        });
      }
      lastError = {
        ok: false,
        error: timedOut
          ? `Execution intelligence ${input.stage} call timed out.`
          : `Execution intelligence ${input.stage} call failed.`,
        details: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - startedAt,
        validationFailure: false
      };
    }

    if (attempt < EXECUTION_MODEL_MAX_ATTEMPTS) {
      logExecutionModelEvent({
        stage: input.stage,
        event: "retry",
        attempt,
        maxAttempts: EXECUTION_MODEL_MAX_ATTEMPTS,
        details: lastError?.error
      });
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  return (
    lastError ?? {
      ok: false,
      error: `Execution intelligence ${input.stage} failed.`,
      latencyMs: Date.now() - startedAt,
      validationFailure: false
    }
  );
}
