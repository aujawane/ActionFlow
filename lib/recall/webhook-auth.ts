import { Webhook, WebhookVerificationError } from "svix";

export type RecallWebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_headers" | "invalid_signature" };

/**
 * Recall signs webhook requests using the Standard Webhooks spec (the same scheme Svix
 * implements): `webhook-id` / `webhook-timestamp` / `webhook-signature` headers (`svix-*` names
 * are accepted aliases). The `svix` package's `Webhook.verify()` already checks both header-name
 * families internally, so headers only need to be read once here, not matched twice.
 *
 * Where the `whsec_...` secret comes from depends on when the Recall workspace was created:
 *  - Workspaces created on/after 2025-12-15: a single "workspace verification secret" from
 *    Developers > API Keys & Secrets in the Recall dashboard, shared by all webhooks/websockets.
 *  - Legacy workspaces created before 2025-12-15: the per-endpoint Svix signing secret shown on
 *    that specific webhook's page under the Recall dashboard's Webhooks section.
 * Both are `whsec_...` values verified identically by this function -- RECALL_WEBHOOK_SECRET just
 * needs to hold whichever one applies to this workspace. See .env.example for operator guidance.
 */
export function verifyRecallWebhookPayload(input: {
  rawBody: string;
  headers: {
    webhookId: string | null;
    webhookTimestamp: string | null;
    webhookSignature: string | null;
  };
  secret: string | undefined;
  /** Whether an unauthenticated request should be rejected. True for production and for any real
   * Vercel deployment (Production or Preview) -- see shouldRequireRecallWebhookVerification.
   * Never bypassed when true. */
  requireVerification: boolean;
}): RecallWebhookVerificationResult {
  if (!input.requireVerification) {
    return { ok: true };
  }

  const secret = input.secret?.trim();
  if (!secret) {
    console.error(
      "[recall-webhook] Verification failed: RECALL_WEBHOOK_SECRET is not configured."
    );
    return { ok: false, reason: "not_configured" };
  }

  const { webhookId, webhookTimestamp, webhookSignature } = input.headers;
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.error("[recall-webhook] Verification failed: missing required signature headers.", {
      has_webhook_id: Boolean(webhookId),
      has_webhook_timestamp: Boolean(webhookTimestamp),
      has_webhook_signature: Boolean(webhookSignature)
    });
    return { ok: false, reason: "missing_headers" };
  }

  try {
    new Webhook(secret).verify(input.rawBody, {
      "webhook-id": webhookId,
      "webhook-timestamp": webhookTimestamp,
      "webhook-signature": webhookSignature
    });
    return { ok: true };
  } catch (error) {
    const isVerificationError = error instanceof WebhookVerificationError;
    console.error("[recall-webhook] Verification failed: signature mismatch.", {
      error_type: isVerificationError ? "WebhookVerificationError" : "UnexpectedError",
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return { ok: false, reason: "invalid_signature" };
  }
}

/**
 * Determines whether an incoming request must pass signature verification. `NODE_ENV ===
 * "production"` alone is not a safe signal for "is this publicly reachable" -- Vercel Preview
 * deployments are publicly reachable URLs, and a project could (accidentally or otherwise) have
 * NODE_ENV set to something other than "production" for the Preview environment. VERCEL_ENV is
 * set by Vercel itself on every real deployment (production or preview) and can't be
 * misconfigured the same way, so it's checked independently of NODE_ENV. Only a genuine local
 * checkout with neither set is allowed to bypass verification.
 */
export function shouldRequireRecallWebhookVerification(env: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}): boolean {
  if (env.NODE_ENV === "production") return true;
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
}
