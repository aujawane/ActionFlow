/**
 * Runs the CURRENT, UNMODIFIED V4 pipeline against all five frozen synthetic benchmark meetings
 * (tests/fixtures/v4-eval/synthetic/*) and evaluates each against its frozen ground truth using
 * the existing eval-harness (lib/execution-intelligence/eval-harness/*). Never persists anything --
 * see local-run-adapter.ts for why no Supabase round trip is needed. Never modifies V4 behavior:
 * this script only calls existing, unaltered v4-pipeline.ts functions and existing, unaltered
 * eval-harness scoring functions.
 *
 * Usage:
 *   npx tsx scripts/eval-v4-synthetic-benchmark.ts
 *
 * Always calls OpenAI (there is no deterministic-only mode for actually RUNNING V4 -- unlike
 * scripts/eval-v4-ground-truth.ts's optional semantic adjudication, extraction itself always
 * requires the model). Raw per-meeting state/trace/snapshot artifacts are written to
 * .tmp/v4-eval-synthetic-runs/<meeting>/ (gitignored) for independent audit. The final report is
 * written to docs/v4-eval/synthetic-final/ (untracked, per this repo's existing convention for
 * benchmark docs).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { runV4PipelineLocally } from "../lib/execution-intelligence/eval-harness/local-run-adapter";
import { parseMeetingGroundTruth, type MeetingGroundTruth } from "../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { traceGroundTruthItem, type GroundTruthItemTrace } from "../lib/execution-intelligence/eval-harness/stage-tracer";
import { computePerMeetingMetrics, aggregateAcrossMeetings, type PerMeetingMetrics } from "../lib/execution-intelligence/eval-harness/metrics";
import { runBatchSemanticAdjudication } from "../lib/execution-intelligence/eval-harness/semantic-judge";
import type { MeetingSnapshot } from "../lib/execution-intelligence/eval-harness/snapshot";

const SYNTHETIC_DIR = path.resolve(process.cwd(), "tests/fixtures/v4-eval/synthetic");
const RUN_ARTIFACT_DIR = path.resolve(process.cwd(), ".tmp/v4-eval-synthetic-runs");
const REPORT_DIR = path.resolve(process.cwd(), "docs/v4-eval/synthetic-final");

const MEETING_DIRS = [
  "meeting-01-status",
  "meeting-02-debugging",
  "meeting-03-brainstorm",
  "meeting-04-handoff",
  "meeting-05-messy"
] as const;

type MeetingModule = {
  dir: string;
  meetingId: string;
  meetingTitle: string;
  participants: string[];
  transcriptSegments: Array<{ id: string; index: number; timestamp: string; speaker: string; text: string }>;
  groundTruth: MeetingGroundTruth;
};

async function loadMeeting(dir: string): Promise<MeetingModule> {
  const transcriptMod = await import(path.join(SYNTHETIC_DIR, dir, "transcript.ts"));
  const groundTruthMod = await import(path.join(SYNTHETIC_DIR, dir, "ground-truth.ts"));
  const groundTruth = parseMeetingGroundTruth(groundTruthMod.default);
  return {
    dir,
    meetingId: transcriptMod.meetingId,
    meetingTitle: transcriptMod.meetingTitle,
    participants: transcriptMod.participants,
    transcriptSegments: transcriptMod.transcriptSegments,
    groundTruth
  };
}

type MeetingRunResult = {
  meeting: MeetingModule;
  snapshot: MeetingSnapshot;
  traces: GroundTruthItemTrace[];
  metrics: PerMeetingMetrics;
  retried: boolean;
  technicalFailures: string[];
};

async function runOneMeeting(meeting: MeetingModule): Promise<MeetingRunResult> {
  const meetingDate = meeting.transcriptSegments[0]?.timestamp ?? new Date().toISOString();
  const technicalFailures: string[] = [];
  let retried = false;

  let runOutcome: Awaited<ReturnType<typeof runV4PipelineLocally>> | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      runOutcome = await runV4PipelineLocally({
        meetingId: meeting.meetingId,
        meetingDate,
        transcriptSegments: meeting.transcriptSegments
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      technicalFailures.push(`attempt ${attempt}: ${message}`);
      console.error(`[eval:v4:synthetic] ${meeting.dir} attempt ${attempt} failed technically: ${message}`);
      if (attempt === 1) {
        retried = true;
        continue;
      }
      throw new Error(`${meeting.dir} failed twice technically -- see technicalFailures: ${JSON.stringify(technicalFailures)}`);
    }
  }
  if (!runOutcome) throw new Error(`${meeting.dir}: no run outcome produced`);

  const artifactDir = path.join(RUN_ARTIFACT_DIR, meeting.dir);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, "snapshot.json"), JSON.stringify(runOutcome.snapshot, null, 2));
  writeFileSync(path.join(artifactDir, "debug-trace.json"), JSON.stringify(runOutcome.state.debugTrace ?? null, null, 2));
  writeFileSync(path.join(artifactDir, "final-validation.json"), JSON.stringify(runOutcome.state.finalValidation, null, 2));

  const traces: GroundTruthItemTrace[] = [];
  for (const item of meeting.groundTruth.ground_truth) {
    traces.push(await traceGroundTruthItem(item, runOutcome.snapshot, (request) => runBatchSemanticAdjudication(request)));
  }
  writeFileSync(path.join(artifactDir, "ground-truth-traces.json"), JSON.stringify(traces, null, 2));

  const metrics = computePerMeetingMetrics({ groundTruth: meeting.groundTruth, snapshot: runOutcome.snapshot, traces });

  return { meeting, snapshot: runOutcome.snapshot, traces, metrics, retried, technicalFailures };
}

// ---------------------------------------------------------------------------
// Extra, report-specific analysis beyond PerMeetingMetrics (negative audit, completion audit,
// compound audit, earliest-failure-stage -> GT id mapping). Pure read-only analysis of the traces
// already produced above -- never re-scores anything differently than stage-tracer.ts already did.
// ---------------------------------------------------------------------------

function negativeAudit(traces: GroundTruthItemTrace[]) {
  const negatives = traces.filter((t) => t.expectedState === "negative");
  const falsePositives = negatives.filter((t) => t.finalResult === "wrong_state");
  const correctlyIgnored = negatives.filter((t) => t.finalResult === "correct");
  const other = negatives.filter((t) => t.finalResult !== "wrong_state" && t.finalResult !== "correct");
  return { total: negatives.length, correctlyIgnored: correctlyIgnored.length, falsePositives, other };
}

function completionAudit(traces: GroundTruthItemTrace[]) {
  const completed = traces.filter((t) => t.expectedState === "completed_during_meeting");
  const correctlyClosed = completed.filter((t) => t.finalResult === "correct");
  const leftActive = completed.filter((t) => t.finalResult === "wrong_state");
  const missedEntirely = completed.filter((t) => t.finalResult === "missed" || t.finalResult === "partial");
  const needsReview = completed.filter((t) => t.finalResult === "needs_review");
  return { total: completed.length, correctlyClosed, leftActive, missedEntirely, needsReview };
}

function compoundAudit(traces: GroundTruthItemTrace[]) {
  const compounds = traces.filter((t) => t.isCompound);
  const fullyRecovered = compounds.filter((t) => t.finalResult === "correct");
  const partiallyRecovered = compounds.filter((t) => t.finalResult === "partial");
  const missedSubOutcomes = compounds.flatMap((t) =>
    t.subOutcomes.filter((s) => s.subOutcomeStatus === "unmatched").map((s) => `${t.groundTruthId}: ${s.subOutcome}`)
  );
  return { total: compounds.length, fullyRecovered: fullyRecovered.length, partiallyRecovered: partiallyRecovered.length, missedSubOutcomes };
}

function earliestFailureStageBreakdown(allResults: MeetingRunResult[]) {
  const byStage = new Map<string, string[]>();
  for (const result of allResults) {
    for (const trace of result.traces) {
      if (trace.earliestFailureStage === "none") continue;
      const key = trace.earliestFailureStage;
      const gtRef = `${result.meeting.dir}:${trace.groundTruthId}`;
      byStage.set(key, [...(byStage.get(key) ?? []), gtRef]);
    }
  }
  return byStage;
}

function recurringFailureClasses(stageBreakdown: Map<string, string[]>) {
  const recurring: Array<{ stage: string; refs: string[]; meetingCount: number }> = [];
  for (const [stage, refs] of stageBreakdown.entries()) {
    const meetings = new Set(refs.map((r) => r.split(":")[0]));
    if (meetings.size >= 2) recurring.push({ stage, refs, meetingCount: meetings.size });
  }
  return recurring;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMeetingReport(result: MeetingRunResult): string {
  const { meeting, metrics, traces } = result;
  const lines: string[] = [];
  lines.push(`# Synthetic V4 Benchmark — ${meeting.meetingTitle}`);
  lines.push("");
  lines.push(`Meeting dir: \`${meeting.dir}\` · meeting_id: \`${meeting.meetingId}\``);
  if (result.retried) lines.push(`\n**Technical retry occurred.** Failures: ${JSON.stringify(result.technicalFailures)}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Active GT: ${metrics.activeGroundTruthTotal} (resolved: ${metrics.resolvedActiveGroundTruthTotal}, needs review: ${metrics.needsReview})`);
  lines.push(`- Correct: ${metrics.correct} · Partial: ${metrics.partial} · Missed: ${metrics.missed} · Wrong owner: ${metrics.wrongOwner} · Wrong state: ${metrics.wrongState}`);
  lines.push(`- Strict recall: **${fmtPct(metrics.strictActiveWorkRecall)}** · Partial-adjusted recall: ${fmtPct(metrics.recallIncludingPartial)}`);
  lines.push(`- Owner accuracy: ${fmtPct(metrics.ownerAccuracy)}`);
  lines.push(`- Duplicate-flagged GT items: ${metrics.duplicateFlagged} · False completion closures: ${metrics.falseCompletionClosures}`);
  lines.push(`- Semantic judge: ${metrics.semanticJudgeCalls} calls, ${metrics.semanticCandidatesSubmitted} candidates, ${metrics.semanticJudgeFailures} failures`);
  lines.push("");

  const neg = negativeAudit(traces);
  lines.push("## Negative precision");
  lines.push("");
  lines.push(`- Negative GT total: ${neg.total}`);
  lines.push(`- Correctly ignored: ${neg.correctlyIgnored}`);
  lines.push(`- False positives (V4 produced active work): ${neg.falsePositives.length}`);
  for (const fp of neg.falsePositives) lines.push(`  - ${fp.groundTruthId}: ${fp.subOutcomes.map((s) => s.subOutcome).join("; ")}`);
  if (neg.other.length) lines.push(`- Other (needs_review/partial, not a clean false positive): ${neg.other.map((t) => `${t.groundTruthId}=${t.finalResult}`).join(", ")}`);
  lines.push("");

  const comp = completionAudit(traces);
  if (comp.total > 0) {
    lines.push("## Completion safety");
    lines.push("");
    lines.push(`- completed_during_meeting GT total: ${comp.total}`);
    lines.push(`- Correctly closed: ${comp.correctlyClosed.length} (${comp.correctlyClosed.map((t) => t.groundTruthId).join(", ") || "none"})`);
    lines.push(`- Left active (false open): ${comp.leftActive.length} (${comp.leftActive.map((t) => t.groundTruthId).join(", ") || "none"})`);
    lines.push(`- Missed entirely: ${comp.missedEntirely.length} (${comp.missedEntirely.map((t) => t.groundTruthId).join(", ") || "none"})`);
    lines.push(`- Needs review: ${comp.needsReview.length} (${comp.needsReview.map((t) => t.groundTruthId).join(", ") || "none"})`);
    lines.push("");
  }

  const cmpd = compoundAudit(traces);
  if (cmpd.total > 0) {
    lines.push("## Compound work");
    lines.push("");
    lines.push(`- Compound GT total: ${cmpd.total}`);
    lines.push(`- Fully recovered: ${cmpd.fullyRecovered}`);
    lines.push(`- Partially recovered: ${cmpd.partiallyRecovered}`);
    lines.push(`- Missed sub-outcomes: ${cmpd.missedSubOutcomes.join("; ") || "none"}`);
    lines.push("");
  }

  lines.push("## Per-item detail");
  lines.push("");
  for (const trace of traces) {
    const flags: string[] = [];
    if (trace.qualityFlags.duplicate) flags.push("duplicate");
    if (trace.qualityFlags.falseCompletion) flags.push("false_completion");
    lines.push(`### ${trace.groundTruthId} — ${trace.finalResult} (${trace.expectedState})${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    lines.push(`Earliest failure stage: **${trace.earliestFailureStage}**`);
    for (const sub of trace.subOutcomes) {
      lines.push(`- "${sub.subOutcome}" -> status: ${sub.subOutcomeStatus}, discovered=${sub.coverage.discoveredCount}, shortlist=${sub.coverage.shortlistCount}, judgeCalls=${sub.coverage.judgeCallCount}`);
      for (const c of sub.coverage.candidates) {
        const sem = c.semanticAdjudication ? `${c.semanticAdjudication.match} (${c.semanticAdjudication.concise_reason})` : "n/a";
        lines.push(`  - \`${c.ref}\` "${c.title}" — det:${c.deterministicResult.matched ? c.deterministicResult.confidence : "none"} · sem:${sem} · final:${c.finalStatus} · eligible:${c.eligible} · inFinal:${c.foundInFinalOutput}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  mkdirSync(RUN_ARTIFACT_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });

  const meetings = await Promise.all(MEETING_DIRS.map((dir) => loadMeeting(dir)));

  const results: MeetingRunResult[] = [];
  for (const meeting of meetings) {
    console.info(`\n[eval:v4:synthetic] ===== running ${meeting.dir} =====`);
    const result = await runOneMeeting(meeting);
    results.push(result);
    console.info(
      `[eval:v4:synthetic] ${meeting.dir}: ${result.metrics.correct}/${result.metrics.activeGroundTruthTotal} correct, ` +
        `${result.metrics.partial} partial, ${result.metrics.missed} missed, ${result.metrics.needsReview} needs_review`
    );
    const meetingReportPath = path.join(REPORT_DIR, `${meeting.dir.replace(/^meeting-0?/, "meeting-")}.md`);
    writeFileSync(meetingReportPath, renderMeetingReport(result));
  }

  const aggregate = aggregateAcrossMeetings(
    results.map((r) => ({ groundTruth: r.meeting.groundTruth, snapshot: r.snapshot, traces: r.traces, metrics: r.metrics }))
  );

  const stageBreakdown = earliestFailureStageBreakdown(results);
  const recurring = recurringFailureClasses(stageBreakdown);

  const allTraces = results.flatMap((r) => r.traces);
  const neg = negativeAudit(allTraces);
  const comp = completionAudit(allTraces);
  const cmpd = compoundAudit(allTraces);

  const aggregateJson = {
    perMeeting: results.map((r) => ({ dir: r.meeting.dir, metrics: r.metrics, technicalFailures: r.technicalFailures, retried: r.retried })),
    aggregate,
    negativeAudit: { total: neg.total, correctlyIgnored: neg.correctlyIgnored, falsePositives: neg.falsePositives.map((t) => `${t.groundTruthId}`) },
    completionAudit: {
      total: comp.total,
      correctlyClosed: comp.correctlyClosed.map((t) => t.groundTruthId),
      leftActive: comp.leftActive.map((t) => t.groundTruthId),
      missedEntirely: comp.missedEntirely.map((t) => t.groundTruthId),
      needsReview: comp.needsReview.map((t) => t.groundTruthId)
    },
    compoundAudit: cmpd,
    earliestFailureStageBreakdown: Object.fromEntries(stageBreakdown),
    recurringFailureClasses: recurring
  };
  writeFileSync(path.join(REPORT_DIR, "aggregate.json"), JSON.stringify(aggregateJson, null, 2));

  const aggLines: string[] = [];
  aggLines.push("# Synthetic V4 Benchmark — Aggregate (5 meetings)");
  aggLines.push("");
  aggLines.push(`Meetings evaluated: ${aggregate.meetingsEvaluated}`);
  aggLines.push("");
  aggLines.push("## Aggregate recall");
  aggLines.push("");
  aggLines.push(`- Macro strict recall: ${fmtPct(aggregate.macroStrictRecall)}`);
  aggLines.push(`- Micro strict recall: ${fmtPct(aggregate.microStrictRecall)}`);
  aggLines.push(`- Partial-adjusted recall: ${fmtPct(aggregate.partialAdjustedRecall)}`);
  aggLines.push(`- Owner accuracy: ${fmtPct(aggregate.ownerAccuracy)}`);
  aggLines.push(`- Total active GT: ${aggregate.totalActiveGroundTruth} (resolved: ${aggregate.totalResolvedActiveGroundTruth})`);
  aggLines.push(`- Total needs_review: ${aggregate.totalNeedsReview}`);
  aggLines.push(`- Total duplicate-flagged: ${aggregate.totalDuplicateFlagged}`);
  aggLines.push(`- Total false completion closures: ${aggregate.falseCompletionCount}`);
  aggLines.push("");
  aggLines.push("## Negative precision");
  aggLines.push("");
  aggLines.push(`- Negative GT total: ${neg.total}`);
  aggLines.push(`- Correctly ignored: ${neg.correctlyIgnored} (${fmtPct(neg.total === 0 ? 1 : neg.correctlyIgnored / neg.total)})`);
  aggLines.push(`- False positives: ${neg.falsePositives.length}`);
  for (const fp of neg.falsePositives) aggLines.push(`  - ${fp.groundTruthId}`);
  aggLines.push("");
  aggLines.push("## Completion accuracy");
  aggLines.push("");
  aggLines.push(`- completed_during_meeting total: ${comp.total}`);
  aggLines.push(`- Correctly handled: ${comp.correctlyClosed.length}/${comp.total}`);
  aggLines.push(`- Left active: ${comp.leftActive.map((t) => t.groundTruthId).join(", ") || "none"}`);
  aggLines.push(`- Missed entirely: ${comp.missedEntirely.map((t) => t.groundTruthId).join(", ") || "none"}`);
  aggLines.push("");
  aggLines.push("## Compound work");
  aggLines.push("");
  aggLines.push(`- Compound GT total: ${cmpd.total}, fully recovered: ${cmpd.fullyRecovered}, partially recovered: ${cmpd.partiallyRecovered}`);
  aggLines.push(`- Missed sub-outcomes: ${cmpd.missedSubOutcomes.join("; ") || "none"}`);
  aggLines.push("");
  aggLines.push("## Earliest failure stage breakdown");
  aggLines.push("");
  for (const [stage, refs] of stageBreakdown.entries()) {
    aggLines.push(`- **${stage}** (${refs.length}): ${refs.join(", ")}`);
  }
  aggLines.push("");
  aggLines.push("## Recurring failure classes (2+ independent meetings)");
  aggLines.push("");
  if (recurring.length === 0) {
    aggLines.push("None found -- every failure stage's affected GT items trace back to a single meeting.");
  } else {
    for (const r of recurring) aggLines.push(`- **${r.stage}** across ${r.meetingCount} meetings: ${r.refs.join(", ")}`);
  }
  aggLines.push("");
  aggLines.push("## Per-meeting breakdown");
  aggLines.push("");
  aggLines.push("| Meeting | Active GT | Correct | Partial | Missed | Strict recall | Needs review |");
  aggLines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    aggLines.push(
      `| ${r.meeting.dir} | ${r.metrics.activeGroundTruthTotal} | ${r.metrics.correct} | ${r.metrics.partial} | ${r.metrics.missed} | ${fmtPct(r.metrics.strictActiveWorkRecall)} | ${r.metrics.needsReview} |`
    );
  }
  writeFileSync(path.join(REPORT_DIR, "aggregate.md"), aggLines.join("\n"));

  console.info(`\n[eval:v4:synthetic] reports written to ${REPORT_DIR}`);
  console.info(`[eval:v4:synthetic] raw run artifacts written to ${RUN_ARTIFACT_DIR}`);
}

main().catch((error) => {
  console.error("[eval:v4:synthetic] fatal error:", error);
  process.exit(1);
});
