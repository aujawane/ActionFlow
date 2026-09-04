import assert from "node:assert/strict";
import test from "node:test";

import { Webhook } from "svix";

import {
  shouldRequireRecallWebhookVerification,
  verifyRecallWebhookPayload
} from "../lib/recall/webhook-auth";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function sign(body: string, id = "msg_test", timestamp = new Date()) {
  const webhook = new Webhook(SECRET);
  const signature = webhook.sign(id, timestamp, body);
  return {
    webhookId: id,
    webhookTimestamp: String(Math.floor(timestamp.getTime() / 1000)),
    webhookSignature: signature
  };
}

test("a validly Svix-signed webhook is accepted", () => {
  const body = JSON.stringify({ event: "bot.status_change" });
  const headers = sign(body);

  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers,
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: true });
});

test("a tampered body is rejected even with a validly-formatted signature", () => {
  const originalBody = JSON.stringify({ event: "bot.status_change" });
  const headers = sign(originalBody);
  const tamperedBody = JSON.stringify({ event: "bot.status_change", injected: true });

  const result = verifyRecallWebhookPayload({
    rawBody: tamperedBody,
    headers,
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
});

test("a signature computed with the wrong secret is rejected", () => {
  const body = JSON.stringify({ event: "bot.status_change" });
  const wrongSecretWebhook = new Webhook("whsec_wrongwrongwrongwrongwrongwrongwrongw");
  const timestamp = new Date();
  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers: {
      webhookId: "msg_test",
      webhookTimestamp: String(Math.floor(timestamp.getTime() / 1000)),
      webhookSignature: wrongSecretWebhook.sign("msg_test", timestamp, body)
    },
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
});

test("missing signature headers are rejected with a distinct, explicit reason", () => {
  const body = JSON.stringify({ event: "bot.status_change" });

  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers: { webhookId: null, webhookTimestamp: null, webhookSignature: null },
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: false, reason: "missing_headers" });
});

test("a partially-missing header set (only some of the three) is still rejected", () => {
  const body = JSON.stringify({ event: "bot.status_change" });
  const headers = sign(body);

  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers: { ...headers, webhookSignature: null },
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: false, reason: "missing_headers" });
});

test("a missing/unconfigured secret fails closed with an explicit, distinct reason -- never a silent bypass", () => {
  const body = JSON.stringify({ event: "bot.status_change" });
  const headers = sign(body);

  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers,
    secret: undefined,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: false, reason: "not_configured" });
});

test("verification is skipped when the caller determines it isn't required (genuine local dev)", () => {
  const result = verifyRecallWebhookPayload({
    rawBody: "{}",
    headers: { webhookId: null, webhookTimestamp: null, webhookSignature: null },
    secret: undefined,
    requireVerification: false
  });

  assert.deepEqual(result, { ok: true });
});

// ---------------------------------------------------------------------------
// shouldRequireRecallWebhookVerification: NODE_ENV alone is not a safe "is this public" signal --
// Vercel Preview deployments are publicly reachable even when NODE_ENV isn't "production" there.
// ---------------------------------------------------------------------------

test("production NODE_ENV always requires verification", () => {
  assert.equal(shouldRequireRecallWebhookVerification({ NODE_ENV: "production" }), true);
});

test("a Vercel Production deployment requires verification even if NODE_ENV were misconfigured", () => {
  assert.equal(
    shouldRequireRecallWebhookVerification({ NODE_ENV: "development", VERCEL_ENV: "production" }),
    true
  );
});

test("a Vercel Preview deployment requires verification -- it's a publicly reachable URL", () => {
  assert.equal(
    shouldRequireRecallWebhookVerification({ NODE_ENV: "development", VERCEL_ENV: "preview" }),
    true
  );
  assert.equal(
    shouldRequireRecallWebhookVerification({ NODE_ENV: undefined, VERCEL_ENV: "preview" }),
    true
  );
});

test("genuine local development (no VERCEL_ENV, non-production NODE_ENV) does not require verification", () => {
  assert.equal(shouldRequireRecallWebhookVerification({ NODE_ENV: "development" }), false);
  assert.equal(shouldRequireRecallWebhookVerification({}), false);
});

test("Vercel's local `vercel dev` VERCEL_ENV=development does not require verification", () => {
  assert.equal(
    shouldRequireRecallWebhookVerification({ NODE_ENV: "development", VERCEL_ENV: "development" }),
    false
  );
});

test("the svix-* aliased header names are accepted identically to webhook-* names", () => {
  const body = JSON.stringify({ event: "bot.status_change" });
  const headers = sign(body);

  // Simulates a route that read svix-id/svix-timestamp/svix-signature instead.
  const result = verifyRecallWebhookPayload({
    rawBody: body,
    headers,
    secret: SECRET,
    requireVerification: true
  });

  assert.deepEqual(result, { ok: true });
});
