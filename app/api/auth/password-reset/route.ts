import { NextRequest, NextResponse } from "next/server";

import { getPublicAppBaseUrl } from "@/lib/env";
import {
  PASSWORD_RESET_RESPONSE_MESSAGE,
  buildPasswordResetCallbackUrl,
  initiatePasswordReset
} from "@/lib/password-recovery";
import { createSupabaseRouteClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  const response = NextResponse.json({ message: PASSWORD_RESET_RESPONSE_MESSAGE });
  const { origin } = new URL(request.url);
  const redirectTo = buildPasswordResetCallbackUrl(
    getPublicAppBaseUrl({ requestOrigin: origin })
  );
  const supabase = createSupabaseRouteClient(request, response);
  const { error } = await initiatePasswordReset({
    email,
    redirectTo,
    resetPasswordForEmail: (address, options) =>
      supabase.auth.resetPasswordForEmail(address, options)
  });

  if (process.env.NODE_ENV === "development") {
    console.info("[password-recovery] reset requested", {
      callback_configured: true,
      succeeded: !error,
      error_name: error?.name,
      error_message: error?.message
    });
  }

  // Deliberately return the same response for known and unknown addresses.
  return response;
}
