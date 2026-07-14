import { IntegrationsSettingsClient } from "@/components/integrations-settings-client";
import { requireUser } from "@/lib/auth";
import { GOOGLE_INTEGRATION_PROVIDER } from "@/lib/google-integration";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { UserIntegration } from "@/lib/types";

function getMessage(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value : null;
}

export default async function IntegrationsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const { data: integration } = await supabaseAdmin
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", GOOGLE_INTEGRATION_PROVIDER)
    .maybeSingle();

  const googleIntegration = integration as UserIntegration | null;
  const successMessage =
    getMessage(params.google) === "connected" ? "Google Meet connected." : null;
  const errorMessage = getMessage(params.google) === "error" ? getMessage(params.message) : null;

  return (
    <IntegrationsSettingsClient
      googleIntegration={
        googleIntegration
          ? {
              provider: googleIntegration.provider,
              connected: Boolean(googleIntegration.refresh_token),
              provider_account_email: googleIntegration.provider_account_email,
              scope: googleIntegration.scope,
              expires_at: googleIntegration.expires_at,
              updated_at: googleIntegration.updated_at
            }
          : null
      }
      statusMessage={successMessage}
      errorMessage={errorMessage}
    />
  );
}
