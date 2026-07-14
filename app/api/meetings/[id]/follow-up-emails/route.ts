import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { loadMeetingFollowUpArtifacts } from "@/lib/meeting-follow-up-email-service";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const result = await loadMeetingFollowUpArtifacts(id, auth.user.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, details: result.details },
      { status: result.status }
    );
  }

  return NextResponse.json(
    { artifacts: result.artifacts },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
