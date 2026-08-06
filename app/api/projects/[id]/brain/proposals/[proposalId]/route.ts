import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { projectProposalReviewSchema } from "@/lib/project-brain/schemas";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reject") }).strict(),
  z
    .object({
      action: z.literal("save"),
      operations: projectProposalReviewSchema.shape.operations
    })
    .strict()
]);

async function getProposal(projectId: string, proposalId: string) {
  return supabaseAdmin
    .from("project_change_proposals")
    .select("*")
    .eq("id", proposalId)
    .eq("project_id", projectId)
    .maybeSingle();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; proposalId: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id, proposalId } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const { data } = await getProposal(id, proposalId);
  if (!data) {
    return NextResponse.json({ error: "Proposal not found." }, { status: 404 });
  }
  return NextResponse.json({ proposal: data });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; proposalId: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id, proposalId } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid proposal review." }, { status: 400 });
  }
  const { data: proposal } = await getProposal(id, proposalId);
  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found." }, { status: 404 });
  }
  if (!["pending_review", "draft"].includes(proposal.status)) {
    return NextResponse.json(
      { error: "This proposal can no longer be edited." },
      { status: 409 }
    );
  }
  const update =
    parsed.data.action === "reject"
      ? {
          status: "rejected",
          rejected_at: new Date().toISOString()
        }
      : {
          proposal: { operations: parsed.data.operations }
        };
  const { data, error } = await supabaseAdmin
    .from("project_change_proposals")
    .update(update)
    .eq("id", proposalId)
    .eq("project_id", id)
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to update proposal.", details: error?.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ proposal: data });
}
