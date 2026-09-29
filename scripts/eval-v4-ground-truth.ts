/**
 * READ-ONLY multi-meeting ground-truth evaluator for completed V4 analysis generations.
 *
 * Unlike scripts/eval-v4.ts (which RE-RUNS the pipeline against a fixture transcript, optionally
 * calling OpenAI), this command never calls the model and never re-runs anything -- it reads an
 * already-completed job's persisted checkpoint straight out of Supabase, traces each frozen
 * ground-truth item through it (initial extraction -> Pass A -> Pass B -> WorkItem fields ->
 * lifecycle -> eligibility -> downstream/persistence), and reports correct/partial/missed/
 * wrong_owner/wrong_state/duplicate plus the earliest failure stage for anything that didn't fully
 * succeed. See lib/execution-intelligence/eval-harness/ for the actual evaluation logic.
 *
 * Usage:
 *   npm run eval:v4:ground-truth -- --meeting craig-aug19 --generation 13
 *   npm run eval:v4:ground-truth -- --meeting craig-aug19 --job <job-id>
 *   npm run eval:v4:ground-truth -- --all
 *
 * By default, no ground-truth (sub-)outcome that a deterministic match can't confidently resolve
 * ever calls OpenAI -- it's reported as retrieved-but-unresolved and left `needs_review`. Pass
 * --allow-semantic-adjudication to enable the structured semantic judge (see
 * lib/execution-intelligence/eval-harness/semantic-judge.ts) for exactly those ambiguous cases --
 * mirrors scripts/eval-v4.ts's --allow-model-calls cost-safety convention. Even with the flag on,
 * this script never re-runs extraction and never writes to Supabase -- the judge only ever compares
 * already-persisted text.
 *
 * Requires STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY (same staging-only convention
 * already used by scripts/diagnose-execution-candidates.ts). Refuses to run against a job whose
 * status isn't "completed". Never writes to Supabase.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";

loadEnvConfig(process.cwd());

import { readMeetingSnapshot, type MinimalSupabaseClient } from "../lib/execution-intelligence/eval-harness/checkpoint-reader";
import { parseMeetingGroundTruth, type MeetingGroundTruth } from "../lib/execution-intelligence/eval-harness/ground-truth-schema";
import { aggregateAcrossMeetings, computePerMeetingMetrics } from "../lib/execution-intelligence/eval-harness/metrics";
import { buildMeetingReport, renderAggregateMarkdown, renderMeetingMarkdown } from "../lib/execution-intelligence/eval-harness/report";
import { traceGroundTruthItem, type GroundTruthItemTrace } from "../lib/execution-intelligence/eval-harness/stage-tracer";
import { runBatchSemanticAdjudication, type SemanticBatchJudge } from "../lib/execution-intelligence/eval-harness/semantic-judge";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/v4-eval");

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
  console.error(`[eval:v4:ground-truth] ${message}`);
  process.exit(1);
}

type FixtureEntry = { fileStem: string; groundTruth: MeetingGroundTruth };

async function loadAllFixtures(): Promise<FixtureEntry[]> {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".ground-truth.ts"));
  const entries: FixtureEntry[] = [];
  for (const file of files) {
    const modulePath = path.join(FIXTURES_DIR, file);
    const mod = (await import(modulePath)) as { default: unknown };
    const groundTruth = parseMeetingGroundTruth(mod.default);
    entries.push({ fileStem: file.replace(/\.ground-truth\.ts$/, ""), groundTruth });
  }
  return entries;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing required environment variable: ${name}`);
  return value as string;
}

async function evaluateOne(input: {
  client: MinimalSupabaseClient;
  groundTruth: MeetingGroundTruth;
  jobId?: string;
  generation?: number;
  outputDir: string;
  judge?: SemanticBatchJudge;
}) {
  const snapshotResult = await readMeetingSnapshot({
    client: input.client,
    meetingId: input.groundTruth.meeting_id,
    jobId: input.jobId,
    generation: input.generation
  });
  if (!snapshotResult.ok) {
    console.error(`[eval:v4:ground-truth] ${input.groundTruth.meeting_title}: ${snapshotResult.error}`);
    return null;
  }
  const snapshot = snapshotResult.snapshot;
  // Sequential, not Promise.all -- keeps semantic-judge call volume easy to reason about/throttle
  // and keeps trace ordering deterministic for reporting (mirrors traceGroundTruthItem's own
  // internal sub-outcome loop, see stage-tracer.ts).
  const traces: GroundTruthItemTrace[] = [];
  for (const item of input.groundTruth.ground_truth) {
    traces.push(await traceGroundTruthItem(item, snapshot, input.judge));
  }
  const metrics = computePerMeetingMetrics({ groundTruth: input.groundTruth, snapshot, traces });
  const report = buildMeetingReport({ groundTruth: input.groundTruth, metrics, traces });

  const safeStem = input.groundTruth.meeting_id.slice(0, 8);
  mkdirSync(input.outputDir, { recursive: true });
  const jsonPath = path.join(input.outputDir, `${safeStem}-gen${snapshot.generation}.json`);
  const mdPath = path.join(input.outputDir, `${safeStem}-gen${snapshot.generation}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMeetingMarkdown(report));

  console.info(
    `[eval:v4:ground-truth] ${input.groundTruth.meeting_title} (gen ${snapshot.generation}): ` +
      `${metrics.correct}/${metrics.activeGroundTruthTotal} correct, ${metrics.partial} partial, ${metrics.missed} missed, ${metrics.needsReview} needs_review ` +
      `| judge calls=${metrics.semanticJudgeCalls} candidates=${metrics.semanticCandidatesSubmitted} failures=${metrics.semanticJudgeFailures} avgShortlist=${metrics.averageShortlistSize.toFixed(2)} maxShortlist=${metrics.maxShortlistSize} ` +
      `-> ${jsonPath}`
  );

  return { groundTruth: input.groundTruth, snapshot, traces, metrics };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runAll = args.all === true || args.all === "true";
  const outputDir = path.resolve(String(args.output ?? `.tmp/v4-eval-reports/${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const allowSemanticAdjudication =
    args["allow-semantic-adjudication"] === true || args["allow-semantic-adjudication"] === "true";
  const judge: SemanticBatchJudge | undefined = allowSemanticAdjudication ? (request) => runBatchSemanticAdjudication(request) : undefined;
  if (allowSemanticAdjudication) {
    console.info("[eval:v4:ground-truth] semantic adjudication ENABLED -- ambiguous candidates will call OpenAI read-only.");
  } else {
    console.info(
      "[eval:v4:ground-truth] semantic adjudication disabled (default) -- ambiguous candidates are reported unresolved/needs_review. Pass --allow-semantic-adjudication to enable."
    );
  }

  // Type-erased to MinimalSupabaseClient at the boundary -- @supabase/supabase-js's generated
  // client type is deep enough that TS's structural-assignability check on the full concrete type
  // hits "excessively deep" recursion; only the handful of methods this script and
  // checkpoint-reader.ts actually call are ever exercised, so this narrowing is safe at runtime.
  const client = createClient(
    requireEnv("STAGING_SUPABASE_URL"),
    requireEnv("STAGING_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } }
  ) as unknown as MinimalSupabaseClient;

  if (runAll) {
    const fixtures = await loadAllFixtures();
    if (fixtures.length === 0) fail(`No fixtures found in ${FIXTURES_DIR}`);
    const results = [];
    for (const fixture of fixtures) {
      const result = await evaluateOne({ client, groundTruth: fixture.groundTruth, outputDir, judge });
      if (result) results.push(result);
    }
    const aggregate = aggregateAcrossMeetings(results);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, "aggregate.json"), JSON.stringify(aggregate, null, 2));
    writeFileSync(path.join(outputDir, "aggregate.md"), renderAggregateMarkdown(aggregate));
    console.info(`\n[eval:v4:ground-truth] aggregate: ${path.join(outputDir, "aggregate.md")}`);
    return;
  }

  const meetingArg = args.meeting;
  if (typeof meetingArg !== "string") {
    fail(
      "Usage: eval:v4:ground-truth -- --meeting <fixture-stem> [--generation <n> | --job <job-id>] [--allow-semantic-adjudication] | --all [--allow-semantic-adjudication]"
    );
  }
  const fixtures = await loadAllFixtures();
  const fixture = fixtures.find((f) => f.fileStem === meetingArg || f.groundTruth.meeting_id === meetingArg);
  if (!fixture) fail(`No fixture matches "${meetingArg}" (looked in ${FIXTURES_DIR})`);

  const generation = typeof args.generation === "string" ? Number(args.generation) : undefined;
  const jobId = typeof args.job === "string" ? args.job : undefined;
  if (!generation && !jobId) fail("Provide --generation <n> or --job <job-id>");

  await evaluateOne({ client, groundTruth: fixture.groundTruth, jobId, generation, outputDir, judge });
}

main().catch((error) => {
  console.error("[eval:v4:ground-truth] fatal error:", error);
  process.exit(1);
});
