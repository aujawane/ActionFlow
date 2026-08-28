import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { meetingProjectAssignmentSchema } from "@/lib/meeting-details";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const parsed = meetingProjectAssignmentSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid project assignment.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("id, project_id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (meetingError) {
    return NextResponse.json(
      { error: "Failed to load meeting.", details: meetingError.message },
      { status: 500 }
    );
  }
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  let projectId = parsed.data.project_id ?? null;
  let createdProjectId: string | null = null;
  if (parsed.data.new_project) {
    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .insert({
        ...parsed.data.new_project,
        owner_id: auth.user.id,
        status: "planning"
      })
      .select("*")
      .single();
    if (error || !project) {
      return NextResponse.json(
        { error: "Failed to create project.", details: error?.message },
        { status: 500 }
      );
    }
    projectId = project.id;
    createdProjectId = project.id;
  } else if (projectId) {
    const { data: project, error: projectError } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("owner_id", auth.user.id)
      .maybeSingle();
    if (projectError) {
      return NextResponse.json(
        { error: "Failed to load project.", details: projectError.message },
        { status: 500 }
      );
    }
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
  }

  const { error } = await supabaseAdmin.rpc("assign_meeting_project", {
    p_meeting_id: id,
    p_project_id: projectId
  });
  if (error) {
    if (createdProjectId) {
      await supabaseAdmin.from("projects").delete().eq("id", createdProjectId);
    }
    return NextResponse.json(
      { error: "Failed to assign project.", details: error.message },
      { status: 500 }
    );
  }

  const { data: updatedMeeting, error: updatedMeetingError } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .single();
  if (updatedMeetingError || !updatedMeeting) {
    return NextResponse.json(
      {
        error: "Project assigned, but failed to reload meeting.",
        details: updatedMeetingError?.message
      },
      { status: 500 }
    );
  }

  revalidatePath("/dashboard");
  revalidatePath(`/meetings/${id}`);
  revalidatePath("/projects");
  if (meeting.project_id) revalidatePath(`/projects/${meeting.project_id}`);
  if (projectId) revalidatePath(`/projects/${projectId}`);

  return NextResponse.json(
    { project_id: projectId, meeting: updatedMeeting },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
