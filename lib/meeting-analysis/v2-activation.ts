/**
 * Server-only rollout control for analysis pipeline v2's explicit opt-in route
 * (/api/meetings/[id]/analyze-v2). Normal analysis (the Analyze route, Recall webhook) never
 * consults this and always claims pipeline v1.
 *
 * Current gate (every environment, including production):
 *   ANALYSIS_PIPELINE_V2_ENABLED=true
 *   AND the meeting id is listed in ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS
 *     (comma-separated UUIDs; whitespace, case and duplicates are tolerated; an absent or empty
 *     list, or any malformed entry, disables the allowlist entirely rather than guessing).
 *
 * Legacy staging gate, honoured ONLY while ANALYSIS_PIPELINE_V2_ENABLED is unset, so existing
 * staging deployments keep working until they adopt the variables above:
 *   ANALYSIS_PIPELINE_V2_STAGING_ENABLED=true AND NEXT_PUBLIC_SUPABASE_ENV=staging (any meeting).
 * Once ANALYSIS_PIPELINE_V2_ENABLED is set to any value, the legacy flag is ignored, so setting it
 * to "false" closes v2 everywhere. The legacy gate can never open v2 against production.
 */
export const ANALYSIS_PIPELINE_V2_ENABLED_FLAG = "ANALYSIS_PIPELINE_V2_ENABLED";
export const ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS = "ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS";
export const ANALYSIS_PIPELINE_V2_STAGING_FLAG = "ANALYSIS_PIPELINE_V2_STAGING_ENABLED";

type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readTrimmed(env: Env, name: string) {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The allowlisted meeting ids (lowercased), or null when absent, empty or malformed. */
export function parseAllowedMeetingIds(value: string | undefined): ReadonlySet<string> | null {
  const entries = (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0 || !entries.every((entry) => UUID.test(entry))) return null;
  return new Set(entries);
}

/** Legacy behaviour: staging project plus the old flag, for any meeting. */
export function isAnalysisPipelineV2StagingEnabled(env: Env = process.env) {
  return readTrimmed(env, ANALYSIS_PIPELINE_V2_STAGING_FLAG) === "true" &&
    readTrimmed(env, "NEXT_PUBLIC_SUPABASE_ENV") === "staging";
}

/** Whether the explicit v2 route may run pipeline v2 for this meeting. Pure; authorization is
 * separate and still required. */
export function isAnalysisPipelineV2EnabledForMeeting(meetingId: string, env: Env = process.env) {
  const master = readTrimmed(env, ANALYSIS_PIPELINE_V2_ENABLED_FLAG);
  if (master === undefined) return isAnalysisPipelineV2StagingEnabled(env);
  if (master !== "true") return false;
  const allowed = parseAllowedMeetingIds(env[ANALYSIS_PIPELINE_V2_ALLOWED_MEETING_IDS]);
  return allowed !== null && allowed.has(meetingId.trim().toLowerCase());
}
