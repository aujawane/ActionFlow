import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { buildMeetingGenerationMap, filterEligibleMoveDestinations } from "@/lib/execution-corrections";
import { getOwnedTask } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Meeting, MeetingCommitment } from "@/lib/types";

/**
 * Lists commitments this task could safely be moved into: same project (or same meeting if the
 * task isn't project-linked), current-generation, non-dismissed, committed-classification. Kept
 * as its own lazily-fetched endpoint (rather than threading a pre-fetched list through every
 * page that can show a task) so "Move to commitment" stays self-contained wherever a task card
 * renders.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const task = await getOwnedTask(id, auth.user.id);
  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  const { data: candidates } = task.project_id
    ? await supabaseAdmin
        .from("meeting_commitments")
        .select("*")
        .eq("project_id", task.project_id)
    : await supabaseAdmin
        .from("meeting_commitments")
        .select("*")
        .eq("meeting_id", task.meeting_id);

  const safeCandidates = (candidates ?? []) as MeetingCommitment[];
  const meetingIds = Array.from(new Set(safeCandidates.map((commitment) => commitment.meeting_id)));
  const { data: meetings } = meetingIds.length
    ? await supabaseAdmin
        .from("meetings")
        .select("id, execution_graph_generation")
        .in("id", meetingIds)
    : { data: [] as Meeting[] };

  const eligible = filterEligibleMoveDestinations({
    task,
    candidates: safeCandidates.filter((commitment) => commitment.id !== task.commitment_id),
    meetingGenerationById: buildMeetingGenerationMap((meetings ?? []) as Meeting[])
  });

  return NextResponse.json({
    commitments: eligible.map((commitment) => ({ id: commitment.id, title: commitment.title }))
  });
}
