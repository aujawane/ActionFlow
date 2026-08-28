import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import {
  canEditMeetingUrl,
  MEETING_URL_LOCKED_MESSAGE,
  meetingDetailsPatchSchema
} from "@/lib/meeting-details";
import { detectMeetingPlatform } from "@/lib/meeting-platform";
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const { data: existingMeeting, error: loadError } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json(
      { error: "Failed to load meeting.", details: loadError.message },
      { status: 500 }
    );
  }
  if (!existingMeeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const parsed = meetingDetailsPatchSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid meeting details.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const meetingUrlChanged =
    parsed.data.meeting_url !== undefined &&
    parsed.data.meeting_url !== existingMeeting.meeting_url;
  if (meetingUrlChanged && !canEditMeetingUrl(existingMeeting)) {
    return NextResponse.json(
      { error: "Meeting link is locked.", details: MEETING_URL_LOCKED_MESSAGE },
      { status: 409 }
    );
  }

  const updates: { title?: string; meeting_url?: string; platform?: "google_meet" | "zoom" } = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (meetingUrlChanged && parsed.data.meeting_url !== undefined) {
    updates.meeting_url = parsed.data.meeting_url;
    const platform = detectMeetingPlatform(parsed.data.meeting_url);
    if (platform === "unknown") {
      return NextResponse.json({ error: "Unsupported meeting link." }, { status: 400 });
    }
    updates.platform = platform;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { meeting: existingMeeting },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  let updateQuery = supabaseAdmin
    .from("meetings")
    .update(updates)
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .is("deleted_at", null);
  if (meetingUrlChanged) {
    updateQuery = updateQuery.eq("status", "pending").is("recall_bot_id", null);
  }

  const { data: meeting, error: updateError } = await updateQuery
    .select("*")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json(
      { error: "Failed to update meeting.", details: updateError.message },
      { status: 500 }
    );
  }
  if (!meeting && meetingUrlChanged) {
    return NextResponse.json(
      { error: "Meeting link is locked.", details: MEETING_URL_LOCKED_MESSAGE },
      { status: 409 }
    );
  }
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  revalidatePath("/dashboard");
  revalidatePath(`/meetings/${id}`);
  revalidatePath("/projects");
  if (meeting.project_id) revalidatePath(`/projects/${meeting.project_id}`);

  return NextResponse.json(
    { meeting },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
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
