"use client";

import { createBrowserClient } from "@supabase/ssr";

import { resolveSupabasePublicConfig } from "@/lib/env";

export function createSupabaseBrowserClient() {
  // Each process.env.NEXT_PUBLIC_* reference below must stay a literal expression, right here,
  // for Next.js to inline its build-time value into the browser bundle -- resolveSupabasePublicConfig
  // itself does no process.env access, so the staging-vs-production decision logic still lives in
  // exactly one place (lib/env.ts) even though the values have to be read here.
  const { url, anonKey } = resolveSupabasePublicConfig({
    supabaseEnv: process.env.NEXT_PUBLIC_SUPABASE_ENV,
    productionUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    productionAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    stagingUrl: process.env.NEXT_PUBLIC_STAGING_SUPABASE_URL,
    stagingAnonKey: process.env.NEXT_PUBLIC_STAGING_SUPABASE_ANON_KEY
  });

  return createBrowserClient(url, anonKey);
}
