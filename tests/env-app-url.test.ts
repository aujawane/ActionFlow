import assert from "node:assert/strict";
import test from "node:test";

import { getAppBaseUrl, getGoogleRedirectUri, getRecallWebhookUrl } from "../lib/env";

function setEnv(name: string, value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env[name];
    return;
  }
  env[name] = value;
}

test("getAppBaseUrl prefers INTERNAL_APP_URL then NEXT_PUBLIC_APP_URL", () => {
  const previousInternal = process.env.INTERNAL_APP_URL;
  const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
  const previousNodeEnv = process.env.NODE_ENV;

  setEnv("INTERNAL_APP_URL", "https://internal.example.com/");
  setEnv("NEXT_PUBLIC_APP_URL", "https://public.example.com");
  setEnv("NODE_ENV", "production");

  assert.equal(getAppBaseUrl(), "https://internal.example.com");

  setEnv("INTERNAL_APP_URL", undefined);
  assert.equal(getAppBaseUrl(), "https://public.example.com");
  assert.equal(
    getRecallWebhookUrl(),
    "https://public.example.com/api/recall/webhook"
  );
  assert.equal(
    getGoogleRedirectUri(),
    "https://public.example.com/api/integrations/google/callback"
  );

  setEnv("INTERNAL_APP_URL", previousInternal);
  setEnv("NEXT_PUBLIC_APP_URL", previousPublic);
  setEnv("NODE_ENV", previousNodeEnv);
});

test("getAppBaseUrl never invents localhost in production without configured URLs", () => {
  const previousInternal = process.env.INTERNAL_APP_URL;
  const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
  const previousNodeEnv = process.env.NODE_ENV;

  setEnv("INTERNAL_APP_URL", undefined);
  setEnv("NEXT_PUBLIC_APP_URL", undefined);
  setEnv("NODE_ENV", "production");

  assert.equal(
    getAppBaseUrl({ requestOrigin: "https://fallback.example.com" }),
    "https://fallback.example.com"
  );
  assert.throws(() => getAppBaseUrl(), /Missing INTERNAL_APP_URL or NEXT_PUBLIC_APP_URL/);

  setEnv("INTERNAL_APP_URL", previousInternal);
  setEnv("NEXT_PUBLIC_APP_URL", previousPublic);
  setEnv("NODE_ENV", previousNodeEnv);
});
