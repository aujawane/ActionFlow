import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { runCommitmentChatAgent } from "@/lib/commitment-chat/agent";
import { getOwnedCommitment } from "@/lib/project-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CommitmentCommentMetadata } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const messageSchema = z
  .object({ message: z.string().trim().min(1).max(2000) })
  .strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!(await getOwnedCommitment(id, auth.user.id))) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const { data, error } = await supabaseAdmin
    .from("commitment_comments")
    .select("*")
    .eq("commitment_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "Failed to load commitment chat.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ comments: data ?? [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const commitment = await getOwnedCommitment(id, auth.user.id);
  if (!commitment) {
    return NextResponse.json({ error: "Commitment not found." }, { status: 404 });
  }
  const parsed = messageSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message." }, { status: 400 });
  }

  const [{ data: tasks }, { data: history }] = await Promise.all([
    supabaseAdmin
      .from("meeting_tasks")
      .select("id, task, owner, priority, status, due_date")
      .eq("commitment_id", id)
      .order("position", { ascending: true }),
    supabaseAdmin
      .from("commitment_comments")
      .select("role, message")
      .eq("commitment_id", id)
      .order("created_at", { ascending: true })
      .limit(20)
  ]);

  const { data: userComment, error: insertError } = await supabaseAdmin
    .from("commitment_comments")
    .insert({
      commitment_id: id,
      user_id: auth.user.id,
      role: "user",
      message: parsed.data.message
    })
    .select("*")
    .single();
  if (insertError || !userComment) {
    return NextResponse.json(
      { error: "Failed to save message.", details: insertError?.message },
      { status: 500 }
    );
  }

  let assistantMessage =
    "I could not generate a response right now. Your message was saved.";
  let assistantMetadata: CommitmentCommentMetadata = {};

  const agentResult = await runCommitmentChatAgent({
    commitment,
    tasks: tasks ?? [],
    conversation: (history ?? []).map((entry) => ({ role: entry.role, message: entry.message })),
    latestMessage: parsed.data.message
  });

  if (agentResult.ok) {
    assistantMessage = agentResult.response.answer;
    assistantMetadata = { structuredResponse: agentResult.response };
  } else {
    // Never surface the raw failure (a ZodError, a JSON.parse error, an OpenAI error message
    // that could echo request internals) to the user -- log enough to debug, show a plain
    // fallback sentence instead. The user's own message is still saved either way.
    console.warn("[commitment-chat] structured response failed", {
      commitment_id: id,
      error: agentResult.error,
      details: agentResult.details
    });
  }

  const { data: assistantComment } = await supabaseAdmin
    .from("commitment_comments")
    .insert({
      commitment_id: id,
      user_id: null,
      role: "assistant",
      message: assistantMessage,
      metadata: assistantMetadata
    })
    .select("*")
    .single();

  return NextResponse.json(
    { comments: [userComment, ...(assistantComment ? [assistantComment] : [])] },
    { status: 201 }
  );
}
