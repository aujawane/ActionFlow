import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api-auth";
import { buildProjectBrainContext } from "@/lib/project-brain/context";
import {
  normalizeOperationsForApply,
  validateAndCanonicalizeOperationOwners,
  validateAndCanonicalizePersonCorrection,
  validateProposalTargets
} from "@/lib/project-brain/operations";
import { projectProposalReviewSchema } from "@/lib/project-brain/schemas";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; proposalId: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id, proposalId } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const parsed = projectProposalReviewSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    console.warn("[ProjectBrain] selected operations rejected", {
      project_id: id,
      proposal_id: proposalId,
      user_id: auth.user.id,
      issues: parsed.error.issues
    });
    return NextResponse.json(
      { error: "Invalid proposal operations.", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const serialized = JSON.stringify(parsed.data.operations);
  if (serialized.length > 250_000) {
    return NextResponse.json({ error: "Proposal is too large." }, { status: 413 });
  }

  const [{ data: proposal }, brainContext] = await Promise.all([
    supabaseAdmin
      .from("project_change_proposals")
      .select("*")
      .eq("id", proposalId)
      .eq("project_id", id)
      .maybeSingle(),
    buildProjectBrainContext(id, auth.user.id)
  ]);
  if (!proposal || !brainContext) {
    return NextResponse.json({ error: "Proposal not found." }, { status: 404 });
  }
  if (!["pending_review", "approved"].includes(proposal.status)) {
    return NextResponse.json(
      { error: "This proposal can no longer be applied." },
      { status: 409 }
    );
  }

  console.info("[ProjectBrain] selected operations submitted", {
    project_id: id,
    proposal_id: proposalId,
    user_id: auth.user.id,
    operations: parsed.data.operations.map((operation) => operation.type)
  });

  const targetValidation = validateProposalTargets(parsed.data.operations, brainContext);
  if (!targetValidation.ok) {
    return NextResponse.json(
      { error: targetValidation.message, reason: targetValidation.reason },
      { status: targetValidation.reason === "stale_execution_target" ? 409 : 400 }
    );
  }

  const ownerValidation = validateAndCanonicalizeOperationOwners(
    parsed.data.operations,
    brainContext
  );
  if (!ownerValidation.ok) {
    return NextResponse.json(
      { error: ownerValidation.message, reason: "invalid_owner" },
      { status: 400 }
    );
  }

  const identityOperations = ownerValidation.operations.filter(
    (operation) => operation.type === "correct_project_person"
  );
  if (identityOperations.length > 0 && ownerValidation.operations.length !== 1) {
    return NextResponse.json(
      { error: "Person identity corrections must be reviewed and applied on their own." },
      { status: 400 }
    );
  }
  const identityValidation = identityOperations[0]?.type === "correct_project_person"
    ? validateAndCanonicalizePersonCorrection(identityOperations[0], brainContext)
    : null;
  if (identityValidation && !identityValidation.ok) {
    return NextResponse.json(
      { error: identityValidation.message, reason: "invalid_person_correction" },
      { status: 409 }
    );
  }

  const operationsForApply = identityValidation?.ok
    ? [identityValidation.operation]
    : normalizeOperationsForApply(ownerValidation.operations);
  console.info("[ProjectBrain] operations passed to apply RPC", {
    project_id: id,
    proposal_id: proposalId,
    user_id: auth.user.id,
    operations: operationsForApply.map((operation) => operation.type),
    requested_operations: parsed.data.operations.map(
      (operation) => operation.type
    )
  });

  // apply_project_change_proposal_with_dependency_provenance atomically applies the proposal
  // AND marks manual dependency provenance for any approved add_dependency/remove_dependency
  // operations in one Postgres function invocation -- see the migration comment for why this
  // must not be two separate calls (a failure between them could leave a human-approved
  // dependency decision readable as AI-unlocked). The existing, untouched
  // apply_project_change_proposal is still what it calls internally.
  const { data, error } = identityValidation?.ok
    ? await supabaseAdmin.rpc("apply_project_person_correction", {
        p_proposal_id: proposalId,
        p_actor_id: auth.user.id,
        p_operation: identityValidation.operation
      })
    : await supabaseAdmin.rpc("apply_project_change_proposal_with_dependency_provenance", {
        p_proposal_id: proposalId,
        p_actor_id: auth.user.id,
        p_operations: operationsForApply
      });
  if (error) {
    await supabaseAdmin
      .from("project_change_proposals")
      .update({ status: "failed" })
      .eq("id", proposalId)
      .eq("status", "pending_review");
    return NextResponse.json(
      { error: "The proposal could not be applied. No changes were saved.", details: error.message },
      { status: 409 }
    );
  }
  if (data?.stale) {
    return NextResponse.json(
      {
        error: "The project changed after this proposal was created.",
        stale: true,
        currentGraphVersion: data.currentGraphVersion
      },
      { status: 409 }
    );
  }

  revalidatePath(`/projects/${id}`);
  revalidatePath("/projects");
  revalidatePath("/dashboard");
  const taskById = new Map(
    brainContext.tasks.map((task) => [String(task.id), task])
  );
  const commitmentById = new Map(
    brainContext.milestones.map((commitment) => [String(commitment.id), commitment])
  );
  for (const operation of ownerValidation.operations) {
    if (operation.type === "correct_project_person") {
      for (const reference of operation.affectedReferences) {
        if (reference.type === "task") revalidatePath(`/tasks/${reference.id}`);
        if (reference.type === "commitment") {
          revalidatePath(`/commitments/${reference.id}`);
        }
      }
    }
    if ("taskId" in operation) {
      revalidatePath(`/tasks/${operation.taskId}`);
      const task = taskById.get(operation.taskId);
      if (typeof task?.commitment_id === "string") {
        revalidatePath(`/commitments/${task.commitment_id}`);
      }
      if (typeof task?.meeting_id === "string") {
        revalidatePath(`/meetings/${task.meeting_id}`);
      }
    }
    if ("milestoneId" in operation) {
      revalidatePath(`/commitments/${operation.milestoneId}`);
      const commitment = commitmentById.get(operation.milestoneId);
      if (typeof commitment?.meeting_id === "string") {
        revalidatePath(`/meetings/${commitment.meeting_id}`);
      }
    }
  }
  console.info("[ProjectBrain] proposal operations applied", {
    project_id: id,
    proposal_id: proposalId,
    user_id: auth.user.id,
    operations: parsed.data.operations.map((operation) => operation.type),
    resulting_graph_version: data?.resultingGraphVersion ?? null
  });
  return NextResponse.json({
    result: data,
    appliedOperations: parsed.data.operations.map((operation) => operation.type)
  });
}
