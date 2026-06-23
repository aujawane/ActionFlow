import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

const allowedEvents = new Set(["password_change_verified", "password_change_failed"]);

export async function POST(request: Request) {
  const { user, response } = await requireApiUser();
  if (response) {
    return response;
  }

  const body = (await request.json().catch(() => null)) as {
    event_type?: string;
    metadata?: Record<string, unknown>;
  } | null;

  if (!body?.event_type || !allowedEvents.has(body.event_type)) {
    return NextResponse.json({ error: "Invalid event type." }, { status: 400 });
  }

  await supabaseAdmin.from("account_verification_events").insert({
    user_id: user.id,
    event_type: body.event_type,
    metadata: body.metadata ?? {}
  });

  return NextResponse.json({ ok: true });
}
