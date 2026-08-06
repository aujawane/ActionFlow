import { NextRequest, NextResponse } from "next/server";

import {
  RECOVERY_COOKIE_NAME,
  updateRecoveryPassword
} from "@/lib/password-recovery";
import { createSupabaseRouteClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    password?: unknown;
    confirmPassword?: unknown;
  } | null;
  const response = NextResponse.json({ message: "Password updated successfully." });
  const supabase = createSupabaseRouteClient(request, response);
  const result = await updateRecoveryPassword({
    password: body?.password,
    confirmPassword: body?.confirmPassword,
    hasRecoveryMarker:
      request.cookies.get(RECOVERY_COOKIE_NAME)?.value === "active",
    getUser: async () => {
      const { data, error } = await supabase.auth.getUser();
      return { user: data.user, error };
    },
    updateUser: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      return { error };
    }
  });
  if (!result.ok) {
    if (process.env.NODE_ENV === "development") {
      console.info("[password-recovery] password update failed", {
        error_name: result.status === 401 ? "RecoverySessionError" : "PasswordUpdateError",
        error_message: result.error
      });
    }
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  response.cookies.set(RECOVERY_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}
