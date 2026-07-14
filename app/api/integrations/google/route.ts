import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { GOOGLE_INTEGRATION_PROVIDER } from "@/lib/google-integration";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function DELETE() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { error } = await supabaseAdmin
    .from("user_integrations")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("provider", GOOGLE_INTEGRATION_PROVIDER);

  if (error) {
    return NextResponse.json(
      { error: "Failed to disconnect Google.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
