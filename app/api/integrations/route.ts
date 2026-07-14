import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { UserIntegration } from "@/lib/types";

function sanitizeIntegration(integration: UserIntegration) {
  return {
    id: integration.id,
    provider: integration.provider,
    connected: Boolean(integration.refresh_token),
    provider_account_email: integration.provider_account_email,
    scope: integration.scope,
    expires_at: integration.expires_at,
    created_at: integration.created_at,
    updated_at: integration.updated_at
  };
}

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { data: integrations, error } = await supabaseAdmin
    .from("user_integrations")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to load integrations.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    integrations: ((integrations ?? []) as UserIntegration[]).map(sanitizeIntegration)
  });
}
