import { readFileSync } from "node:fs";
import path from "node:path";

import {
  evaluateExecutionExtraction,
  MVP_QUALITY_THRESHOLDS,
  type EvaluationSet
} from "../lib/execution-intelligence/evaluation";

type Fixture = {
  id: string;
  transcript: string;
  expected: EvaluationSet;
};

const fixturePath = path.resolve(
  process.cwd(),
  "tests/fixtures/execution-intelligence.json"
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture[];
const predictionsPath = process.argv[2];
const predictions = predictionsPath
  ? (JSON.parse(readFileSync(path.resolve(predictionsPath), "utf8")) as Record<
      string,
      EvaluationSet
    >)
  : Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.expected]));

const perFixture = fixtures.map((fixture) =>
  evaluateExecutionExtraction({
    expected: fixture.expected,
    predicted: predictions[fixture.id] ?? { commitments: [], tasks: [] }
  })
);
const metrics = Object.fromEntries(
  Object.keys(perFixture[0]).map((key) => [
    key,
    perFixture.reduce(
      (sum, item) =>
        sum + item[key as keyof typeof item],
      0
    ) / perFixture.length
  ])
) as ReturnType<typeof evaluateExecutionExtraction>;
console.log(JSON.stringify({ fixtureCount: fixtures.length, metrics }, null, 2));

const failures = [
  metrics.commitmentRecall < MVP_QUALITY_THRESHOLDS.commitmentRecall &&
    "commitmentRecall",
  metrics.commitmentPrecision < MVP_QUALITY_THRESHOLDS.commitmentPrecision &&
    "commitmentPrecision",
  metrics.taskRecall < MVP_QUALITY_THRESHOLDS.taskRecall && "taskRecall",
  metrics.taskPrecision < MVP_QUALITY_THRESHOLDS.taskPrecision && "taskPrecision",
  metrics.ownerAccuracy < MVP_QUALITY_THRESHOLDS.ownerAccuracy && "ownerAccuracy",
  metrics.dueDateAccuracy < MVP_QUALITY_THRESHOLDS.dueDateAccuracy &&
    "dueDateAccuracy",
  metrics.groundingAccuracy < MVP_QUALITY_THRESHOLDS.groundingAccuracy &&
    "groundingAccuracy",
  metrics.duplicateRate > MVP_QUALITY_THRESHOLDS.duplicateRateMax &&
    "duplicateRate",
  metrics.hallucinationRate > MVP_QUALITY_THRESHOLDS.hallucinationRateMax &&
    "hallucinationRate",
  metrics.completenessScore < MVP_QUALITY_THRESHOLDS.completenessScore &&
    "completenessScore"
].filter(Boolean);

if (failures.length > 0) {
  console.error(`Execution extraction regression: ${failures.join(", ")}`);
  process.exit(1);
}

if (!predictionsPath) {
  console.info(
    "Reference-label self-check passed. Pass a predictions JSON path to score model output."
  );
}
