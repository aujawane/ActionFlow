import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS,
  getAppBaseUrl,
  getConfiguredOpenAIModel,
  getExecutionIntelligenceTimeoutMs,
  getGoogleRedirectUri,
  getRecallWebhookUrl,
  parseExecutionIntelligenceTimeoutMs
} from "../lib/env";

function setEnv(name: string, value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env[name];
    return;
  }
  env[name] = value;
}

test("execution-intelligence timeout defaults to 60 seconds and parses env values", () => {
  assert.equal(
    parseExecutionIntelligenceTimeoutMs(undefined),
    DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS
  );
  assert.equal(parseExecutionIntelligenceTimeoutMs(""), 60_000);
  assert.equal(parseExecutionIntelligenceTimeoutMs(" 45000 "), 45_000);
});

test("execution-intelligence timeout reads the configured environment value", () => {
  const previous = process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS;
  try {
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", "47000");
    assert.equal(getExecutionIntelligenceTimeoutMs(), 47_000);

    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", undefined);
    assert.equal(getExecutionIntelligenceTimeoutMs(), 60_000);
  } finally {
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", previous);
  }
});

test("execution-intelligence timeout rejects unsafe env values", () => {
  assert.throws(() => parseExecutionIntelligenceTimeoutMs("not-a-number"));
  assert.throws(() => parseExecutionIntelligenceTimeoutMs("999"));
  assert.throws(() => parseExecutionIntelligenceTimeoutMs("300001"));
  assert.throws(() => parseExecutionIntelligenceTimeoutMs("1250.5"));
});

test("OpenAI model configuration is explicit and defaults safely", () => {
  const previous = process.env.OPENAI_MODEL;
  try {
    setEnv("OPENAI_MODEL", "gpt-4.1-mini");
    assert.equal(getConfiguredOpenAIModel(), "gpt-4.1-mini");

    setEnv("OPENAI_MODEL", undefined);
    assert.equal(getConfiguredOpenAIModel(), "gpt-4.1-mini");
  } finally {
    setEnv("OPENAI_MODEL", previous);
  }
});

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
