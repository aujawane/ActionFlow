"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

import { useOptionalTaskWorkspaceState } from "@/components/task-workspace-task-state";
import type { AllowedTaskPatch } from "@/lib/task-clarification-patches";
import type { MeetingTask, TaskComment } from "@/lib/types";

type PendingPatch = {
  proposalId: string;
  patch: AllowedTaskPatch;
  confidence: number;
};

type CommentsResponse = {
  comments?: TaskComment[];
  error?: string;
  details?: string;
  taskUpdated?: boolean;
  task?: MeetingTask;
  confidence?: number | null;
  appliedPatch?: AllowedTaskPatch;
  pendingPatch?: PendingPatch | null;
};

const PATCH_LABELS: Record<string, string> = {
  task: "title",
  workspace_summary: "description",
  owner: "owner",
  priority: "priority",
  status: "status",
  due_date: "due date",
  task_type: "task type",
  suggested_steps: "suggested next steps",
  rationale: "rationale",
  supporting_context: "supporting context"
};

export function TaskClarifications({
  taskId,
  variant = "compact"
}: {
  taskId: string;
  variant?: "compact" | "panel";
}) {
  const router = useRouter();
  const workspaceState = useOptionalTaskWorkspaceState();
  const [open, setOpen] = useState(variant === "panel");
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const panelLoadedRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadComments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        cache: "no-store"
      });
      const result = (await response.json().catch(() => ({}))) as CommentsResponse;
      if (!response.ok || !result.comments) {
        setError(result.details || result.error || "Failed to load clarifications.");
        return;
      }
      setComments(result.comments);
      setPendingPatch(result.pendingPatch ?? null);
    } catch {
      setError("Network error while loading clarifications.");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (variant !== "panel" || panelLoadedRef.current) return;
    panelLoadedRef.current = true;
    void loadComments();
  }, [loadComments, variant]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [comments, pendingPatch, sending, updateNotice]);

  async function toggleOpen() {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && comments === null && !loading) {
      await loadComments();
    }
  }

  async function submitMessage(
    value: string,
    confirmProposalId?: string
  ) {
    const trimmedMessage = value.trim();
    if (!trimmedMessage || sending) return;

    const optimisticComment: TaskComment = {
      id: `optimistic-${Date.now()}`,
      task_id: taskId,
      user_id: null,
      role: "user",
      message: trimmedMessage,
      created_at: new Date().toISOString()
    };
    setSending(true);
    setError(null);
    setUpdateNotice(null);
    setComments((current) => [...(current ?? []), optimisticComment]);
    setMessage("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          confirmProposalId
        })
      });
      const result = (await response.json().catch(() => ({}))) as CommentsResponse;
      if (!response.ok || !result.comments) {
        setError(result.details || result.error || "Failed to save clarification.");
        return;
      }
      setComments(result.comments);
      setPendingPatch(result.pendingPatch ?? null);
      if (result.task) {
        workspaceState?.setTask(result.task);
      }
      if (
        result.taskUpdated &&
        result.appliedPatch &&
        Object.keys(result.appliedPatch).length > 0
      ) {
        const labels = Object.keys(result.appliedPatch).map(
          (key) => PATCH_LABELS[key] ?? key
        );
        setUpdateNotice(`Updated: ${labels.join(", ")}`);
        router.refresh();
      }
    } catch {
      setError("Network error while saving clarification.");
    } finally {
      setSending(false);
    }
  }

  async function sendComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitMessage(message);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    void submitMessage(message);
  }

  function formatCommentTime(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en", {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  const count = comments?.length ?? 0;
  const examplePrompts = [
    "What did they mean by this?",
    "Change Pogue to Poke",
    "Update the next steps",
    "Who owns this?"
  ];

  const conversation = (
    <>
      {loading && comments === null ? (
        <p className="py-8 text-center text-xs text-slate-500">
          Loading your conversation...
        </p>
      ) : null}

      {!loading && comments?.length === 0 ? (
        <div className="space-y-4 py-4 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-50 text-lg text-brand-700">
            ✦
          </div>
          <p className="mx-auto max-w-xs text-sm leading-6 text-slate-600">
            Ask Parfait to explain this task, clarify meeting context, or update
            task details.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {examplePrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => {
                  setMessage(prompt);
                  inputRef.current?.focus();
                }}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-600 transition hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {comments?.map((comment) => {
        const isUser = comment.role === "user";
        const time = formatCommentTime(comment.created_at);
        return (
          <div
            key={comment.id}
            className={`flex ${isUser ? "justify-end" : "justify-start"}`}
          >
            <div className={`max-w-[88%] ${isUser ? "text-right" : "text-left"}`}>
              <p
                className={`mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide ${
                  isUser ? "text-brand-700" : "text-slate-400"
                }`}
              >
                {isUser ? "You" : comment.role === "system" ? "System" : "Parfait"}
                {time ? ` · ${time}` : ""}
              </p>
              <div
                className={`whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-sm leading-5 shadow-sm ${
                  isUser
                    ? "rounded-br-md bg-brand-700 text-white"
                    : "rounded-bl-md border border-slate-200 bg-white text-slate-700"
                }`}
              >
                {comment.message}
              </div>
            </div>
          </div>
        );
      })}

      {sending ? (
        <div className="flex justify-start">
          <div>
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Parfait
            </p>
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-3 shadow-sm">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-300 [animation-delay:300ms]" />
              <span className="ml-1 text-xs text-slate-500">Thinking</span>
            </div>
          </div>
        </div>
      ) : null}

      {updateNotice ? (
        <p className="rounded-xl border border-brand-100 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800">
          {updateNotice}
        </p>
      ) : null}

      {pendingPatch ? (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <div>
            <p className="text-xs font-semibold text-amber-800">Pending update</p>
            <p className="mt-0.5 text-xs leading-5 text-amber-700">
              Confirm to apply Parfait&apos;s exact proposed changes.
            </p>
          </div>
          <button
            type="button"
            disabled={sending}
            onClick={() => submitMessage("Confirm", pendingPatch.proposalId)}
            className="w-full rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-800 disabled:opacity-60"
          >
            Confirm update
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-xs text-rose-700">{error}</p>
          {comments === null ? (
            <button
              type="button"
              onClick={loadComments}
              className="text-xs font-semibold text-rose-700 underline"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const composer = (
    <form onSubmit={sendComment} className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        value={message}
        onChange={(event) => {
          setMessage(event.target.value);
          event.target.style.height = "auto";
          event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
        }}
        onKeyDown={handleInputKeyDown}
        placeholder="Ask Parfait about this task…"
        maxLength={4000}
        rows={1}
        disabled={sending || loading}
        className="premium-input max-h-[7.5rem] min-h-11 flex-1 resize-none py-2.5 text-sm"
      />
      <button
        type="submit"
        disabled={sending || loading || !message.trim()}
        className="premium-button h-11 px-4 text-xs"
      >
        {sending ? "Sending..." : "Send"}
      </button>
    </form>
  );

  if (variant === "panel") {
    return (
      <section className="premium-card flex h-[40rem] min-h-[30rem] max-h-[calc(100vh-6rem)] flex-col overflow-hidden p-0">
        <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-sm font-semibold text-white">
              P
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-950">Ask Parfait</h2>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">
                Ask questions, clarify details, or update this task.
              </p>
            </div>
          </div>
        </header>
        <div
          ref={messagesRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/70 px-4 py-4"
        >
          {conversation}
        </div>
        <footer className="sticky bottom-0 border-t border-slate-100 bg-white p-3">
          {composer}
          <p className="mt-2 text-center text-[10px] text-slate-400">
            Enter to send · Shift+Enter for a new line
          </p>
        </footer>
      </section>
    );
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center justify-between rounded-xl px-2 py-1.5 text-left text-xs font-semibold text-slate-700 transition hover:bg-brand-50 hover:text-brand-800"
        aria-expanded={open}
      >
        <span>Ask Parfait{comments ? ` (${count})` : ""}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
          <p className="text-xs leading-5 text-slate-500">
            Ask questions, clarify details, or update this task.
          </p>
          <div ref={messagesRef} className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {conversation}
          </div>
          {composer}
        </div>
      ) : null}
    </div>
  );
}
