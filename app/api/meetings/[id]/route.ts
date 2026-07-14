import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: meeting, error } = await supabaseAdmin
    .from("meetings")
    .select("id, status, updated_at")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();

  if (error || !meeting) {
    return NextResponse.json(
      { error: "Meeting not found.", details: error?.message },
      { status: 404 }
    );
  }

  return NextResponse.json(
    { meeting },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: meeting, error } = await supabaseAdmin
    .from("meetings")
    .update({ deleted_at: new Date().toISOString(), is_pinned: false })
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !meeting) {
    return NextResponse.json(
      { error: "Meeting not found.", details: error?.message },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, meetingId: id });
}
