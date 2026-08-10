import { z } from "zod";

/**
 * Server environment validation for Parfait.
 *
 * Required core variables are validated lazily on first server use so
 * Next.js can collect route metadata during builds without crashing when
 * secrets are injected only at runtime on Vercel.
 *
 * Zoom / Google credentials are optional at boot and validated when those
 * integrations are actually used.
 */

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function emptyToUndefined(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const optionalNonEmptyString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

export const DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

const executionIntelligenceTimeoutSchema = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS)
);

export function parseExecutionIntelligenceTimeoutMs(value: unknown) {
  return executionIntelligenceTimeoutSchema.parse(value);
}

export function getExecutionIntelligenceTimeoutMs() {
  return parseExecutionIntelligenceTimeoutMs(
    readEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS")
  );
}

export function getConfiguredOpenAIModel() {
  return readEnv("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;
}

export type ExecutionIntelligenceEngine = "independent" | "v4";

/**
 * Selects which execution-intelligence architecture a new analysis generation runs under.
 * Explicit `EXECUTION_INTELLIGENCE_ENGINE` always wins. Without it, v4 (grounded work items +
 * holistic grouping) is the default outside production, and `independent` (parallel task/
 * commitment extraction + relationship evaluation) remains the production default until v4 has
 * been compared against it on real meetings. See docs/execution-intelligence-v4.md.
 */
export function getExecutionIntelligenceEngine(): ExecutionIntelligenceEngine {
  const configured = readEnv("EXECUTION_INTELLIGENCE_ENGINE");
  if (configured === "independent" || configured === "v4") return configured;
  return process.env.NODE_ENV === "production" ? "independent" : "v4";
}

export type V4Stage =
  | "transcript_normalization"
  | "work_item_extraction"
  | "global_correction"
  | "grouping"
  | "grouping_verification"
  | "task_consolidation";

const V4_STAGE_MODEL_ENV: Record<V4Stage, string> = {
  transcript_normalization: "OPENAI_MODEL_V4_NORMALIZATION",
  work_item_extraction: "OPENAI_MODEL_V4_EXTRACTION",
  global_correction: "OPENAI_MODEL_V4_CORRECTION",
  grouping: "OPENAI_MODEL_V4_GROUPING",
  grouping_verification: "OPENAI_MODEL_V4_VERIFICATION",
  task_consolidation: "EXECUTION_TASK_CONSOLIDATION_MODEL"
};

const V4_STAGE_TIMEOUT_ENV: Record<V4Stage, string> = {
  transcript_normalization: "EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_NORMALIZATION",
  work_item_extraction: "EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_EXTRACTION",
  global_correction: "EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_CORRECTION",
  grouping: "EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_GROUPING",
  grouping_verification: "EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_VERIFICATION",
  task_consolidation: "EXECUTION_TASK_CONSOLIDATION_TIMEOUT_MS"
};

/**
 * Each V4 stage can be pointed at its own model via a dedicated env var, independent of the
 * global `OPENAI_MODEL` used by topic/insight extraction and the `independent` engine. Unset
 * falls back to `getConfiguredOpenAIModel()` -- no override changes today's behavior. During
 * stabilization, point `OPENAI_MODEL_V4_CORRECTION` / `_GROUPING` / `_VERIFICATION` at the
 * strongest reasoning model your account supports; extraction is high-volume and stays on the
 * cheaper default unless overridden too.
 */
export function getV4StageModel(stage: V4Stage): string {
  return readEnv(V4_STAGE_MODEL_ENV[stage]) ?? getConfiguredOpenAIModel();
}

/** Same override pattern as `getV4StageModel`, for per-stage timeouts. */
export function getV4StageTimeoutMs(stage: V4Stage): number {
  const raw = readEnv(V4_STAGE_TIMEOUT_ENV[stage]);
  if (raw === undefined) return getExecutionIntelligenceTimeoutMs();
  return parseExecutionIntelligenceTimeoutMs(raw);
}

const DEFAULT_TRANSCRIPT_NORMALIZATION_AUTO_THRESHOLD = 0.9;

/** Phase 0: optional, non-blocking entity-name correction before topic extraction. Off changes
 * nothing; a failure at runtime always falls back to the raw transcript, regardless of this flag. */
export function isTranscriptNormalizationEnabled(): boolean {
  return readEnv("TRANSCRIPT_NORMALIZATION_ENABLED") === "true";
}

/** Corrections at or above this confidence auto-apply; everything below is recorded as a
 * suggestion only and the original text is left untouched. */
export function getTranscriptNormalizationAutoThreshold(): number {
  const raw = readEnv("TRANSCRIPT_NORMALIZATION_AUTO_THRESHOLD");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TRANSCRIPT_NORMALIZATION_AUTO_THRESHOLD;
}

const DEFAULT_TASK_CONSOLIDATION_AUTO_THRESHOLD = 0.92;
const DEFAULT_TASK_CONSOLIDATION_SUGGEST_THRESHOLD = 0.75;

export function isTaskConsolidationEnabled(): boolean {
  const configured = readEnv("TASK_CONSOLIDATION_ENABLED");
  return configured === undefined ? true : configured === "true";
}

export function getTaskConsolidationAutoThreshold(): number {
  const raw = readEnv("TASK_CONSOLIDATION_AUTO_THRESHOLD");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TASK_CONSOLIDATION_AUTO_THRESHOLD;
}

export function getTaskConsolidationSuggestThreshold(): number {
  const raw = readEnv("TASK_CONSOLIDATION_SUGGEST_THRESHOLD");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_TASK_CONSOLIDATION_SUGGEST_THRESHOLD;
}

const coreEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_MODEL: z.string().trim().min(1).default(DEFAULT_OPENAI_MODEL),
  EXECUTION_INTELLIGENCE_TIMEOUT_MS: executionIntelligenceTimeoutSchema,
  RECALL_API_KEY: z.string().trim().min(1),
  RECALL_REGION: z.string().trim().min(1).default("us-west-2"),
  RECALL_WEBHOOK_SECRET: z.string().trim().min(1),
  INTERNAL_APP_URL: optionalUrl,
  RECALL_WEBHOOK_URL: optionalUrl,
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  GOOGLE_REFRESH_TOKEN: optionalNonEmptyString,
  ZOOM_CLIENT_ID: optionalNonEmptyString,
  ZOOM_CLIENT_SECRET: optionalNonEmptyString,
  ZOOM_ACCOUNT_ID: optionalNonEmptyString
});

export type ServerEnv = z.infer<typeof coreEnvSchema>;

let cachedServerEnv: ServerEnv | null = null;

function buildEnvInput() {
  return {
    NEXT_PUBLIC_APP_URL: readEnv("NEXT_PUBLIC_APP_URL"),
    NEXT_PUBLIC_SUPABASE_URL: readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
    OPENAI_MODEL: getConfiguredOpenAIModel(),
    EXECUTION_INTELLIGENCE_TIMEOUT_MS: readEnv(
      "EXECUTION_INTELLIGENCE_TIMEOUT_MS"
    ),
    RECALL_API_KEY: readEnv("RECALL_API_KEY"),
    RECALL_REGION: readEnv("RECALL_REGION") ?? "us-west-2",
    RECALL_WEBHOOK_SECRET: readEnv("RECALL_WEBHOOK_SECRET"),
    INTERNAL_APP_URL: readEnv("INTERNAL_APP_URL"),
    RECALL_WEBHOOK_URL: readEnv("RECALL_WEBHOOK_URL"),
    GOOGLE_CLIENT_ID: readEnv("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: readEnv("GOOGLE_CLIENT_SECRET"),
    GOOGLE_REDIRECT_URI: readEnv("GOOGLE_REDIRECT_URI"),
    GOOGLE_REFRESH_TOKEN: readEnv("GOOGLE_REFRESH_TOKEN"),
    ZOOM_CLIENT_ID: readEnv("ZOOM_CLIENT_ID"),
    ZOOM_CLIENT_SECRET: readEnv("ZOOM_CLIENT_SECRET"),
    ZOOM_ACCOUNT_ID: readEnv("ZOOM_ACCOUNT_ID")
  };
}

export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) {
    return cachedServerEnv;
  }

  const parsed = coreEnvSchema.safeParse(buildEnvInput());
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment configuration. ${details}`);
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/** @deprecated Prefer getServerEnv() for lazy validation. */
export const env = new Proxy({} as ServerEnv, {
  get(_target, property) {
    return Reflect.get(getServerEnv() as object, property);
  }
});

export function getPublicSupabaseUrl() {
  const value = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  if (!value) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  return value;
}

export function getPublicSupabaseAnonKey() {
  const value = readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!value) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return value;
}

/**
 * Resolve the app base URL for server-to-server calls and OAuth redirects.
 * Production never falls back to localhost.
 */
export function getAppBaseUrl(options?: { requestOrigin?: string | null }) {
  const internal = readEnv("INTERNAL_APP_URL");
  if (internal) {
    return internal.replace(/\/$/, "");
  }

  const publicUrl = readEnv("NEXT_PUBLIC_APP_URL");
  if (publicUrl) {
    return publicUrl.replace(/\/$/, "");
  }

  const requestOrigin = options?.requestOrigin?.trim().replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") {
    return requestOrigin || "http://localhost:3000";
  }

  if (requestOrigin) {
    return requestOrigin;
  }

  throw new Error(
    "Missing INTERNAL_APP_URL or NEXT_PUBLIC_APP_URL for production server URL resolution."
  );
}

/** Public origin used in links delivered to a user's browser or email. */
export function getPublicAppBaseUrl(options?: { requestOrigin?: string | null }) {
  const publicUrl = readEnv("NEXT_PUBLIC_APP_URL");
  if (publicUrl) return publicUrl.replace(/\/$/, "");

  const requestOrigin = options?.requestOrigin?.trim().replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production" && requestOrigin) return requestOrigin;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  throw new Error("Missing NEXT_PUBLIC_APP_URL for a public authentication redirect.");
}

export function getGoogleRedirectUri() {
  const configured = readEnv("GOOGLE_REDIRECT_URI");
  if (configured) {
    return configured;
  }
  return `${getAppBaseUrl()}/api/integrations/google/callback`;
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

export function getRecallWebhookUrl() {
  const configured = readEnv("RECALL_WEBHOOK_URL");
  if (configured) {
    return configured;
  }
  return `${getAppBaseUrl()}/api/recall/webhook`;
}
