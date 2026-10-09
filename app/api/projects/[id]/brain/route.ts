import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { runProjectBrainAgent } from "@/lib/project-brain/agent";
import { buildProjectBrainContext } from "@/lib/project-brain/context";
import {
  buildDirectEditConfirmationMessage,
  executeDirectCommitmentEdits,
  hasExplicitCommitmentMutationIntent,
  prepareDirectCommitmentEdits
} from "@/lib/project-brain/direct-commitment-edit";
import {
  validateAndCanonicalizeOperationOwners,
  validateProposalTargets
} from "@/lib/project-brain/operations";
import type { ProjectBrainResponse } from "@/lib/project-brain/schemas";
import { getOwnedProject } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 90;

const messageSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    threadId: z.string().uuid().nullable().optional()
  })
  .strict();

async function latestThread(projectId: string, userId: string) {
  return supabaseAdmin
    .from("project_chat_threads")
    .select("*")
    .eq("project_id", projectId)
    .eq("created_by", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const { data: thread } = await latestThread(id, auth.user.id);
  if (!thread) {
    return NextResponse.json({ thread: null, messages: [], proposals: [] });
  }
  const [{ data: messages }, { data: proposals }] = await Promise.all([
    supabaseAdmin
      .from("project_chat_messages")
      .select("*")
      .eq("thread_id", thread.id)
      .order("created_at", { ascending: true })
      .limit(200),
    supabaseAdmin
      .from("project_change_proposals")
      .select("*")
      .eq("thread_id", thread.id)
      .order("created_at", { ascending: true })
  ]);
  return NextResponse.json(
    { thread, messages: messages ?? [], proposals: proposals ?? [] },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await routeContext.params;
  if (!(await getOwnedProject(id, auth.user.id))) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Message is required and must be 4,000 characters or fewer." },
      { status: 400 }
    );
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabaseAdmin
    .from("project_chat_messages")
    .select("*", { count: "exact", head: true })
    .eq("project_id", id)
    .eq("created_by", auth.user.id)
    .gte("created_at", since);
  if ((count ?? 0) >= 12) {
    return NextResponse.json(
      { error: "Too many Project Brain messages. Try again in a minute." },
      { status: 429 }
    );
  }

  let thread: Record<string, unknown> | null = null;
  if (parsed.data.threadId) {
    const { data } = await supabaseAdmin
      .from("project_chat_threads")
      .select("*")
      .eq("id", parsed.data.threadId)
      .eq("project_id", id)
      .eq("created_by", auth.user.id)
      .maybeSingle();
    thread = data;
  } else {
    const { data } = await latestThread(id, auth.user.id);
    thread = data;
  }
  if (!thread) {
    const { data, error } = await supabaseAdmin
      .from("project_chat_threads")
      .insert({
        project_id: id,
        created_by: auth.user.id,
        title: "Project Brain"
      })
      .select("*")
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: "Failed to create Project Brain thread.", details: error?.message },
        { status: 500 }
      );
    }
    thread = data;
  }

  const threadId = String((thread as { id: string }).id);
  const [{ data: history }, projectContext] = await Promise.all([
    supabaseAdmin
      .from("project_chat_messages")
      .select("role,content")
      .eq("thread_id", threadId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(20),
    buildProjectBrainContext(id, auth.user.id)
  ]);
  if (!projectContext) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const { data: userMessage, error: userError } = await supabaseAdmin
    .from("project_chat_messages")
    .insert({
      thread_id: threadId,
      project_id: id,
      role: "user",
      content: parsed.data.message,
      created_by: auth.user.id,
      metadata: { source: "project_brain" }
    })
    .select("*")
    .single();
  if (userError || !userMessage) {
    return NextResponse.json(
      { error: "Failed to save message.", details: userError?.message },
      { status: 500 }
    );
  }

  const agent = await runProjectBrainAgent({
    context: projectContext,
    history: (history ?? [])
      .reverse()
      .flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, content: message.content }]
          : []
      ),
    message: parsed.data.message
  });
  let result: ProjectBrainResponse = agent.ok
    ? agent.result
    : {
        responseType: "answer" as const,
        message:
          "I saved your message but could not interpret it safely. Please retry.",
        proposal: null,
        references: [],
        warnings: [agent.error]
      };
  console.info("[ProjectBrain] interpreted response", {
    project_id: id,
    user_id: auth.user.id,
    response_type: result.responseType,
    model: agent.ok ? agent.model : null,
    validated_operations:
      result.proposal?.operations.map((operation) => operation.type) ?? [],
    warnings: result.warnings
  });

  // Direct-edit fast path: an explicit, low-risk commitment field edit (title/description/
  // owner/due_date/priority/status -- see lib/project-brain/direct-commitment-edit.ts) executes
  // immediately instead of becoming a pending_review proposal. Anything more complex --
  // create/merge/archive a commitment, any task operation, person-identity corrections, etc. --
  // is left completely untouched below and still goes through the existing proposal/"Approve &
  // apply" review flow. Re-validates targets and owners against the SAME fresh project context
  // this request already loaded (never trusting the model's operations as-is), matching the
  // apply route's own validation discipline one step earlier, before persistence instead of at
  // click-time.
  //
  // Execution requires BOTH an eligible operation shape AND a deterministic, server-side read
  // of explicit mutation intent on the CURRENT user message (parsed.data.message, never earlier
  // history) -- the model's own operation output and self-reported confidence are not trusted
  // as proof of intent on their own. This also means a clarification/answer response (no
  // proposal at all) can never reach this block regardless of message wording, since the outer
  // condition below already requires responseType === "proposal".
  let directEditApplied: Awaited<ReturnType<typeof executeDirectCommitmentEdits>> | null = null;
  if (result.responseType === "proposal" && result.proposal && result.proposal.operations.length > 0) {
    const { normalized, eligible } = prepareDirectCommitmentEdits(result.proposal.operations);
    if (eligible && hasExplicitCommitmentMutationIntent(parsed.data.message)) {
      const targetValidation = validateProposalTargets(normalized, projectContext);
      if (!targetValidation.ok) {
        result = {
          responseType: "clarification",
          message:
            targetValidation.reason === "stale_execution_target"
              ? "That commitment looks like it's from an earlier version of this project's plan. Could you tell me which current commitment you mean?"
              : "I couldn't find that commitment in this project. Could you confirm which one you mean?",
          proposal: null,
          references: result.references,
          warnings: result.warnings
        };
      } else {
        const ownerValidation = validateAndCanonicalizeOperationOwners(normalized, projectContext);
        if (!ownerValidation.ok) {
          result = {
            responseType: "clarification",
            message: `${ownerValidation.message} Who should I assign it to?`,
            proposal: null,
            references: result.references,
            warnings: result.warnings
          };
        } else {
          const executed = await executeDirectCommitmentEdits({
            operations: ownerValidation.operations as Extract<
              (typeof ownerValidation.operations)[number],
              { type: "update_milestone" }
            >[],
            userId: auth.user.id,
            projectId: id,
            userMessageId: userMessage.id
          });
          directEditApplied = executed;
          if (executed.ok) {
            console.info("[ProjectBrain] direct commitment edit executed", {
              project_id: id,
              user_id: auth.user.id,
              commitment_ids: executed.applied.map((edit) => edit.commitmentId)
            });
            result = {
              responseType: "answer",
              message: buildDirectEditConfirmationMessage(executed.applied),
              proposal: null,
              references: result.references,
              warnings: result.warnings
            };
          } else {
            console.warn("[ProjectBrain] direct commitment edit failed", {
              project_id: id,
              user_id: auth.user.id,
              reason: executed.reason,
              details: executed.message
            });
            result = {
              responseType: "answer",
              message: "I couldn't save that change. Please try again.",
              proposal: null,
              references: result.references,
              warnings: result.warnings
            };
          }
        }
      }
    }
  }

  let proposal: Record<string, unknown> | null = null;
  if (
    result.responseType === "proposal" &&
    result.proposal &&
    result.proposal.operations.length > 0
  ) {
    console.info("[ProjectBrain] persisting proposal operations", {
      project_id: id,
      user_id: auth.user.id,
      operations: result.proposal.operations.map((operation) => operation.type),
      base_graph_version: result.proposal.baseGraphVersion
    });
    const { data, error } = await supabaseAdmin
      .from("project_change_proposals")
      .insert({
        project_id: id,
        thread_id: threadId,
        source_message_id: userMessage.id,
        status: "pending_review",
        summary: result.proposal.summary,
        proposal: { operations: result.proposal.operations },
        warnings: result.warnings,
        base_graph_version: projectContext.project.execution_graph_version ?? 0,
        created_by: auth.user.id
      })
      .select("*")
      .single();
    if (error) {
      return NextResponse.json(
        { error: "Failed to save proposal.", details: error.message },
        { status: 500 }
      );
    }
    proposal = data;
    console.info("[ProjectBrain] proposal operations persisted", {
      project_id: id,
      user_id: auth.user.id,
      proposal_id: data.id,
      operations:
        (data.proposal as { operations?: Array<{ type?: string }> })
          ?.operations?.map((operation) => operation.type) ?? []
    });
  }

  const { data: assistantMessage, error: assistantError } = await supabaseAdmin
    .from("project_chat_messages")
    .insert({
      thread_id: threadId,
      project_id: id,
      role: "assistant",
      content: result.message,
      created_by: null,
      metadata: {
        response_type: result.responseType,
        references: result.references,
        warnings: result.warnings,
        proposal_id: proposal?.id ?? null,
        direct_edit_commitment_ids: directEditApplied?.ok
          ? directEditApplied.applied.map((edit) => edit.commitmentId)
          : null,
        model: agent.ok ? agent.model : null
      }
    })
    .select("*")
    .single();
  if (assistantError || !assistantMessage) {
    return NextResponse.json(
      { error: "Failed to save assistant response.", details: assistantError?.message },
      { status: 500 }
    );
  }

  await supabaseAdmin
    .from("project_chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);

  if (directEditApplied?.ok) {
    // Same revalidation targets the proposal-apply route hits for a milestoneId operation --
    // the meeting page and the commitment's own workspace both read this row server-side.
    revalidatePath(`/projects/${id}`);
    revalidatePath("/projects");
    revalidatePath("/dashboard");
    const commitmentById = new Map(
      projectContext.milestones.map((commitment) => [String(commitment.id), commitment])
    );
    for (const edit of directEditApplied.applied) {
      revalidatePath(`/commitments/${edit.commitmentId}`);
      const commitment = commitmentById.get(edit.commitmentId);
      if (typeof commitment?.meeting_id === "string") {
        revalidatePath(`/meetings/${commitment.meeting_id}`);
      }
    }
  }

  return NextResponse.json(
    {
      thread,
      messages: [userMessage, assistantMessage],
      proposal,
      response: result
    },
    { status: 201 }
  );
}
