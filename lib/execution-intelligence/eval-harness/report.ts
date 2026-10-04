import type { MeetingGroundTruth } from "./ground-truth-schema";
import type { CrossMeetingAggregate, PerMeetingMetrics } from "./metrics";
import type { GroundTruthItemTrace } from "./stage-tracer";

export type MeetingEvaluationReport = {
  schema_version: "v4-eval-harness-1";
  meeting: { id: string; title: string; generation: number; job_id: string };
  metrics: PerMeetingMetrics;
  ground_truth_results: GroundTruthItemTrace[];
};

/** Machine-readable per-meeting report -- pure data, no formatting decisions. */
export function buildMeetingReport(input: {
  groundTruth: MeetingGroundTruth;
  metrics: PerMeetingMetrics;
  traces: GroundTruthItemTrace[];
}): MeetingEvaluationReport {
  return {
    schema_version: "v4-eval-harness-1",
    meeting: {
      id: input.groundTruth.meeting_id,
      title: input.groundTruth.meeting_title,
      generation: input.metrics.generation,
      job_id: input.metrics.jobId
    },
    metrics: input.metrics,
    ground_truth_results: input.traces
  };
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function resultEmoji(result: string): string {
  switch (result) {
    case "correct":
      return "✅";
    case "partial":
      return "🟡";
    case "missed":
      return "❌";
    case "needs_review":
      return "🔎";
    default:
      return "⚠️";
  }
}

export function renderMeetingMarkdown(report: MeetingEvaluationReport): string {
  const { meeting, metrics, ground_truth_results } = report;
  const lines: string[] = [];
  lines.push(`# V4 Ground-Truth Evaluation — ${meeting.title}`);
  lines.push("");
  lines.push(`Meeting: \`${meeting.id}\` · Generation: ${meeting.generation} · Job: \`${meeting.job_id}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Active ground truth: ${metrics.activeGroundTruthTotal} (resolved: ${metrics.resolvedActiveGroundTruthTotal}, needs review: ${metrics.needsReview})`);
  lines.push(`- Correct: ${metrics.correct} · Partial: ${metrics.partial} · Missed: ${metrics.missed} · Wrong owner: ${metrics.wrongOwner} · Wrong state: ${metrics.wrongState}`);
  lines.push(`- Duplicate-flagged GT items: ${metrics.duplicateFlagged}`);
  lines.push(`- Strict active-work recall (of resolved items): **${fmtPct(metrics.strictActiveWorkRecall)}**`);
  lines.push(`- Recall including partial credit (of resolved items): ${fmtPct(metrics.recallIncludingPartial)}`);
  lines.push(`- Owner accuracy: ${fmtPct(metrics.ownerAccuracy)}`);
  lines.push(`- False-positive final active items: ${metrics.falsePositiveFinalActiveItems}`);
  lines.push(`- Duplicate active items: ${metrics.duplicateActiveItems}`);
  lines.push(`- False completion closures: ${metrics.falseCompletionClosures}`);
  if (metrics.adjudicationCoverage) {
    lines.push(
      `- Adjudication coverage: ${metrics.adjudicationCoverage.received}/${metrics.adjudicationCoverage.expected} (${metrics.adjudicationCoverage.missingAfterRetry} missing after retry)`
    );
  }
  if (metrics.lifecycleCoverage) {
    lines.push(`- Lifecycle coverage: ${metrics.lifecycleCoverage.reviewed}/${metrics.lifecycleCoverage.candidates}`);
  }
  lines.push("");
  lines.push("## Semantic judge cost/observability");
  lines.push("");
  lines.push(`- Judge calls: ${metrics.semanticJudgeCalls} · Candidates submitted: ${metrics.semanticCandidatesSubmitted}`);
  lines.push(`- Judge failures (fail-safe path): ${metrics.semanticJudgeFailures} · Retries needed: ${metrics.semanticJudgeRetries}`);
  lines.push(`- Average shortlist size: ${metrics.averageShortlistSize.toFixed(2)} · Max shortlist size: ${metrics.maxShortlistSize}`);
  lines.push("");
  lines.push("## Pipeline counts");
  lines.push("");
  const pc = metrics.pipelineCounts;
  lines.push(
    `Pass-A candidates: ${pc.passACandidates} · Pass-B add: ${pc.passBAdd} · already_represented: ${pc.passBAlreadyRepresented} · speculative/inactive: ${pc.passBSpeculativeOrInactive} · non_execution: ${pc.passBNonExecution} · deterministic dedup: ${pc.deterministicDedupRemovals} · semantic dedup: ${pc.semanticDedupRemovals} · eligible work items: ${pc.eligibleWorkItems} · final commitments: ${pc.finalCommitments} · final tasks: ${pc.finalTasks}`
  );
  lines.push("");
  lines.push("## Earliest failure stages (all ground-truth items)");
  lines.push("");
  for (const [stage, count] of Object.entries(metrics.earliestFailureStageCounts)) {
    if (count > 0) lines.push(`- ${stage}: ${count}`);
  }
  lines.push("");
  lines.push("## Ground-truth items");
  lines.push("");
  for (const trace of ground_truth_results) {
    const flags: string[] = [];
    if (trace.qualityFlags.duplicate) flags.push("duplicate");
    if (trace.qualityFlags.falseCompletion) flags.push("false_completion");
    lines.push(
      `### ${resultEmoji(trace.finalResult)} ${trace.groundTruthId} — ${trace.finalResult} (${trace.expectedState})${flags.length ? ` [${flags.join(", ")}]` : ""}`
    );
    lines.push("");
    lines.push(`Owners: ${trace.owners.join(", ")}`);
    if (trace.earliestFailureStage !== "none") lines.push(`Earliest failure stage: **${trace.earliestFailureStage}**`);
    for (const sub of trace.subOutcomes) {
      lines.push("");
      lines.push(`- Sub-outcome: "${sub.subOutcome}" — status: **${sub.subOutcomeStatus}**`);
      lines.push(`  - Initial extraction: ${sub.initialExtraction.present ? "present" : "absent"}`);
      lines.push(`  - Pass A: ${sub.passA.status}${sub.passA.candidateIds.length ? ` (${sub.passA.candidateIds.join(", ")})` : ""}`);
      lines.push(
        `  - Pass B: ${sub.passB.decisions.map((d) => `${d.candidateId}=${d.disposition}`).join(", ") || "n/a"}`
      );
      lines.push(`  - Eligible refs: ${sub.eligibility.results.filter((r) => r.eligible).map((r) => r.ref).join(", ") || "none"}`);
      lines.push(`  - Final active refs: ${sub.finalActiveRefs.join(", ") || "none"}`);
      if (sub.partialActiveRefs.length) lines.push(`  - Partial active refs: ${sub.partialActiveRefs.join(", ")}`);
      if (sub.needsReviewActiveRefs.length) lines.push(`  - Needs-review refs: ${sub.needsReviewActiveRefs.join(", ")}`);
      lines.push(
        `  - Hybrid coverage: ${sub.coverage.discoveredCount} discovered, ${sub.coverage.shortlistCount} shortlisted, ${sub.coverage.judgeCallCount} judge call(s)`
      );
      for (const c of sub.coverage.candidates) {
        const det = c.deterministicResult.matched ? `deterministic:${c.deterministicResult.confidence}` : "deterministic:none";
        const sem = c.semanticRequested && c.semanticAdjudication ? `semantic:${c.semanticAdjudication.match}` : "semantic:n/a";
        const feat = c.retrievalFeatures
          ? ` [seg=${c.retrievalFeatures.segmentOverlap},link=${c.retrievalFeatures.passLinkage},txt=${c.retrievalFeatures.textSimilarity.toFixed(2)},owner=${c.retrievalFeatures.ownerOverlap}]`
          : "";
        lines.push(`    - \`${c.ref}\` "${c.title}" — ${det} · ${sem} · final:${c.finalStatus}${feat}`);
        if (c.semanticRequested && c.semanticAdjudication) {
          lines.push(`      reason: ${c.semanticAdjudication.concise_reason}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderAggregateMarkdown(aggregate: CrossMeetingAggregate): string {
  const lines: string[] = [];
  lines.push("# V4 Cross-Meeting Ground-Truth Evaluation");
  lines.push("");
  lines.push(`Meetings evaluated: ${aggregate.meetingsEvaluated}`);
  lines.push("");
  lines.push("## Aggregate recall");
  lines.push("");
  lines.push(`- Macro strict recall (mean of per-meeting recall): ${fmtPct(aggregate.macroStrictRecall)}`);
  lines.push(`- Micro strict recall (total correct / total active): ${fmtPct(aggregate.microStrictRecall)}`);
  lines.push(`- Partial-adjusted recall: ${fmtPct(aggregate.partialAdjustedRecall)}`);
  lines.push(`- Owner accuracy: ${fmtPct(aggregate.ownerAccuracy)}`);
  lines.push(`- False positives per meeting: ${aggregate.falsePositivesPerMeeting.toFixed(2)}`);
  lines.push(`- Duplicate rate: ${fmtPct(aggregate.duplicateRate)}`);
  lines.push(`- Total false completion closures: ${aggregate.falseCompletionCount}`);
  lines.push("");
  lines.push("## Resolution status");
  lines.push("");
  lines.push(`- Total active ground truth: ${aggregate.totalActiveGroundTruth}`);
  lines.push(`- Automatically resolved (correct/partial/missed/wrong_owner/wrong_state): ${aggregate.totalResolvedActiveGroundTruth}`);
  lines.push(`- Needs manual review: ${aggregate.totalNeedsReview}`);
  lines.push(`- Duplicate-flagged GT items (any expected_state): ${aggregate.totalDuplicateFlagged}`);
  lines.push("");
  lines.push("## Earliest failure stages (aggregate)");
  lines.push("");
  for (const [stage, count] of Object.entries(aggregate.earliestFailureStageCounts)) {
    if (count > 0) lines.push(`- ${stage}: ${count}`);
  }
  lines.push("");
  lines.push("## Recurring semantic failure categories");
  lines.push("");
  for (const [category, count] of Object.entries(aggregate.semanticFailureCategoryCounts)) {
    if (count > 0) lines.push(`- ${category}: ${count}`);
  }
  lines.push("");
  lines.push("## Per-meeting breakdown");
  lines.push("");
  lines.push("| Meeting | Gen | Correct | Partial | Missed | Strict recall |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of aggregate.perMeeting) {
    lines.push(
      `| ${m.meetingTitle} | ${m.generation} | ${m.correct} | ${m.partial} | ${m.missed} | ${fmtPct(m.strictActiveWorkRecall)} |`
    );
  }
  return lines.join("\n");
}
