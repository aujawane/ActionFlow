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

const coreEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini"),
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
    OPENAI_MODEL: readEnv("OPENAI_MODEL") ?? "gpt-4.1-mini",
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
