import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnvConfig(process.cwd());

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function serviceRoleClient(url: string, key: string) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function isMissingRelation(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /meeting_speaker_aliases.*(?:does not exist|schema cache)/i.test(
    error.message ?? ""
  );
}

async function verifyStagingDestination(input: {
  staging: SupabaseClient;
  meetingId: string;
  stagingUserId: string;
}) {
  const [
    meetingResult,
    userResult,
    profileResult
  ] = await Promise.all([
    input.staging
      .from("meetings")
      .select("id")
      .eq("id", input.meetingId)
      .maybeSingle(),
    input.staging.auth.admin.getUserById(input.stagingUserId),
    input.staging
      .from("profiles")
      .select("id")
      .eq("id", input.stagingUserId)
      .maybeSingle()
  ]);

  if (meetingResult.error) {
    throw new Error(
      `Failed to check staging meeting: ${meetingResult.error.message}`
    );
  }
  if (meetingResult.data) {
    throw new Error(
      `Meeting ${input.meetingId} already exists in staging; nothing was copied.`
    );
  }
  if (userResult.error || !userResult.data.user) {
    throw new Error(
      `Staging auth user ${input.stagingUserId} does not exist.`
    );
  }
  if (profileResult.error) {
    throw new Error(
      `Failed to check staging profile: ${profileResult.error.message}`
    );
  }
  if (!profileResult.data) {
    throw new Error(
      `Staging profile ${input.stagingUserId} does not exist.`
    );
  }
}

async function main() {
  const [meetingId, stagingUserId, ...extraArguments] = process.argv.slice(2);
  if (!meetingId || !stagingUserId || extraArguments.length > 0) {
    throw new Error(
      "Usage: npm run copy-meeting -- <meeting_id> <staging_user_id>"
    );
  }
  if (!UUID_PATTERN.test(meetingId)) {
    throw new Error(`Invalid meeting_id UUID: ${meetingId}`);
  }
  if (!UUID_PATTERN.test(stagingUserId)) {
    throw new Error(`Invalid staging_user_id UUID: ${stagingUserId}`);
  }

  const productionUrl = requireEnvironment("PRODUCTION_SUPABASE_URL");
  const productionKey = requireEnvironment(
    "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"
  );
  const stagingUrl = requireEnvironment("STAGING_SUPABASE_URL");
  const stagingKey = requireEnvironment("STAGING_SUPABASE_SERVICE_ROLE_KEY");

  if (
    productionUrl.replace(/\/+$/, "").toLowerCase() ===
    stagingUrl.replace(/\/+$/, "").toLowerCase()
  ) {
    throw new Error(
      "Production and staging Supabase URLs are identical; refusing to write."
    );
  }

  const production = serviceRoleClient(productionUrl, productionKey);
  const staging = serviceRoleClient(stagingUrl, stagingKey);

  const { data: meeting, error: meetingError } = await production
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError) {
    throw new Error(
      `Failed to read production meeting: ${meetingError.message}`
    );
  }
  if (!meeting) {
    throw new Error(`Production meeting ${meetingId} does not exist.`);
  }

  await verifyStagingDestination({ staging, meetingId, stagingUserId });

  const [
    transcriptResult,
    aliasResult
  ] = await Promise.all([
    production
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", meetingId),
    production
      .from("meeting_speaker_aliases")
      .select("*")
      .eq("meeting_id", meetingId)
  ]);

  if (transcriptResult.error) {
    throw new Error(
      `Failed to read production transcript: ${transcriptResult.error.message}`
    );
  }
  if (aliasResult.error && !isMissingRelation(aliasResult.error)) {
    throw new Error(
      `Failed to read production speaker aliases: ${aliasResult.error.message}`
    );
  }

  const transcriptSegments = transcriptResult.data ?? [];
  const speakerAliases = aliasResult.error ? [] : aliasResult.data ?? [];
  const { data: imported, error: importError } = await staging.rpc(
    "import_meeting_for_execution_testing",
    {
      p_meeting: meeting,
      p_staging_user_id: stagingUserId,
      p_transcript_segments: transcriptSegments,
      p_speaker_aliases: speakerAliases
    }
  );

  if (importError) {
    const helperHint =
      importError.code === "PGRST202" || /schema cache|function/i.test(importError.message)
        ? " Install scripts/sql/install-copy-meeting-to-staging-rpc.sql in staging first."
        : "";
    throw new Error(
      `Transactional staging import failed; PostgreSQL rolled back every insert: ${importError.message}.${helperHint}`
    );
  }

  const result =
    imported && typeof imported === "object"
      ? (imported as Record<string, unknown>)
      : {};
  const copiedSegments =
    typeof result.transcript_segments === "number"
      ? result.transcript_segments
      : transcriptSegments.length;

  console.info("Meeting copied.");
  console.info(`Transcript segments copied: ${copiedSegments}`);
  console.info("Ready for execution-intelligence analysis.");
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? `Copy failed: ${error.message}` : "Copy failed."
  );
  process.exitCode = 1;
});
