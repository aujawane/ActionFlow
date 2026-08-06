import { NextRequest, NextResponse } from "next/server";

import {
  RECOVERY_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_COOKIE_NAME,
  completeAuthCallback,
  recoveryErrorPath,
  sanitizeInternalPath
} from "@/lib/password-recovery";
import { createSupabaseRouteClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const providerError = searchParams.get("error") || searchParams.get("error_code");
  const next = sanitizeInternalPath(searchParams.get("next"), "/dashboard");
  const isRecoveryDestination = next === "/account/reset-password";
  const response = NextResponse.redirect(new URL(next, origin));
  const supabase = createSupabaseRouteClient(request, response);
  const callback = await completeAuthCallback({
    code,
    tokenHash,
    type,
    providerError,
    auth: supabase.auth
  });
  const authError = callback.error;

  if (authError) {
    const reason = callback.credentialKind === "missing" && !providerError
      ? "missing_credentials"
      : "invalid_or_expired";
    response.headers.set("location", new URL(recoveryErrorPath(reason), origin).toString());
  } else if (isRecoveryDestination) {
    response.cookies.set(RECOVERY_COOKIE_NAME, "active", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS
    });
  }

  if (process.env.NODE_ENV === "development") {
    console.info("[password-recovery] callback", {
      has_code: Boolean(code),
      has_token_hash: Boolean(tokenHash),
      has_recovery_type: type === "recovery",
      session_established: !authError,
      destination: authError ? recoveryErrorPath(
        callback.credentialKind === "missing" && !providerError
          ? "missing_credentials"
          : "invalid_or_expired"
      ) : next,
      error_name: authError?.name,
      error_message: authError?.message
    });
  }

  return response;
}
