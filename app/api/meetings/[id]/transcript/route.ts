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

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .single();

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("transcript_segments")
    .select("*")
    .eq("meeting_id", id)
    .order("started_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch transcript", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ segments: data });
}
