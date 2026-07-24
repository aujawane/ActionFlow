import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import {
  runLiveExecutionFixture,
  type ExecutionEvaluationFixture
} from "../lib/execution-intelligence/fixture-harness";
import type { EvaluationSet } from "../lib/execution-intelligence/evaluation";

loadEnvConfig(process.cwd());

const args = process.argv.slice(2);
function argument(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const fixturePath = path.resolve(
  process.cwd(),
  "tests/fixtures/execution-intelligence.json"
);
const outputPath = path.resolve(
  argument(
    "--out",
    "tests/fixtures/execution-intelligence-live-predictions.json"
  )
);
const concurrency = Math.max(
  1,
  Math.min(5, Number(argument("--concurrency", "3")) || 3)
);
const fixtures = JSON.parse(
  readFileSync(fixturePath, "utf8")
) as ExecutionEvaluationFixture[];
const predictions: Record<string, EvaluationSet> = {};
const failures: Array<{ id: string; error: string }> = [];
let nextIndex = 0;

async function worker() {
  while (nextIndex < fixtures.length) {
    const index = nextIndex;
    nextIndex += 1;
    const fixture = fixtures[index];
    console.info("[execution-live-eval] starting", {
      fixture: fixture.id,
      index: index + 1,
      total: fixtures.length
    });
    const result = await runLiveExecutionFixture(fixture);
    if (result.ok) {
      predictions[fixture.id] = result.prediction;
      console.info("[execution-live-eval] completed", {
        fixture: fixture.id,
        latency_ms: result.latencyMs,
        commitments: result.prediction.commitments.length,
        tasks: result.prediction.tasks.length
      });
    } else {
      predictions[fixture.id] = { commitments: [], tasks: [] };
      failures.push({ id: fixture.id, error: result.error });
      console.error("[execution-live-eval] failed", {
        fixture: fixture.id,
        latency_ms: result.latencyMs,
        error: result.error
      });
    }
  }
}

async function main() {
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  writeFileSync(outputPath, `${JSON.stringify(predictions, null, 2)}\n`);
  console.info("[execution-live-eval] results", {
    fixture_count: fixtures.length,
    failed_count: failures.length,
    output: outputPath,
    failures
  });
  if (failures.length > 0) process.exitCode = 1;
}

void main();
