import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getTaskWorkspaceContext } from "@/lib/task-workspace";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const workspaceContext = await getTaskWorkspaceContext(id, auth.user.id);
  if (!workspaceContext.ok) {
    return NextResponse.json(
      { error: workspaceContext.error, details: workspaceContext.details },
      { status: workspaceContext.status }
    );
  }

  const { data: artifacts, error } = await supabaseAdmin
    .from("task_artifacts")
    .select("*")
    .eq("task_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Failed to load task artifacts.", details: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ artifacts: artifacts ?? [] });
}
