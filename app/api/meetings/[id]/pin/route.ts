import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { is_pinned?: unknown } | null;

  if (typeof body?.is_pinned !== "boolean") {
    return NextResponse.json({ error: "is_pinned must be a boolean." }, { status: 400 });
  }

  const { data: meeting, error } = await supabaseAdmin
    .from("meetings")
    .update({ is_pinned: body.is_pinned })
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .select("*")
    .single();

  if (error || !meeting) {
    return NextResponse.json(
      { error: "Meeting not found.", details: error?.message },
      { status: 404 }
    );
  }

  return NextResponse.json({ meeting });
}
