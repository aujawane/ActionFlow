import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import {
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  GOOGLE_INTEGRATION_PROVIDER,
  verifyGoogleOAuthState
} from "@/lib/google-integration";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { UserIntegration } from "@/lib/types";

function redirectToIntegrations(request: Request, params: Record<string, string>) {
  const url = new URL("/account/integrations", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

function getExpiresAt(expiresIn?: number) {
  if (!expiresIn || !Number.isFinite(expiresIn)) {
    return null;
  }

  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) {
    return redirectToIntegrations(request, {
      google: "error",
      message: "Please sign in before connecting Google."
    });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return redirectToIntegrations(request, {
      google: "error",
      message: oauthError
    });
  }

  if (!code || !state || !verifyGoogleOAuthState(state, auth.user.id)) {
    return redirectToIntegrations(request, {
      google: "error",
      message: "Invalid Google OAuth callback."
    });
  }

  try {
    const tokens = await exchangeGoogleAuthorizationCode(code);
    const { data: existingIntegration } = await supabaseAdmin
      .from("user_integrations")
      .select("*")
      .eq("user_id", auth.user.id)
      .eq("provider", GOOGLE_INTEGRATION_PROVIDER)
      .maybeSingle();

    const userInfo = await fetchGoogleUserInfo(tokens.access_token!);
    const existing = existingIntegration as UserIntegration | null;
    const refreshToken = tokens.refresh_token ?? existing?.refresh_token ?? null;

    if (!refreshToken) {
      return redirectToIntegrations(request, {
        google: "error",
        message: "Google did not return a refresh token. Try connecting again."
      });
    }

    const { error: upsertError } = await supabaseAdmin
      .from("user_integrations")
      .upsert(
        {
          user_id: auth.user.id,
          provider: GOOGLE_INTEGRATION_PROVIDER,
          access_token: tokens.access_token ?? null,
          refresh_token: refreshToken,
          expires_at: getExpiresAt(tokens.expires_in),
          scope: tokens.scope ?? null,
          provider_account_email:
            userInfo?.email ?? existing?.provider_account_email ?? auth.user.email ?? null
        },
        { onConflict: "user_id,provider" }
      );

    if (upsertError) {
      return redirectToIntegrations(request, {
        google: "error",
        message: "Failed to save Google integration."
      });
    }

    return redirectToIntegrations(request, { google: "connected" });
  } catch (error) {
    return redirectToIntegrations(request, {
      google: "error",
      message: error instanceof Error ? error.message : "Google connection failed."
    });
  }
}
