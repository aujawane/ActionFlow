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
  /** Temporal-completion precision (generation-8 staging benchmark follow-up): how many lifecycle
   * reviews proposed status=completed/classification=completed_work, and how each was resolved.
   * completionVerified + completionRejectedMissingEvidence + completionRejectedChronology +
   * completionRejectedVerifier should always sum to completionProposals. */
  completionProposals: number;
  completionVerified: number;
  completionRejectedMissingEvidence: number;
  completionRejectedChronology: number;
  completionRejectedVerifier: number;
  /** Lifecycle candidate-selection widening (generation-9 recall-benchmark follow-up): how many
   * candidates were admitted only because of the broadened classification/scope_state/
   * execution_scope/acceptance_state rules, and how many of those fields lifecycle actually
   * repaired. See computeLifecycleCandidateObservability in work-item-stages.ts. */
  lifecycleCandidatesConsidered: number;
  lifecycleCandidatesAdmittedViaProposal: number;
  lifecycleCandidatesAdmittedViaFutureScope: number;
  lifecycleCandidatesAdmittedViaPersonalLogistics: number;
  lifecycleCandidatesAdmittedViaProposedAcceptance: number;
  lifecycleRepairedExecutionScope: number;
  lifecycleRepairedAcceptanceState: number;
  lifecycleRepairedScopeState: number;
  /** Completeness-recovery outcome atomicity (missed-voluntary-promise recall follow-up): how many
   * additions each window proposed before grounding/dedup, how many survived grounding, how many
   * were finally accepted, and how many were dropped as duplicates (either dedup layer combined).
   * See runCompletenessRecoveryPass/dedupeCompletenessAdditions in work-item-stages.ts. */
  completenessAdditionsProposed: number;
  completenessAdditionsGrounded: number;
  completenessAdditionsAccepted: number;
  completenessAdditionsRemovedAsDuplicate: number;
  /** Two-step completeness recovery (generation-11 benchmark follow-up): PASS A (atomic action
   * harvest, ledger-blind) and PASS B (missing-work adjudication, ledger-aware) diagnostics, plus
   * the breakdown of which dedup LAYER caught a duplicate -- LAYER 1 (deterministic, exact segment
   * set) vs LAYER 2 (semantic, reused isNearDuplicateWorkItem; this is what closes the wi_g7/wi_g8
   * cross-segment leak). See runAtomicActionHarvestPass/runCompletenessAdjudicationPass/
   * semanticDedupeCompletenessAdditions in work-item-stages.ts. */
  completenessCandidatesHarvested: number;
  completenessCandidatesGroundingRejected: number;
  completenessCandidatesExpectedForAdjudication: number;
  completenessDecisionsReceived: number;
  completenessMissingCandidatesAfterRetry: number;
  completenessDecisionAdd: number;
  completenessDecisionAlreadyRepresented: number;
  completenessDecisionSpeculativeOrInactive: number;
  completenessDecisionRetrospectiveOrCompleted: number;
  completenessDecisionNonExecution: number;
  completenessDecisionInsufficientGrounding: number;
  completenessDuplicatesRemovedDeterministic: number;
  completenessDuplicatesRemovedSemantic: number;
  /** Generation-12 forensic-audit follow-up: true only if the bounded Pass-A/Pass-B diagnostic
   * trace (see PASS_A_TRACE_MAX_ENTRIES in work-item-stages.ts) hit its safety cap and had to drop
   * itemized detail -- the aggregate counts above are never affected by this, only the per-candidate
   * trace attached to the checkpoint. False for every realistic meeting size. */
  completenessTraceTruncated: boolean;
  openAiLatencyMs: Record<string, number>;
  /** Populated only for stages that returned OpenAI usage on their response; used for replay/eval
   * cost reporting (`scripts/eval-v4.ts`). Absent entries mean the SDK/mock did not report usage. */
  openAiUsage: Record<string, { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null }>;
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
    completionProposals: 0,
    completionVerified: 0,
    completionRejectedMissingEvidence: 0,
    completionRejectedChronology: 0,
    completionRejectedVerifier: 0,
    lifecycleCandidatesConsidered: 0,
    lifecycleCandidatesAdmittedViaProposal: 0,
    lifecycleCandidatesAdmittedViaFutureScope: 0,
    lifecycleCandidatesAdmittedViaPersonalLogistics: 0,
    lifecycleCandidatesAdmittedViaProposedAcceptance: 0,
    lifecycleRepairedExecutionScope: 0,
    lifecycleRepairedAcceptanceState: 0,
    lifecycleRepairedScopeState: 0,
    completenessAdditionsProposed: 0,
    completenessAdditionsGrounded: 0,
    completenessAdditionsAccepted: 0,
    completenessAdditionsRemovedAsDuplicate: 0,
    completenessCandidatesHarvested: 0,
    completenessCandidatesGroundingRejected: 0,
    completenessCandidatesExpectedForAdjudication: 0,
    completenessDecisionsReceived: 0,
    completenessMissingCandidatesAfterRetry: 0,
    completenessDecisionAdd: 0,
    completenessDecisionAlreadyRepresented: 0,
    completenessDecisionSpeculativeOrInactive: 0,
    completenessDecisionRetrospectiveOrCompleted: 0,
    completenessDecisionNonExecution: 0,
    completenessDecisionInsufficientGrounding: 0,
    completenessDuplicatesRemovedDeterministic: 0,
    completenessDuplicatesRemovedSemantic: 0,
    completenessTraceTruncated: false,
    openAiLatencyMs: {},
    openAiUsage: {}
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
