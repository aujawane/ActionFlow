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
  salvagedItems: number;
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
    salvagedItems: 0,
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

export function logExecutionModelEvent(input: {
  stage: string;
  event: "failure" | "retry" | "success" | "timeout" | "validation_failure";
  attempt: number;
  maxAttempts: number;
  timeoutMs?: number;
  elapsedMs?: number;
  requestStartedAt?: string;
  requestEndedAt?: string;
  details?: string;
}) {
  console.info("[execution-intelligence]", {
    stage: input.stage,
    event: input.event,
    attempt: input.attempt,
    max_attempts: input.maxAttempts,
    timeout_ms: input.timeoutMs,
    elapsed_ms: input.elapsedMs,
    request_started_at: input.requestStartedAt,
    request_ended_at: input.requestEndedAt,
    details: input.details
  });
}

export function logExecutionCandidateDiagnostics(
  details: Record<string, unknown>
) {
  console.info("[execution-intelligence] candidate diagnostics", details);
}

export function logExecutionBatchDiagnostics(
  stage: string,
  details: Record<string, unknown>
) {
  console.info("[execution-intelligence] batch diagnostics", {
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
