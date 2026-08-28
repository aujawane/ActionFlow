import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXECUTION_INTELLIGENCE_TIMEOUT_MS,
  MAX_SAFE_MODEL_ATTEMPT_TIMEOUT_MS,
  getAppBaseUrl,
  getConfiguredOpenAIModel,
  getExecutionIntelligenceTimeoutMs,
  getGoogleRedirectUri,
  getPublicAppBaseUrl,
  getRecallWebhookUrl,
  getV4StageTimeoutMs,
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

test("execution-intelligence timeout is clamped so 2 model attempts can never exceed the worker's 300s budget", () => {
  const previous = process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS;
  try {
    // A raw value is validly parseable up to 300_000ms (see the rejection test above), but 2
    // attempts at that size would blow well past the worker's 300s maxDuration -- the getter must
    // clamp what's actually used at runtime, independent of what's a "valid" input.
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", "300000");
    assert.equal(getExecutionIntelligenceTimeoutMs(), MAX_SAFE_MODEL_ATTEMPT_TIMEOUT_MS);
    assert.ok(2 * getExecutionIntelligenceTimeoutMs() < 300_000);

    // Values already at or under the safe cap pass through unchanged.
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", "45000");
    assert.equal(getExecutionIntelligenceTimeoutMs(), 45_000);
  } finally {
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS", previous);
  }
});

test("per-V4-stage timeout overrides are clamped the same way as the global default", () => {
  const previous = process.env.EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_CORRECTION;
  try {
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_CORRECTION", "250000");
    assert.equal(getV4StageTimeoutMs("global_correction"), MAX_SAFE_MODEL_ATTEMPT_TIMEOUT_MS);

    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_CORRECTION", undefined);
    assert.equal(getV4StageTimeoutMs("global_correction"), getExecutionIntelligenceTimeoutMs());
  } finally {
    setEnv("EXECUTION_INTELLIGENCE_TIMEOUT_MS_V4_CORRECTION", previous);
  }
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

test("public auth redirects use NEXT_PUBLIC_APP_URL and never an internal production URL", () => {
  const previousInternal = process.env.INTERNAL_APP_URL;
  const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    setEnv("INTERNAL_APP_URL", "https://internal.example.com");
    setEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
    setEnv("NODE_ENV", "production");
    assert.equal(getPublicAppBaseUrl(), "https://app.example.com");

    setEnv("NEXT_PUBLIC_APP_URL", undefined);
    assert.throws(() => getPublicAppBaseUrl(), /NEXT_PUBLIC_APP_URL/);

    setEnv("NODE_ENV", "development");
    assert.equal(
      getPublicAppBaseUrl({ requestOrigin: "http://localhost:3000" }),
      "http://localhost:3000"
    );
  } finally {
    setEnv("INTERNAL_APP_URL", previousInternal);
    setEnv("NEXT_PUBLIC_APP_URL", previousPublic);
    setEnv("NODE_ENV", previousNodeEnv);
  }
});
