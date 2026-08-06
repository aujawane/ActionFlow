import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { runProjectBrainAgent } from "@/lib/project-brain/agent";
import { buildProjectBrainContext } from "@/lib/project-brain/context";
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
  const result = agent.ok
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

  let proposal: Record<string, unknown> | null = null;
  if (result.responseType === "proposal" && result.proposal) {
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
