import { getOpenAIModel, openai } from "@/lib/openai";

import {
  executionGraphJsonSchema,
  executionGraphSchema,
  type ExecutionGraph
} from "./schemas";

export type ExecutionModelStage = "candidates" | "verification" | "completeness";

export type ModelStageResult =
  | { ok: true; graph: ExecutionGraph; latencyMs: number }
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
}): Promise<ModelStageResult> {
  const startedAt = Date.now();
  let lastError: ModelStageResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await openai.responses.create({
        model: getOpenAIModel(),
        input: [
          { role: "system", content: input.systemPrompt },
          {
            role: "user",
            content: JSON.stringify(input.context)
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: `execution_graph_${input.stage}`,
            strict: true,
            schema: executionGraphJsonSchema
          }
        }
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
          const validated = executionGraphSchema.safeParse(parsed);
          if (validated.success) {
            return {
              ok: true,
              graph: validated.data,
              latencyMs: Date.now() - startedAt
            };
          }
          lastError = {
            ok: false,
            error: `${input.stage} output did not match the execution graph schema.`,
            details: validated.error.message,
            latencyMs: Date.now() - startedAt,
            validationFailure: true
          };
        }
      }
    } catch (error) {
      lastError = {
        ok: false,
        error: `Execution intelligence ${input.stage} call failed.`,
        details: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - startedAt,
        validationFailure: false
      };
    }

    if (attempt < 2) {
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
