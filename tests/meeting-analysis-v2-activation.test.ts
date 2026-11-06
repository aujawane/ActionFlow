import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { handleAnalyzeV2Request, type AnalyzeV2Deps } from "../lib/meeting-analysis/analyze-v2-request";
import { enqueueMeetingAnalysisV2 } from "../lib/meeting-analysis/enqueue-v2";
import {
  ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS,
  ANALYSIS_PIPELINE_V2_ENABLED_FLAG,
  ANALYSIS_PIPELINE_V2_STAGING_FLAG,
  isAnalysisPipelineV2EnabledForMeeting,
  parseAllowedMeetingIds
} from "../lib/meeting-analysis/v2-activation";

const MEETING = "e9dcc8fe-0c79-47e6-a265-ae171b3478d5";
const OTHER = "11111111-1111-4111-8111-111111111111";
const THIRD = "22222222-2222-4222-8222-222222222222";
const gate = (env: Record<string, string | undefined>, meetingId = MEETING) =>
  isAnalysisPipelineV2EnabledForMeeting(meetingId, env);
const on = (allowed: string, extra: Record<string, string | undefined> = {}) => ({
  [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: "true",
  [ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS]: allowed,
  ...extra
});

// ================================================================= gate matrix
test("[1] no configuration at all: closed", () => {
  assert.equal(gate({}), false);
  assert.equal(gate({ NEXT_PUBLIC_SUPABASE_ENV: "production" }), false);
});

test("[2] master flag false (or anything but \"true\") keeps an allowlisted meeting closed", () => {
  for (const value of ["false", "0", "TRUE", "yes", "1", "on"]) {
    assert.equal(gate({ [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: value, [ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS]: MEETING }), false, value);
  }
});

test("[3] master flag true with an absent, empty or comma-only allowlist: closed (never global)", () => {
  for (const allowed of [undefined, "", "   ", ",", " , ,"]) {
    assert.equal(gate({ [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: "true", [ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS]: allowed }), false, String(allowed));
  }
  assert.equal(gate({ [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: "true", NEXT_PUBLIC_SUPABASE_ENV: "production" }), false);
});

test("[4][5] master flag true: only an allowlisted meeting opens", () => {
  assert.equal(gate(on(OTHER)), false);
  assert.equal(gate(on(MEETING)), true);
  assert.equal(gate(on(MEETING), OTHER), false);
});

test("[6][7][8] several ids, whitespace, case and duplicates", () => {
  const env = on(`  ${OTHER} ,${MEETING.toUpperCase()},,${MEETING} , ${THIRD}  `);
  for (const id of [MEETING, OTHER, THIRD, MEETING.toUpperCase(), ` ${MEETING} `]) assert.equal(gate(env, id), true, id);
  assert.equal(gate(env, "33333333-3333-4333-8333-333333333333"), false);
  assert.deepEqual([...parseAllowedMeetingIds(`${MEETING},${MEETING}`)!], [MEETING]);
});

test("[9] any malformed allowlist entry fails closed for the whole list", () => {
  for (const allowed of [`${MEETING},not-a-uuid`, `${MEETING};${OTHER}`, `${MEETING} ${OTHER}`, "*", "all", `${MEETING}x`, `{${MEETING}}`]) {
    assert.equal(parseAllowedMeetingIds(allowed), null, allowed);
    assert.equal(gate(on(allowed)), false, allowed);
  }
});

test("[10][11][12] the environment name neither opens nor blocks the new gate", () => {
  assert.equal(gate(on(MEETING, { NEXT_PUBLIC_SUPABASE_ENV: "production" })), true);
  assert.equal(gate(on(MEETING, { NEXT_PUBLIC_SUPABASE_ENV: "staging" })), true);
  for (const name of ["production", "staging"]) {
    assert.equal(gate({ NEXT_PUBLIC_SUPABASE_ENV: name }), false, name);
  }
});

test("legacy staging flag: honoured only while the new master flag is unset, and never in production", () => {
  const legacy = { [ANALYSIS_PIPELINE_V2_STAGING_FLAG]: "true", NEXT_PUBLIC_SUPABASE_ENV: "staging" };
  // Today's staging Preview keeps working with no env change, for any owned meeting.
  assert.equal(gate(legacy), true);
  assert.equal(gate(legacy, OTHER), true);
  // Never against production, and never without the legacy flag.
  assert.equal(gate({ ...legacy, NEXT_PUBLIC_SUPABASE_ENV: "production" }), false);
  assert.equal(gate({ NEXT_PUBLIC_SUPABASE_ENV: "staging", [ANALYSIS_PIPELINE_V2_STAGING_FLAG]: "false" }), false);
  // Once the new master flag is set, it alone decides: "false" is a kill switch everywhere.
  assert.equal(gate({ ...legacy, [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: "false" }), false);
  assert.equal(gate({ ...legacy, ...on(OTHER) }), false, "set master + allowlist: the legacy wildcard no longer applies");
  assert.equal(gate({ ...legacy, ...on(MEETING) }), true);
});

// ================================================================= request handler
function deps(overrides: Partial<AnalyzeV2Deps> = {}) {
  const calls: string[] = [];
  const base: AnalyzeV2Deps = {
    isEnabledForMeeting: (meetingId) => { calls.push(`gate:${meetingId}`); return meetingId === MEETING; },
    authenticate: async () => { calls.push("auth"); return { userId: "owner" }; },
    findOwnedMeeting: async (meetingId, userId) => { calls.push(`owned:${userId}`); return meetingId === MEETING && userId === "owner"; },
    countTranscriptSegments: async () => { calls.push("segments"); return { count: 854, error: null }; },
    enqueue: async () => { calls.push("enqueue"); return { ok: true, jobId: "job-1", generation: 23, status: "queued" }; }
  };
  return { calls, deps: { ...base, ...overrides } };
}

test("[13] a closed gate answers like a missing route, before any auth or database read", async () => {
  const { calls, deps: d } = deps();
  assert.deepEqual(await handleAnalyzeV2Request(OTHER, d), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(calls, [`gate:${OTHER}`]);
});

test("[14] an allowlisted meeting still requires a signed-in user", async () => {
  const { calls, deps: d } = deps({ authenticate: async () => null });
  assert.deepEqual(await handleAnalyzeV2Request(MEETING, d), { status: 401, body: { error: "Unauthorized" } });
  assert.deepEqual(calls, [`gate:${MEETING}`]);
});

test("[15] an allowlisted meeting the caller does not own is never enqueued", async () => {
  const { calls, deps: d } = deps({ authenticate: async () => { calls.push("auth"); return { userId: "someone-else" }; } });
  assert.deepEqual(await handleAnalyzeV2Request(MEETING, d), { status: 404, body: { error: "Meeting not found" } });
  assert.ok(!calls.includes("enqueue") && !calls.includes("segments"));
});

test("open gate, owner, transcript present: 202 with pipelineVersion 2; transcript checks unchanged", async () => {
  const { calls, deps: d } = deps();
  assert.deepEqual(await handleAnalyzeV2Request(MEETING, d), {
    status: 202,
    body: { accepted: true, pipelineVersion: 2, jobId: "job-1", generation: 23, status: "queued", message: "Meeting analysis (pipeline v2) queued." }
  });
  assert.deepEqual(calls, [`gate:${MEETING}`, "auth", "owned:owner", "segments", "enqueue"]);
  assert.deepEqual(await handleAnalyzeV2Request(MEETING, deps({ countTranscriptSegments: async () => ({ count: 0, error: null }) }).deps),
    { status: 400, body: { error: "No transcript available yet" } });
  assert.deepEqual(await handleAnalyzeV2Request(MEETING, deps({ countTranscriptSegments: async () => ({ count: 0, error: "boom" }) }).deps),
    { status: 500, body: { error: "Failed to fetch transcript", details: "boom" } });
});

test("defense in depth: enqueueMeetingAnalysisV2 itself refuses a meeting the gate does not open", async () => {
  const env = process.env;
  try {
    process.env = { ...env, ...on(OTHER), NEXT_PUBLIC_SUPABASE_ENV: "production" };
    assert.deepEqual(await enqueueMeetingAnalysisV2(MEETING), { ok: false, error: "Analysis pipeline v2 is not enabled." });
    process.env = { ...env, [ANALYSIS_PIPELINE_V2_ENABLED_FLAG]: undefined, [ANALYSIS_PIPELINE_V2_STAGING_FLAG]: "true", NEXT_PUBLIC_SUPABASE_ENV: "production" };
    assert.deepEqual(await enqueueMeetingAnalysisV2(MEETING), { ok: false, error: "Analysis pipeline v2 is not enabled." });
  } finally {
    process.env = env;
  }
});

// ================================================================= routing and exposure
test("[16][17][18] normal Analyze and the Recall webhook still claim v1; only the v2 path claims pipeline_version 2", async () => {
  const enqueue = await readFile(new URL("../lib/meeting-analysis/enqueue.ts", import.meta.url), "utf8");
  assert.match(enqueue, /options\?\.claimJob \?\? claimMeetingAnalysisJob;/);
  for (const caller of ["../app/api/meetings/[id]/analyze/route.ts", "../lib/recall/processing.ts"]) {
    const source = await readFile(new URL(caller, import.meta.url), "utf8");
    assert.match(source, /enqueueMeetingAnalysis\(/);
    assert.doesNotMatch(source, /enqueue-v2|v2-activation|MeetingAnalysisV2|claim_meeting_analysis_job_v2|ANALYSIS_PIPELINE_V2/);
  }
  // claimMeetingAnalysisJobV2 (the only claim that writes pipeline_version 2) has one caller.
  const files = await sourceFiles();
  const callers = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/claimMeetingAnalysisJobV2\(|claim_meeting_analysis_job_v2/.test(source)) callers.push(file.replace(/^.*?\/(lib|app)\//, "$1/"));
  }
  assert.deepEqual(callers.sort(), ["lib/meeting-analysis/enqueue-v2.ts", "lib/meeting-analysis/job-units.ts"]);
});

test("[19] the gate is server-only configuration: no NEXT_PUBLIC names, no client importers", async () => {
  for (const name of [ANALYSIS_PIPELINE_V2_ENABLED_FLAG, ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS, ANALYSIS_PIPELINE_V2_STAGING_FLAG]) {
    assert.doesNotMatch(name, /^NEXT_PUBLIC_/);
  }
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    if (/^\s*["']use client["']/m.test(source)) {
      assert.doesNotMatch(source, /v2-activation|enqueue-v2|ANALYSIS_PIPELINE_V2/, file);
    }
  }
});

async function sourceFiles() {
  const out: string[] = [];
  for (const root of ["../lib", "../app", "../components"]) {
    const dir = new URL(`${root}/`, import.meta.url);
    let entries: string[] = [];
    try {
      entries = (await readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/\.(ts|tsx)$/.test(entry)) out.push(new URL(entry, dir).pathname);
    }
  }
  return out;
}
