import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getPublicSupabaseAnonKey,
  getPublicSupabaseUrl,
  getSupabaseEnvironment,
  getSupabaseServiceRoleKey,
  isTranscriptNormalizationEnabled,
  resolveSupabasePublicConfig
} from "../lib/env";

function setEnv(name: string, value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) {
    delete env[name];
    return;
  }
  env[name] = value;
}

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const SUPABASE_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_ENV",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_STAGING_SUPABASE_URL",
  "NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY",
  "STAGING_SUPABASE_SERVICE_ROLE_KEY"
];

function withSupabaseEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map(SUPABASE_ENV_VARS.map((name) => [name, process.env[name]]));
  try {
    for (const name of SUPABASE_ENV_VARS) setEnv(name, values[name]);
    run();
  } finally {
    for (const [name, value] of previous) setEnv(name, value);
  }
}

// ---------------------------------------------------------------------------
// resolveSupabasePublicConfig: the pure, shared browser+server decision logic
// ---------------------------------------------------------------------------

test("resolveSupabasePublicConfig resolves to the production pair when selected", () => {
  const result = resolveSupabasePublicConfig({
    supabaseEnv: "production",
    productionUrl: "https://prod.supabase.co",
    productionAnonKey: "prod-anon-key",
    stagingUrl: "https://staging.supabase.co",
    stagingAnonKey: "staging-anon-key"
  });
  assert.deepEqual(result, { url: "https://prod.supabase.co", anonKey: "prod-anon-key" });
});

test("resolveSupabasePublicConfig resolves to the staging pair when selected", () => {
  const result = resolveSupabasePublicConfig({
    supabaseEnv: "staging",
    productionUrl: "https://prod.supabase.co",
    productionAnonKey: "prod-anon-key",
    stagingUrl: "https://staging.supabase.co",
    stagingAnonKey: "staging-anon-key"
  });
  assert.deepEqual(result, { url: "https://staging.supabase.co", anonKey: "staging-anon-key" });
});

test("[no implicit default] a missing selector throws rather than defaulting to either environment", () => {
  assert.throws(
    () =>
      resolveSupabasePublicConfig({
        supabaseEnv: undefined,
        productionUrl: "https://prod.supabase.co",
        productionAnonKey: "prod-anon-key",
        stagingUrl: "https://staging.supabase.co",
        stagingAnonKey: "staging-anon-key"
      }),
    /Missing NEXT_PUBLIC_SUPABASE_ENV/
  );
});

test("an invalid selector value throws with a clear message", () => {
  assert.throws(
    () =>
      resolveSupabasePublicConfig({
        supabaseEnv: "prod", // not the exact literal "production"
        productionUrl: "https://prod.supabase.co",
        productionAnonKey: "prod-anon-key",
        stagingUrl: "https://staging.supabase.co",
        stagingAnonKey: "staging-anon-key"
      }),
    /Invalid NEXT_PUBLIC_SUPABASE_ENV "prod"/
  );
});

test("[no silent fallback] selecting production with production vars missing throws -- it never falls back to the present staging vars", () => {
  assert.throws(
    () =>
      resolveSupabasePublicConfig({
        supabaseEnv: "production",
        productionUrl: undefined,
        productionAnonKey: undefined,
        stagingUrl: "https://staging.supabase.co",
        stagingAnonKey: "staging-anon-key"
      }),
    /Missing NEXT_PUBLIC_SUPABASE_URL\/NEXT_PUBLIC_SUPABASE_ANON_KEY for NEXT_PUBLIC_SUPABASE_ENV=production/
  );
});

test("[no silent fallback] selecting staging with staging vars missing throws -- it never falls back to the present production vars", () => {
  assert.throws(
    () =>
      resolveSupabasePublicConfig({
        supabaseEnv: "staging",
        productionUrl: "https://prod.supabase.co",
        productionAnonKey: "prod-anon-key",
        stagingUrl: undefined,
        stagingAnonKey: undefined
      }),
    /Missing NEXT_PUBLIC_STAGING_SUPABASE_URL\/NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY for NEXT_PUBLIC_SUPABASE_ENV=staging/
  );
});

test("a whitespace-only selector is treated as missing, not as a valid (garbage) value", () => {
  assert.throws(
    () =>
      resolveSupabasePublicConfig({
        supabaseEnv: "   ",
        productionUrl: "https://prod.supabase.co",
        productionAnonKey: "prod-anon-key",
        stagingUrl: "https://staging.supabase.co",
        stagingAnonKey: "staging-anon-key"
      }),
    /Missing NEXT_PUBLIC_SUPABASE_ENV/
  );
});

// ---------------------------------------------------------------------------
// getSupabaseEnvironment / getSupabaseServiceRoleKey / getPublicSupabaseUrl / AnonKey:
// the server-side wrappers, exercised against real process.env
// ---------------------------------------------------------------------------

test("getSupabaseEnvironment reads NEXT_PUBLIC_SUPABASE_ENV and rejects anything but staging/production", () => {
  withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: "staging" }, () => {
    assert.equal(getSupabaseEnvironment(), "staging");
  });
  withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: "production" }, () => {
    assert.equal(getSupabaseEnvironment(), "production");
  });
  withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: undefined }, () => {
    assert.throws(() => getSupabaseEnvironment(), /Missing NEXT_PUBLIC_SUPABASE_ENV/);
  });
});

test("getPublicSupabaseUrl/getPublicSupabaseAnonKey both resolve to the selected environment consistently -- the same selector drives both", () => {
  withSupabaseEnv(
    {
      NEXT_PUBLIC_SUPABASE_ENV: "staging",
      NEXT_PUBLIC_STAGING_SUPABASE_URL: "https://staging.supabase.co",
      NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY: "staging-anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "prod-anon-key"
    },
    () => {
      assert.equal(getPublicSupabaseUrl(), "https://staging.supabase.co");
      assert.equal(getPublicSupabaseAnonKey(), "staging-anon-key");
    }
  );
});

test("[Fix: admin/service-role client follows the same selector] getSupabaseServiceRoleKey resolves STAGING_SUPABASE_SERVICE_ROLE_KEY when staging is selected, never SUPABASE_SERVICE_ROLE_KEY", () => {
  withSupabaseEnv(
    {
      NEXT_PUBLIC_SUPABASE_ENV: "staging",
      STAGING_SUPABASE_SERVICE_ROLE_KEY: "staging-service-role",
      SUPABASE_SERVICE_ROLE_KEY: "prod-service-role"
    },
    () => {
      assert.equal(getSupabaseServiceRoleKey(), "staging-service-role");
    }
  );
});

test("getSupabaseServiceRoleKey resolves SUPABASE_SERVICE_ROLE_KEY when production is selected, never the staging key", () => {
  withSupabaseEnv(
    {
      NEXT_PUBLIC_SUPABASE_ENV: "production",
      STAGING_SUPABASE_SERVICE_ROLE_KEY: "staging-service-role",
      SUPABASE_SERVICE_ROLE_KEY: "prod-service-role"
    },
    () => {
      assert.equal(getSupabaseServiceRoleKey(), "prod-service-role");
    }
  );
});

test("getSupabaseServiceRoleKey fails fast (does not fall back) when the selected environment's own service-role key is missing, even if the other one is present", () => {
  withSupabaseEnv(
    {
      NEXT_PUBLIC_SUPABASE_ENV: "staging",
      STAGING_SUPABASE_SERVICE_ROLE_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "prod-service-role"
    },
    () => {
      assert.throws(
        () => getSupabaseServiceRoleKey(),
        /Missing STAGING_SUPABASE_SERVICE_ROLE_KEY for NEXT_PUBLIC_SUPABASE_ENV=staging/
      );
    }
  );
});

// ---------------------------------------------------------------------------
// TRANSCRIPT_NORMALIZATION_ENABLED remains fully independent of Supabase environment selection
// ---------------------------------------------------------------------------

test("TRANSCRIPT_NORMALIZATION_ENABLED is unaffected by NEXT_PUBLIC_SUPABASE_ENV or which Supabase vars are configured", () => {
  const previousFlag = process.env.TRANSCRIPT_NORMALIZATION_ENABLED;
  try {
    setEnv("TRANSCRIPT_NORMALIZATION_ENABLED", "true");
    withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: "staging" }, () => {
      assert.equal(isTranscriptNormalizationEnabled(), true);
    });
    withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: "production" }, () => {
      assert.equal(isTranscriptNormalizationEnabled(), true);
    });
    withSupabaseEnv({ NEXT_PUBLIC_SUPABASE_ENV: undefined }, () => {
      // Even with the Supabase selector entirely unset (which would break Supabase resolution),
      // the transcript-normalization flag must still read correctly -- fully independent env.
      assert.equal(isTranscriptNormalizationEnabled(), true);
    });

    setEnv("TRANSCRIPT_NORMALIZATION_ENABLED", "false");
    assert.equal(isTranscriptNormalizationEnabled(), false);
  } finally {
    setEnv("TRANSCRIPT_NORMALIZATION_ENABLED", previousFlag);
  }
});

test("lib/env.ts's transcript-normalization functions never read any SUPABASE_* env var", async () => {
  const source = await readSource("lib/env.ts");
  const fnMatch = source.match(/export function isTranscriptNormalizationEnabled\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.doesNotMatch(fnMatch![0], /SUPABASE/);
});

// ---------------------------------------------------------------------------
// Browser-safety: the service-role key must never be reachable from browser-bundled code
// ---------------------------------------------------------------------------

test("[security] lib/supabase/client.ts (browser, 'use client') never references any service-role key", async () => {
  const source = await readSource("lib/supabase/client.ts");
  assert.match(source, /"use client";/);
  assert.doesNotMatch(source, /SERVICE_ROLE/);
});

test("[security] the browser client reads literal process.env.NEXT_PUBLIC_* expressions (required for Next.js build-time inlining), not a dynamic lookup", async () => {
  const source = await readSource("lib/supabase/client.ts");
  assert.match(source, /process\.env\.NEXT_PUBLIC_SUPABASE_ENV/);
  assert.match(source, /process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(source, /process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.match(source, /process\.env\.NEXT_PUBLIC_STAGING_SUPABASE_URL/);
  assert.match(source, /process\.env\.NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY/);
  assert.match(source, /resolveSupabasePublicConfig\(\{/);
});

test("[security] middleware resolves Supabase config via the same shared resolver and literal env reads, with no silent empty-string fallback", async () => {
  const source = await readSource("lib/supabase/middleware.ts");
  assert.doesNotMatch(source, /SERVICE_ROLE/);
  assert.match(source, /resolveSupabasePublicConfig\(\{/);
  assert.doesNotMatch(source, /\?\.trim\(\) \|\| ""/);
});

test("[security] the admin (service-role) client resolves its key via getSupabaseServiceRoleKey, following the same selector as the browser/anon client", async () => {
  const source = await readSource("lib/supabase/admin.ts");
  assert.match(source, /import \{ getPublicSupabaseUrl, getSupabaseServiceRoleKey \} from "@\/lib\/env";/);
  assert.match(source, /const serviceRoleKey = getSupabaseServiceRoleKey\(\);/);
});

// ---------------------------------------------------------------------------
// coreEnvSchema no longer unconditionally requires Supabase vars regardless of selected env
// ---------------------------------------------------------------------------

test("coreEnvSchema does not unconditionally require NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/SUPABASE_SERVICE_ROLE_KEY -- Supabase validation is conditional on the selected environment instead", async () => {
  const source = await readSource("lib/env.ts");
  const schemaMatch = source.match(/const coreEnvSchema = z\.object\(\{[\s\S]*?\n\}\);/);
  assert.ok(schemaMatch);
  assert.doesNotMatch(schemaMatch![0], /NEXT_PUBLIC_SUPABASE_URL/);
  assert.doesNotMatch(schemaMatch![0], /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(schemaMatch![0], /SUPABASE_SERVICE_ROLE_KEY/);
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

test(".env.example documents NEXT_PUBLIC_SUPABASE_ENV and both the production and staging variable pairs", async () => {
  const source = await readSource(".env.example");
  assert.match(source, /NEXT_PUBLIC_SUPABASE_ENV=staging/);
  assert.match(source, /NEXT_PUBLIC_STAGING_SUPABASE_URL=/);
  assert.match(source, /NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY=/);
  assert.match(source, /STAGING_SUPABASE_SERVICE_ROLE_KEY=/);
});
