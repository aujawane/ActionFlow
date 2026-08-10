/**
 * Non-persisting Execution Intelligence V4 replay/evaluation command.
 *
 * Runs the exact production V4 pipeline stage functions (v4-pipeline.ts) against a stored
 * transcript fixture, without ever writing to Supabase, incrementing a meeting's analysis
 * generation, or mutating an existing task/commitment row. Every stage's output is written to
 * disk as a schema-versioned artifact so a downstream change (e.g. to consolidation) can be
 * re-verified via `--resume-from` without re-paying for upstream model calls.
 *
 * Usage:
 *   npm run eval:v4 -- --fixture tests/fixtures/<fixture>.json [--output DIR]
 *     [--resume-from work-items|reconciliation|grouping|verification|assembly|consolidation]
 *     [--allow-model-calls] [--persist=false]
 *
 * By default (no --allow-model-calls) this refuses to call OpenAI for any stage that isn't
 * already cached in --output, so re-running the command never silently spends money.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { evaluateChatterGate } from "../lib/execution-intelligence/gates/chatter-gate";
import { evaluateWebsiteGate } from "../lib/execution-intelligence/gates/website-gate";
import { semanticTokenSimilarity } from "../lib/execution-intelligence/graph";
import type { ExecutionSourceContext } from "../lib/execution-intelligence/stages";
import {
  finalizeV4Execution,
  runV4GlobalCorrection,
  runV4Grouping,
  runV4GroupingVerification,
  runV4TaskConsolidation,
  runV4TreeAssembly,
  runV4WorkItemExtraction,
  type V4ExecutionState
} from "../lib/execution-intelligence/v4-pipeline";
import { buildCanonicalTranscriptWithSegmentIds, type TranscriptTextSegment } from "../lib/transcript-order";

const STAGE_ORDER = [
  "work-items",
  "reconciliation",
  "grouping",
  "verification",
  "assembly",
  "consolidation"
] as const;
type Stage = (typeof STAGE_ORDER)[number];

/** Only these stages ever call OpenAI; `assembly` is pure deterministic assembly. */
const MODEL_STAGES = new Set<Stage>(["work-items", "reconciliation", "grouping", "verification", "consolidation"]);

const CACHE_SCHEMA_VERSION = "v4-eval-cache-1";

type FixtureSegment = TranscriptTextSegment;

type Fixture = {
  version?: string;
  meetingId: string;
  meetingDate: string;
  project?: ExecutionSourceContext["project"];
  /** Preferred: structured, canonically-orderable segments (mirrors transcript_segments rows).
   * Built into the transcript via the exact same `buildCanonicalTranscriptWithSegmentIds` call
   * production's topics.ts uses, so a fixture can never silently diverge from real ordering. */
  segments?: FixtureSegment[];
  /** Legacy: a pre-built transcript string, used as-is when `segments` is absent. */
  transcript?: string;
  gate?: "chatter" | "website";
  expected?: {
    commitment_titles?: string[];
    excluded_phrases?: string[];
  };
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = true;
    }
  }
  return out;
}

function fail(message: string): never {
  console.error(`[eval:v4] ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const fixtureArg = args.fixture;
if (typeof fixtureArg !== "string") {
  fail(
    "Usage: eval:v4 -- --fixture <path> [--output DIR] [--resume-from <stage>] [--allow-model-calls] [--persist=false]"
  );
}

const persistArg = args.persist === undefined ? "false" : String(args.persist);
if (persistArg !== "false") {
  fail(
    "eval:v4 is a non-persisting command by design -- it never writes to Supabase. --persist must be false (or omitted). Use the normal analysis pipeline for a persistent run."
  );
}

const allowModelCalls = args["allow-model-calls"] === true || args["allow-model-calls"] === "true";

const resumeFromArg = args["resume-from"];
let resumeFrom: Stage | undefined;
if (resumeFromArg !== undefined) {
  if (typeof resumeFromArg !== "string" || !(STAGE_ORDER as readonly string[]).includes(resumeFromArg)) {
    fail(`--resume-from must be one of: ${STAGE_ORDER.join(", ")}`);
  }
  resumeFrom = resumeFromArg as Stage;
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(String(args.output ?? `.tmp/v4-evals/${runId}`));
mkdirSync(outputDir, { recursive: true });

const fixturePath = path.resolve(fixtureArg as string);
if (!existsSync(fixturePath)) fail(`Fixture not found: ${fixturePath}`);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
if (!fixture.meetingId || (!fixture.segments && !fixture.transcript)) {
  fail("Fixture must include meetingId, meetingDate, and either `segments` or `transcript`.");
}
if (fixture.segments && fixture.segments.length > 0) {
  const missingId = fixture.segments.find((segment) => !segment.id);
  if (missingId) fail("Every fixture segment must have an `id` (a real UUID or a deterministic fixture-only id).");
}
// The exact same function production's topics.ts uses to build ExecutionSourceContext.transcript
// -- a structured fixture can never silently diverge from real canonical ordering.
const transcript = fixture.segments
  ? buildCanonicalTranscriptWithSegmentIds(fixture.segments)
  : (fixture.transcript as string);

const source: ExecutionSourceContext = {
  meetingId: fixture.meetingId,
  meetingDate: fixture.meetingDate,
  transcript,
  topics: [],
  insights: [],
  project: fixture.project ?? null
};

function cachePath(stage: Stage) {
  return path.join(outputDir, `state-after-${stage}.json`);
}

function saveStage(stage: Stage, state: V4ExecutionState) {
  writeFileSync(
    cachePath(stage),
    JSON.stringify(
      { schema_version: CACHE_SCHEMA_VERSION, stage, generated_at: new Date().toISOString(), state },
      null,
      2
    )
  );
}

function loadStage(stage: Stage): V4ExecutionState {
  const cache = cachePath(stage);
  if (!existsSync(cache)) {
    fail(
      `--resume-from requires a cached "${stage}" artifact at ${cache}, but none exists. Run once without --resume-from first (with --allow-model-calls) to build the cache.`
    );
  }
  const raw = JSON.parse(readFileSync(cache, "utf8")) as { schema_version: string; state: V4ExecutionState };
  if (raw.schema_version !== CACHE_SCHEMA_VERSION) {
    fail(
      `Cached "${stage}" artifact has schema_version "${raw.schema_version}", expected "${CACHE_SCHEMA_VERSION}". Re-run without --resume-from to regenerate the cache.`
    );
  }
  return raw.state;
}

const STAGE_RUNNERS: Record<Stage, (state: V4ExecutionState | undefined) => Promise<V4ExecutionState>> = {
  "work-items": () => runV4WorkItemExtraction({ source, fallbackUsed: false }),
  reconciliation: (state) => runV4GlobalCorrection(state as V4ExecutionState),
  grouping: (state) => runV4Grouping(state as V4ExecutionState),
  verification: (state) => runV4GroupingVerification(state as V4ExecutionState),
  assembly: (state) => runV4TreeAssembly(state as V4ExecutionState),
  consolidation: (state) => runV4TaskConsolidation(state as V4ExecutionState)
};

function normalizeTitle(value: string) {
  return value.trim().toLowerCase();
}

/** Loose match: exact substring either direction, or high token overlap -- real commitment
 * titles are model-generated paraphrases of the expected label, never verbatim copies. */
function looselyMatches(a: string, b: string) {
  const normA = normalizeTitle(a);
  const normB = normalizeTitle(b);
  if (normA.includes(normB) || normB.includes(normA)) return true;
  return semanticTokenSimilarity(a, b) >= 0.35;
}

/** Simple expected-vs-actual comparison; only runs when the fixture supplies `expected`. */
function compareExpectedVsActual(state: V4ExecutionState) {
  const expected = fixture.expected;
  if (!expected) return null;

  const actualTitles = state.tree.commitments.map((c) => c.title);
  const missingCommitments = (expected.commitment_titles ?? []).filter(
    (title) => !actualTitles.some((actual) => looselyMatches(actual, title))
  );
  const falseCommitments = (expected.commitment_titles ?? []).length
    ? actualTitles.filter((actual) => !(expected.commitment_titles ?? []).some((title) => looselyMatches(actual, title)))
    : [];

  const allTaskTitles = [
    ...state.tree.commitments.flatMap((c) => c.tasks.map((t) => t.title)),
    ...state.tree.standalone_tasks.map((t) => t.title)
  ];
  const duplicateTasks: string[] = [];
  for (let i = 0; i < allTaskTitles.length; i += 1) {
    for (let j = i + 1; j < allTaskTitles.length; j += 1) {
      if (semanticTokenSimilarity(allTaskTitles[i], allTaskTitles[j]) >= 0.85) {
        duplicateTasks.push(`"${allTaskTitles[i]}" ~ "${allTaskTitles[j]}"`);
      }
    }
  }

  const allActiveTitles = [...actualTitles, ...allTaskTitles];
  const excludedViolations = (expected.excluded_phrases ?? []).filter((phrase) =>
    allActiveTitles.some((title) => normalizeTitle(title).includes(normalizeTitle(phrase)))
  );

  return { missingCommitments, falseCommitments, duplicateTasks, excludedViolations };
}

async function main() {
  const startIndex = resumeFrom ? STAGE_ORDER.indexOf(resumeFrom) : 0;
  let state: V4ExecutionState | undefined =
    startIndex > 0 ? loadStage(STAGE_ORDER[startIndex - 1]) : undefined;

  const stageTimings: Record<string, number> = {};

  for (let i = startIndex; i < STAGE_ORDER.length; i += 1) {
    const stage = STAGE_ORDER[i];
    if (MODEL_STAGES.has(stage) && !allowModelCalls) {
      fail(
        `Stage "${stage}" calls OpenAI and no cached artifact was requested via --resume-from. Pass --allow-model-calls to actually run it, or --resume-from a later cached stage to skip it.`
      );
    }
    console.info(`[eval:v4] running stage: ${stage}`);
    const before = Date.now();
    state = await STAGE_RUNNERS[stage](state);
    const elapsed = Date.now() - before;
    stageTimings[stage] = elapsed;
    console.info(`[eval:v4] stage "${stage}" complete in ${elapsed}ms`);
    saveStage(stage, state);
  }

  // Phase 6 (final validation + trace) is deterministic -- always safe to run, never gated.
  state = await finalizeV4Execution(state as V4ExecutionState);
  writeFileSync(path.join(outputDir, "trace.json"), JSON.stringify(state.debugTrace, null, 2));

  const usageReport = {
    stage_latency_ms: { ...state.metrics.openAiLatencyMs, ...stageTimings },
    stage_token_usage: state.metrics.openAiUsage,
    validation_failures: state.metrics.validationFailures,
    salvaged_items: state.metrics.salvagedItems
  };
  writeFileSync(path.join(outputDir, "usage-report.json"), JSON.stringify(usageReport, null, 2));

  const comparison = compareExpectedVsActual(state);
  const gateResult =
    fixture.gate === "chatter"
      ? evaluateChatterGate(state.tree)
      : fixture.gate === "website"
        ? evaluateWebsiteGate({
            tree: state.tree,
            futureScopeItems: state.debugTrace?.future_scope_items ?? [],
            excludedWorkItems: state.debugTrace?.excluded_work_items ?? []
          })
        : null;

  const commitmentCount = state.tree.commitments.length;
  const childTaskCount = state.tree.commitments.reduce((sum, c) => sum + c.tasks.length, 0);
  const standaloneCount = state.tree.standalone_tasks.length;
  const futureScopeCount = state.debugTrace?.future_scope_items.length ?? 0;

  // The generic commitment_titles comparison is loose-match best-effort context, not an
  // authoritative pass/fail signal: model-written titles are paraphrases, not copies, and a
  // stricter per-fixture gate (when the fixture declares one, e.g. `gate: "chatter"`) is the real
  // go/no-go check. `excluded_phrases` and `duplicate_tasks` ARE authoritative either way -- those
  // are never expected to legitimately appear.
  const pass =
    state.finalValidation.ok &&
    (comparison ? comparison.duplicateTasks.length === 0 && comparison.excludedViolations.length === 0 : true) &&
    (gateResult
      ? gateResult.ok
      : comparison
        ? comparison.missingCommitments.length === 0 && comparison.falseCommitments.length === 0
        : true);

  const summary = {
    fixture: fixturePath,
    meeting_id: fixture.meetingId,
    output_dir: outputDir,
    resumed_from: resumeFrom ?? null,
    final_validation: state.finalValidation,
    commitments_actual: commitmentCount,
    commitments_expected: fixture.expected?.commitment_titles?.length ?? null,
    child_tasks_actual: childTaskCount,
    standalone_tasks_actual: standaloneCount,
    future_scope_actual: futureScopeCount,
    false_commitments: comparison?.falseCommitments ?? [],
    missing_commitments: comparison?.missingCommitments ?? [],
    duplicate_tasks: comparison?.duplicateTasks ?? [],
    excluded_item_violations: comparison?.excludedViolations ?? [],
    gate: fixture.gate ?? null,
    gate_failures: gateResult?.failures ?? [],
    gate_notes: gateResult?.notes ?? [],
    pass
  };
  writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.info("\n[eval:v4] ==================== SUMMARY ====================");
  console.info(`Fixture:              ${fixturePath}`);
  console.info(`Output:               ${outputDir}`);
  console.info(`Final validation:     ${state.finalValidation.ok ? "ok" : `FAILED (${state.finalValidation.errors.join("; ")})`}`);
  console.info(`Commitments:          ${commitmentCount} actual${summary.commitments_expected != null ? ` / ${summary.commitments_expected} expected` : ""}`);
  console.info(`Child tasks:          ${childTaskCount}`);
  console.info(`Standalone tasks:     ${standaloneCount}`);
  console.info(`Future scope items:   ${futureScopeCount}`);
  console.info(`False commitments:    ${summary.false_commitments.length ? summary.false_commitments.join(", ") : "none"}`);
  console.info(`Missing commitments:  ${summary.missing_commitments.length ? summary.missing_commitments.join(", ") : "none"}`);
  console.info(`Duplicate tasks:      ${summary.duplicate_tasks.length ? summary.duplicate_tasks.join(", ") : "none"}`);
  console.info(`Excluded violations:  ${summary.excluded_item_violations.length ? summary.excluded_item_violations.join(", ") : "none"}`);
  if (gateResult) {
    console.info(`Gate (${fixture.gate}):        ${gateResult.ok ? "PASS" : "FAIL"}`);
    for (const failure of gateResult.failures) console.info(`  - [${failure.rule}] ${failure.detail}`);
  }
  console.info(`PASS/FAIL:            ${pass ? "PASS" : "FAIL"}`);
  console.info("===================================================\n");

  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error("[eval:v4] fatal error:", error);
  process.exit(1);
});
