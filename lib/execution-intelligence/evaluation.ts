import { semanticTokenSimilarity } from "./graph";

export type EvaluationItem = {
  title: string;
  owner?: string | null;
  due_date?: string | null;
  source_quote?: string | null;
};

export type EvaluationSet = {
  commitments: EvaluationItem[];
  tasks: EvaluationItem[];
};

export type ExtractionQualityMetrics = {
  commitmentPrecision: number;
  commitmentRecall: number;
  commitmentF1: number;
  taskPrecision: number;
  taskRecall: number;
  taskF1: number;
  ownerAccuracy: number;
  dueDateAccuracy: number;
  groundingAccuracy: number;
  duplicateRate: number;
  hallucinationRate: number;
  completenessScore: number;
};

function normalize(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function f1(precision: number, recall: number) {
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

function matchItems(expected: EvaluationItem[], predicted: EvaluationItem[]) {
  const matches: Array<{ expected: EvaluationItem; predicted: EvaluationItem }> = [];
  const used = new Set<number>();

  for (const expectedItem of expected) {
    let bestIndex = -1;
    let bestScore = 0;
    predicted.forEach((predictedItem, index) => {
      if (used.has(index)) return;
      const score = semanticTokenSimilarity(expectedItem.title, predictedItem.title);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore >= 0.6) {
      used.add(bestIndex);
      matches.push({ expected: expectedItem, predicted: predicted[bestIndex] });
    }
  }

  return {
    matches,
    precision: predicted.length === 0 ? Number(expected.length === 0) : matches.length / predicted.length,
    recall: expected.length === 0 ? 1 : matches.length / expected.length
  };
}

export function evaluateExecutionExtraction(input: {
  expected: EvaluationSet;
  predicted: EvaluationSet;
}): ExtractionQualityMetrics {
  const commitments = matchItems(
    input.expected.commitments,
    input.predicted.commitments
  );
  const tasks = matchItems(input.expected.tasks, input.predicted.tasks);
  const allMatches = [...commitments.matches, ...tasks.matches];
  const ownerComparable = allMatches.filter(({ expected }) => expected.owner !== undefined);
  const dateComparable = allMatches.filter(({ expected }) => expected.due_date !== undefined);
  const allPredictions = [
    ...input.predicted.commitments,
    ...input.predicted.tasks
  ];

  function duplicatePairs(items: EvaluationItem[]) {
    return items.reduce((count, item, index) => {
      return (
        count +
        items
          .slice(index + 1)
          .filter(
            (other) => semanticTokenSimilarity(item.title, other.title) >= 0.82
          ).length
      );
    }, 0);
  }
  const duplicatePairCount =
    duplicatePairs(input.predicted.commitments) +
    duplicatePairs(input.predicted.tasks);

  const expectedTotal =
    input.expected.commitments.length + input.expected.tasks.length;
  const matchedTotal = allMatches.length;
  const predictedTotal = allPredictions.length;

  return {
    commitmentPrecision: commitments.precision,
    commitmentRecall: commitments.recall,
    commitmentF1: f1(commitments.precision, commitments.recall),
    taskPrecision: tasks.precision,
    taskRecall: tasks.recall,
    taskF1: f1(tasks.precision, tasks.recall),
    ownerAccuracy:
      ownerComparable.length === 0
        ? 1
        : ownerComparable.filter(
            ({ expected, predicted }) =>
              normalize(expected.owner) === normalize(predicted.owner)
          ).length / ownerComparable.length,
    dueDateAccuracy:
      dateComparable.length === 0
        ? 1
        : dateComparable.filter(
            ({ expected, predicted }) =>
              normalize(expected.due_date) === normalize(predicted.due_date)
          ).length / dateComparable.length,
    groundingAccuracy:
      predictedTotal === 0
        ? 1
        : allPredictions.filter((item) => Boolean(item.source_quote?.trim()))
            .length / predictedTotal,
    duplicateRate:
      predictedTotal === 0 ? 0 : duplicatePairCount / predictedTotal,
    hallucinationRate:
      predictedTotal === 0 ? 0 : (predictedTotal - matchedTotal) / predictedTotal,
    completenessScore: expectedTotal === 0 ? 1 : matchedTotal / expectedTotal
  };
}

export const MVP_QUALITY_THRESHOLDS = {
  commitmentRecall: 0.75,
  commitmentPrecision: 0.7,
  taskRecall: 0.75,
  taskPrecision: 0.7,
  ownerAccuracy: 0.7,
  dueDateAccuracy: 0.7,
  groundingAccuracy: 0.8,
  duplicateRateMax: 0.1,
  hallucinationRateMax: 0.15,
  completenessScore: 0.75
} as const;
