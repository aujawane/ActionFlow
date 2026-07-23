export type ExecutionMetrics = {
  meetingId: string;
  fallbackUsed: boolean;
  candidateCommitments: number;
  verifiedCommitments: number;
  candidateTasks: number;
  verifiedTasks: number;
  linkedTasks: number;
  unlinkedTasks: number;
  deduplicatedCommitments: number;
  deduplicatedTasks: number;
  missingCommitments: number;
  missingTasks: number;
  groundingRejectedCommitments: number;
  groundingRejectedTasks: number;
  validationFailures: number;
  databaseFailures: number;
  openAiLatencyMs: Record<string, number>;
};

export function createExecutionMetrics(
  meetingId: string,
  fallbackUsed: boolean
): ExecutionMetrics {
  return {
    meetingId,
    fallbackUsed,
    candidateCommitments: 0,
    verifiedCommitments: 0,
    candidateTasks: 0,
    verifiedTasks: 0,
    linkedTasks: 0,
    unlinkedTasks: 0,
    deduplicatedCommitments: 0,
    deduplicatedTasks: 0,
    missingCommitments: 0,
    missingTasks: 0,
    groundingRejectedCommitments: 0,
    groundingRejectedTasks: 0,
    validationFailures: 0,
    databaseFailures: 0,
    openAiLatencyMs: {}
  };
}

export function logExecutionStage(
  metrics: ExecutionMetrics,
  stage: string,
  details: Record<string, unknown> = {}
) {
  console.info("[execution-intelligence]", {
    meeting_id: metrics.meetingId,
    stage,
    ...details
  });
}

export function logExecutionSummary(metrics: ExecutionMetrics) {
  console.info("[execution-intelligence] pipeline summary", {
    meeting_id: metrics.meetingId,
    ...metrics
  });
}
