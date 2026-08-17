"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

import { formatReadableDate } from "@/lib/format-date";
import type { CommitmentCorrectionChange } from "@/lib/commitment-correction/schema";
import type { ValidatedChangeSummary } from "@/lib/commitment-correction/validate";
import type { MeetingCommitment } from "@/lib/types";

const EXAMPLE_PROMPTS = [
  "Change the deadline to August 20.",
  "The owner should be Aditya.",
  "Replace supporting Aditya with Cameron."
];

const FIELD_DISPLAY_LABEL: Record<CommitmentCorrectionChange["field"], string> = {
  title: "Title",
  description: "Description",
  owner: "Owner",
  supporting_person: "Supporting",
  due_date: "Due date",
  priority: "Priority",
  status: "Status"
};

function formatChangeValue(field: CommitmentCorrectionChange["field"], value: string | null): string {
  if (!value) return "(none)";
  if (field === "due_date") return formatReadableDate(value) ?? value;
  if (field === "priority" || field === "status") {
    return value.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase());
  }
  return value;
}

type ChatMessage =
  | { kind: "user"; message: string }
  | { kind: "assistant"; message: string }
  | { kind: "applied"; message: string; summary: ValidatedChangeSummary[] };

type PendingProposal = {
  message: string;
  changes: CommitmentCorrectionChange[];
  sourceMessage: string;
};

type CorrectionMessagesResponse = {
  responseType?: "proposal" | "clarification" | "answer";
  message?: string;
  changes?: CommitmentCorrectionChange[];
  error?: string;
};

type CorrectionApplyResponse = {
  commitment?: MeetingCommitment;
  applied?: ValidatedChangeSummary[];
  auditWarning?: string | null;
  error?: string;
};

/** "Correct with Parfait" -- a small, self-contained conversational correction assistant.
 * Deliberately entity-generic in shape (entityType/entityId/onApplied) even though only
 * "commitment" is wired up today, so a future task-correction reuse point doesn't need a second
 * mini-chat implementation (see the PR description for why tasks weren't included in this pass).
 *
 * All conversation state lives here, in the child, not in the parent menu that owns the
 * surrounding Modal -- typing in the composer only re-renders this component, never the parent,
 * which is what keeps this immune to the exact class of bug the old report dialog hit (a parent
 * re-render on every keystroke recreating an unstable onClose reference). See modal.tsx for the
 * underlying fix that also protects this at the source regardless.
 *
 * The conversation itself is never persisted server-side (see PR description's migration-policy
 * note) -- only a successfully applied correction is recorded, via the existing comment-thread
 * infrastructure, by the apply endpoint. */
export function EntityCorrectionAssistant({
  entityType,
  entityId,
  onApplied
}: {
  entityType: "commitment";
  entityId: string;
  onApplied: (commitment: MeetingCommitment) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, pendingProposal, sending]);

  function messagesEndpoint() {
    return entityType === "commitment" ? `/api/commitments/${entityId}/correction/messages` : null;
  }

  function applyEndpoint() {
    return entityType === "commitment" ? `/api/commitments/${entityId}/correction/apply` : null;
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending || applying) return;
    const endpoint = messagesEndpoint();
    if (!endpoint) return;

    const history = messages
      .filter((entry): entry is Extract<ChatMessage, { kind: "user" | "assistant" }> =>
        entry.kind === "user" || entry.kind === "assistant"
      )
      .map((entry) => ({ role: entry.kind, message: entry.message }));

    setSending(true);
    setError(null);
    setMessages((current) => [...current, { kind: "user", message: trimmed }]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed, history })
      });
      const result = (await response.json().catch(() => ({}))) as CorrectionMessagesResponse;
      if (!response.ok) {
        setError(result.error || "Something went wrong. Please try again.");
        return;
      }
      const assistantMessage = result.message ?? "";
      setMessages((current) => [...current, { kind: "assistant", message: assistantMessage }]);
      setPendingProposal(
        result.changes && result.changes.length > 0
          ? { message: assistantMessage, changes: result.changes, sourceMessage: trimmed }
          : null
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  }

  async function applyProposal() {
    if (!pendingProposal || applying || sending) return;
    const endpoint = applyEndpoint();
    if (!endpoint) return;

    setApplying(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: pendingProposal.changes,
          sourceMessage: pendingProposal.sourceMessage
        })
      });
      const result = (await response.json().catch(() => ({}))) as CorrectionApplyResponse;
      if (!response.ok || !result.commitment || !result.applied) {
        // Preserve the pending proposal and full chat history so the user can retry or rephrase
        // without starting over -- a failed apply must never look like a silent success.
        setError(result.error || "Failed to apply the correction.");
        return;
      }
      onApplied(result.commitment);
      setMessages((current) => [
        ...current,
        { kind: "applied", message: "Updated.", summary: result.applied ?? [] }
      ]);
      setPendingProposal(null);
      if (result.auditWarning) {
        setError(result.auditWarning);
      }
    } catch {
      setError("Network error. The correction may not have been applied -- please check and retry.");
    } finally {
      setApplying(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendMessage(input);
  }

  const busy = sending || applying;

  return (
    <div className="flex h-[28rem] max-h-[70vh] flex-col">
      <div ref={messagesRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto py-1">
        {messages.length === 0 ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-slate-600">Tell Parfait what should be changed.</p>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Try</p>
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    setInput(prompt);
                    inputRef.current?.focus();
                  }}
                  className="block text-left text-sm text-brand-700 underline decoration-brand-200 underline-offset-2 hover:text-brand-800"
                >
                  &ldquo;{prompt}&rdquo;
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((entry, index) => {
          if (entry.kind === "applied") {
            return (
              <div key={index} className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl border border-brand-200 bg-brand-50 px-3 py-2.5 text-left">
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                    Parfait
                  </p>
                  <p className="mt-1 text-sm font-semibold text-brand-900">Updated.</p>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-brand-800">
                    {entry.summary.map((change, changeIndex) => (
                      <li key={changeIndex}>
                        {change.field}: {change.from} → {change.to}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          }
          const isUser = entry.kind === "user";
          return (
            <div key={index} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[92%] ${isUser ? "text-right" : "text-left"}`}>
                <p
                  className={`mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide ${
                    isUser ? "text-brand-700" : "text-slate-400"
                  }`}
                >
                  {isUser ? "You" : "Parfait"}
                </p>
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-sm leading-5 shadow-sm ${
                    isUser
                      ? "rounded-br-md bg-brand-700 text-white"
                      : "rounded-bl-md border border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  {entry.message}
                </div>
              </div>
            </div>
          );
        })}

        {sending ? (
          <div className="flex justify-start">
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-3 shadow-sm">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-300 [animation-delay:300ms]" />
            </div>
          </div>
        ) : null}

        {pendingProposal ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              {pendingProposal.changes.length === 1 ? "Proposed change" : "Proposed changes"}
            </p>
            <dl className="mt-2 space-y-2">
              {pendingProposal.changes.map((change, index) => (
                <div key={index} className="text-sm">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {FIELD_DISPLAY_LABEL[change.field]}
                  </dt>
                  <dd className="mt-0.5 flex flex-wrap items-center gap-1.5 text-slate-800">
                    <span className="text-slate-500 line-through decoration-slate-300">
                      {formatChangeValue(change.field, change.current_value)}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span className="font-semibold">
                      {formatChangeValue(change.field, change.proposed_value)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              onClick={() => void applyProposal()}
              disabled={applying}
              className="premium-button mt-3 px-4 py-2 text-sm"
            >
              {applying
                ? "Applying…"
                : pendingProposal.changes.length === 1
                  ? "Apply change"
                  : `Apply ${pendingProposal.changes.length} changes`}
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2 border-t border-slate-100 pt-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder="Describe the correction..."
          maxLength={2000}
          rows={1}
          disabled={busy}
          className="premium-input max-h-[7.5rem] min-h-11 flex-1 resize-none py-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="premium-button h-11 px-4 text-xs"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
