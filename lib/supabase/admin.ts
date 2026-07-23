import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicSupabaseUrl, requireEnv } from "@/lib/env";

/**
 * Lazy Supabase service-role client.
 *
 * Avoids throwing during Next.js build-time route collection when secrets are
 * only available at runtime (Vercel). The first real request initializes the
 * client and fails fast if configuration is missing.
 */
let supabaseAdminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdminClient) {
    return supabaseAdminClient;
  }

  const supabaseUrl = getPublicSupabaseUrl();
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  supabaseAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false
    }
  });

  return supabaseAdminClient;
}

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    const client = getSupabaseAdmin() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  }
});
