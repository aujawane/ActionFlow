import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const MAX_REQUESTS_PER_WINDOW = 3;
const WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request) {
  const { user, response } = await requireApiUser();
  if (response) {
    return response;
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const { count } = await supabaseAdmin
    .from("account_verification_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("event_type", "password_code_requested")
    .gte("created_at", since);

  if ((count ?? 0) >= MAX_REQUESTS_PER_WINDOW) {
    await supabaseAdmin.from("account_verification_events").insert({
      user_id: user.id,
      event_type: "password_code_rate_limited",
      metadata: { ip }
    });

    return NextResponse.json(
      { error: "Please wait before requesting another verification code." },
      { status: 429 }
    );
  }

  if (!user.email) {
    return NextResponse.json({ error: "No email address found for this account." }, { status: 400 });
  }

  const { error } = await supabaseAdmin.auth.signInWithOtp({
    email: user.email,
    options: { shouldCreateUser: false }
  });

  await supabaseAdmin.from("account_verification_events").insert({
    user_id: user.id,
    event_type: "password_code_requested",
    metadata: { ip, delivered_to: user.email }
  });

  if (error) {
    return NextResponse.json(
      { error: "Unable to send a verification code right now." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    message: "Verification code sent. Codes expire according to your Supabase Auth email OTP settings."
  });
}
