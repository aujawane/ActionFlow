import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/api-auth";
import { runTaskChatAgent } from "@/lib/ai/task-chat-agent";
import {
  canApplyTaskChatPatch,
  getTaskChatPatchConflict,
  sanitizeTaskChatPatch
} from "@/lib/ai/task-chat-patch";
import {
  proposeTaskPatch,
  type AllowedTaskPatch
} from "@/lib/task-clarification-patches";
import { parseTaskCommentMessage } from "@/lib/task-comment-validation";
import {
  getAccessibleTask,
  getTaskComments,
  getTaskTranscriptSnippets
} from "@/lib/task-comments";
import {
  createPendingProposalMetadata,
  findLatestPendingProposal,
  formatAppliedPatchMessage,
  formatPendingPatchMessage,
  isTaskUpdateConfirmation,
  taskContainsPatch,
  updateProposalStatus
} from "@/lib/task-comment-metadata";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  MeetingTask,
  TaskCommentMetadata
} from "@/lib/types";

/**
 * Vercel plan assumption: Pro. Task chat may call OpenAI and persist patches.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

async function applyTaskPatch(taskId: string, patch: AllowedTaskPatch) {
  const { data, error } = await supabaseAdmin
    .from("meeting_tasks")
    .update(patch)
    .eq("id", taskId)
    .select("*")
    .single();
  return { task: data as MeetingTask | null, error };
}

async function saveAssistantComment(input: {
  taskId: string;
  message: string;
  metadata?: TaskCommentMetadata;
}) {
  return supabaseAdmin.from("task_comments").insert({
    task_id: input.taskId,
    user_id: null,
    role: "assistant",
    message: input.message,
    metadata: input.metadata ?? {}
  });
}

async function setProposalStatus(input: {
  commentId: string;
  metadata: TaskCommentMetadata;
  status: "applied" | "superseded";
}) {
  return supabaseAdmin
    .from("task_comments")
    .update({ metadata: updateProposalStatus(input.metadata, input.status) })
    .eq("id", input.commentId);
}

function removeFalseUpdateClaim(message: string) {
  return /\b(?:i|i've|we|parfait)\s+(?:updated|changed|saved|applied)\b/i.test(
    message
  )
    ? "I understood your message, but I did not change the task."
    : message;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const access = await getAccessibleTask(id, auth.user.id);
  if (!access.task || !access.meeting) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  const { comments, error } = await getTaskComments(id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to load task comments.", details: error.message },
      { status: 500 }
    );
  }

  const pending = findLatestPendingProposal(comments);
  return NextResponse.json(
    {
      comments,
      pendingPatch: pending
        ? {
            proposalId: pending.proposal.id,
            patch: pending.proposal.patch,
            confidence: pending.proposal.confidence
          }
        : null
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { id } = await context.params;
  const access = await getAccessibleTask(id, auth.user.id);
  if (!access.task || !access.meeting) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    message?: unknown;
    confirmProposalId?: unknown;
  } | null;
  const parsed = parseTaskCommentMessage(body?.message);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Message is required and must be 4,000 characters or fewer." },
      { status: 400 }
    );
  }

  const [{ comments: previousComments, error: commentsError }, transcriptContext] =
    await Promise.all([
      getTaskComments(id),
      getTaskTranscriptSnippets(access.task)
    ]);
  if (commentsError) {
    return NextResponse.json(
      { error: "Failed to load task comment history.", details: commentsError.message },
      { status: 500 }
    );
  }
  if (transcriptContext.error) {
    console.warn("Task chat transcript context unavailable", {
      task_id: id,
      error: transcriptContext.error.message
    });
  }

  const { error: insertError } = await supabaseAdmin
    .from("task_comments")
    .insert({
      task_id: id,
      user_id: auth.user.id,
      role: "user",
      message: parsed.data,
      metadata: {}
    });
  if (insertError) {
    return NextResponse.json(
      { error: "Failed to save task comment.", details: insertError.message },
      { status: 500 }
    );
  }

  let assistantMessage: string;
  let updatedTask = access.task;
  let appliedPatch: AllowedTaskPatch = {};
  let pendingPatch: {
    proposalId: string;
    patch: AllowedTaskPatch;
    confidence: number;
  } | null = null;
  let confidence: number | null = null;
  let assistantMetadata: TaskCommentMetadata = {};
  const previousPending = findLatestPendingProposal(previousComments);
  const requestedProposalId =
    typeof body?.confirmProposalId === "string"
      ? body.confirmProposalId
      : null;
  const confirmsPending =
    isTaskUpdateConfirmation(parsed.data) &&
    previousPending &&
    (!requestedProposalId ||
      requestedProposalId === previousPending.proposal.id);

  if (confirmsPending && previousPending) {
    const exactPatch = previousPending.proposal.patch as AllowedTaskPatch;
    const update = await applyTaskPatch(id, exactPatch);
    if (
      update.error ||
      !update.task ||
      !taskContainsPatch(update.task, exactPatch)
    ) {
      assistantMessage =
        "I understood the change, but I could not save it yet.";
      console.error("Pending task update could not be verified", {
        task_id: id,
        proposal_id: previousPending.proposal.id,
        error: update.error?.message
      });
    } else {
      updatedTask = update.task;
      appliedPatch = exactPatch;
      assistantMessage = formatAppliedPatchMessage(exactPatch);
      const statusUpdate = await setProposalStatus({
        commentId: previousPending.commentId,
        metadata: {
          proposal: previousPending.proposal
        },
        status: "applied"
      });
      if (statusUpdate.error) {
        console.error("Failed to mark task proposal applied", {
          task_id: id,
          proposal_id: previousPending.proposal.id,
          error: statusUpdate.error.message
        });
      }
    }
  } else if (isTaskUpdateConfirmation(parsed.data)) {
    assistantMessage = requestedProposalId
      ? "That pending update is no longer available. Please describe the change again."
      : "There is no pending task update to confirm.";
  } else {
    const agent = await runTaskChatAgent({
      task: access.task,
      meeting: access.meeting,
      comments: previousComments,
      transcriptSnippets: transcriptContext.snippets,
      latestUserMessage: parsed.data
    });

    if (agent.ok) {
      confidence = agent.result.confidence;
      const immediateCandidate = agent.result.taskPatch;
      const proposalCandidate =
        agent.result.pendingPatch ?? agent.result.taskPatch;
      const immediatePatch = sanitizeTaskChatPatch(immediateCandidate);
      const proposalPatch = sanitizeTaskChatPatch(proposalCandidate);
      const conflict =
        getTaskChatPatchConflict(immediateCandidate) ??
        getTaskChatPatchConflict(proposalCandidate);
      const requiresPending =
        agent.result.requiresConfirmation ||
        agent.result.intent === "propose_update" ||
        agent.result.intent === "ask_confirmation" ||
        agent.result.confidence < 0.75;
      const canApply =
        !conflict &&
        agent.result.intent === "apply_update" &&
        !requiresPending &&
        canApplyTaskChatPatch({
          shouldUpdateTask: agent.result.shouldUpdateTask,
          confidence: agent.result.confidence,
          patch: immediatePatch
        });

      if (canApply) {
        const update = await applyTaskPatch(id, immediatePatch);
        if (
          update.error ||
          !update.task ||
          !taskContainsPatch(update.task, immediatePatch)
        ) {
          assistantMessage =
            "I understood the change, but I could not save it yet.";
          console.error("AI task update could not be verified", {
            task_id: id,
            error: update.error?.message
          });
        } else {
          updatedTask = update.task;
          appliedPatch = immediatePatch;
          assistantMessage = formatAppliedPatchMessage(immediatePatch);
          if (previousPending) {
            await setProposalStatus({
              commentId: previousPending.commentId,
              metadata: { proposal: previousPending.proposal },
              status: "superseded"
            });
          }
        }
      } else if (
        !conflict &&
        Object.keys(proposalPatch).length > 0 &&
        requiresPending
      ) {
        if (previousPending) {
          await setProposalStatus({
            commentId: previousPending.commentId,
            metadata: { proposal: previousPending.proposal },
            status: "superseded"
          });
        }
        assistantMetadata = createPendingProposalMetadata({
          patch: proposalPatch,
          confidence: agent.result.confidence,
          source: "agent"
        });
        pendingPatch = {
          proposalId: assistantMetadata.proposal!.id,
          patch: proposalPatch,
          confidence: agent.result.confidence
        };
        assistantMessage = formatPendingPatchMessage(proposalPatch);
      } else if (conflict) {
        assistantMessage =
          "The proposed owner and assignee do not match. Which assignee should I use?";
      } else if (
        agent.result.intent === "apply_update" &&
        Object.keys(immediatePatch).length === 0
      ) {
        assistantMessage =
          "I understood the request, but it did not contain a supported task change.";
      } else {
        assistantMessage = removeFalseUpdateClaim(
          agent.result.assistantMessage
        );
      }
    } else {
      console.error("Task chat agent failed", {
        task_id: id,
        error: agent.error,
        details: agent.details
      });
      const fallback = proposeTaskPatch(access.task, parsed.data);
      if (fallback.kind === "patch") {
        if (previousPending) {
          await setProposalStatus({
            commentId: previousPending.commentId,
            metadata: { proposal: previousPending.proposal },
            status: "superseded"
          });
        }
        assistantMetadata = createPendingProposalMetadata({
          patch: fallback.patch,
          confidence: 0.5,
          source: "fallback"
        });
        pendingPatch = {
          proposalId: assistantMetadata.proposal!.id,
          patch: fallback.patch,
          confidence: 0.5
        };
        assistantMessage = formatPendingPatchMessage(fallback.patch);
      } else if (fallback.kind === "ambiguous") {
        assistantMessage = fallback.assistantMessage;
      } else {
        assistantMessage =
          "I saved your message, but I could not generate a response right now. Please try again.";
      }
    }
  }

  const taskUpdated = Object.keys(appliedPatch).length > 0;
  if (taskUpdated) {
    revalidatePath(`/tasks/${id}`);
    revalidatePath(`/meetings/${access.task.meeting_id}`);
  }

  const { error: assistantInsertError } = await saveAssistantComment({
    taskId: id,
    message: assistantMessage,
    metadata: assistantMetadata
  });
  if (assistantInsertError) {
    console.error("Failed to save task chat assistant response", {
      task_id: id,
      error: assistantInsertError.message
    });
  }

  const { comments, error } = await getTaskComments(id);
  if (error) {
    return NextResponse.json(
      {
        error: "Comment saved, but the updated thread could not be loaded.",
        details: error.message
      },
      { status: 500 }
    );
  }

  const activePending = findLatestPendingProposal(comments);
  const returnedPendingPatch =
    pendingPatch ??
    (activePending
      ? {
          proposalId: activePending.proposal.id,
          patch: activePending.proposal.patch as AllowedTaskPatch,
          confidence: activePending.proposal.confidence
        }
      : null);

  return NextResponse.json(
    {
      comments,
      taskUpdated,
      task: updatedTask,
      appliedPatch,
      pendingPatch: returnedPendingPatch,
      confidence
    },
    { status: 201 }
  );
}
