import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  const { origin } = new URL(request.url);
  const redirectTo = `${origin}/api/auth/callback?next=/account/reset-password`;

  await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo });

  return NextResponse.json({
    message: "If an account exists for that email, a secure password reset link has been sent."
  });
}
