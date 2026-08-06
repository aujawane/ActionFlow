import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const { data, error } = await supabaseAdmin
    .from("project_chat_threads")
    .insert({
      project_id: id,
      title: "Project Brain",
      created_by: auth.user.id
    })
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to start a new draft conversation.", details: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ thread: data, messages: [], proposals: [] }, { status: 201 });
}
