"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

import { ParfaitResponseRenderer } from "@/components/parfait-response-renderer";
import type { MeetingComment } from "@/lib/types";

type MessagesResponse = {
  comments?: MeetingComment[];
  error?: string;
  details?: string;
};

/** Single Meeting Assistant instance whose PRESENTATION changes responsively, not its state:
 * on large desktop (xl+) it renders as a persistent, docked right-rail sitting beside the meeting
 * content as a normal (non-modal) page region; below that it falls back to a compact trigger
 * button that opens the same conversation as a docked overlay panel. There is exactly one
 * comments/message state, loaded once on mount regardless of breakpoint -- resizing the viewport
 * never remounts this component or creates a second conversation.
 *
 * Deliberately NOT built on the shared Modal component's "drawer" variant even for the fallback
 * tiers -- Modal's drawer dims and traps focus over the whole page, but the brief requires the
 * underlying Meeting Detail page to stay visible and interactive beside this panel (e.g. clicking
 * a task link while the assistant is open), which a page-blocking overlay can't do. It still
 * borrows Modal's UX conventions where they fit a non-trapping panel: Escape closes the fallback
 * overlay, focus moves in on open and is restored to the trigger button on close. Those behaviors
 * only ever engage below the xl breakpoint (see the `open`-gated effect below) -- the persistent
 * xl+ rail is a normal, focusable, non-modal page region, never auto-focused or focus-trapped. */
export function MeetingAssistantPanel({
  meetingId,
  meetingTitle,
  suggestions
}: {
  meetingId: string;
  meetingTitle: string | null;
  /** Precomputed, deterministic suggestion chips (see app/meetings/[id]/page.tsx) -- no OpenAI
   * call is made merely to decide what to suggest. */
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<MeetingComment[] | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadComments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/assistant/messages`, {
        cache: "no-store"
      });
      const result = (await response.json().catch(() => ({}))) as MessagesResponse;
      if (!response.ok || !result.comments) {
        setError(result.details || result.error || "Failed to load the conversation.");
        return;
      }
      setComments(result.comments);
    } catch {
      setError("Network error while loading the conversation.");
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  // Loaded once per page load regardless of breakpoint -- the persistent xl+ rail has no "open"
  // action to gate this on, and the brief is explicit that opening/showing the assistant must
  // only ever fetch persisted history (GET), never invoke OpenAI. See submitMessage for the only
  // path that calls the model.
  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  // Focus-in / Escape-to-close only apply to the below-xl fallback overlay, which is the only
  // tier where `open` is ever driven by a genuine user action (clicking the trigger). At xl+ the
  // rail is always visible via CSS regardless of `open`, so this effect simply never runs there --
  // no auto-focus-steal, no Escape binding, matching the "normal page region, not a modal" rule.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = triggerRef.current;
    panelRef.current?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [comments, sending]);

  async function submitMessage(value: string) {
    const trimmed = value.trim();
    if (!trimmed || sending) return;

    const optimisticComment: MeetingComment = {
      id: `optimistic-${Date.now()}`,
      meeting_id: meetingId,
      user_id: null,
      role: "user",
      message: trimmed,
      created_at: new Date().toISOString()
    };
    setSending(true);
    setError(null);
    setComments((current) => [...(current ?? []), optimisticComment]);
    setMessage("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      const response = await fetch(`/api/meetings/${meetingId}/assistant/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed })
      });
      const result = (await response.json().catch(() => ({}))) as MessagesResponse;
      if (!response.ok || !result.comments) {
        setError(result.details || result.error || "Failed to send your message.");
        setComments((current) => (current ?? []).filter((item) => item.id !== optimisticComment.id));
        setMessage(trimmed);
        return;
      }
      setComments(result.comments);
    } catch {
      setError("Network error while sending your message.");
      setComments((current) => (current ?? []).filter((item) => item.id !== optimisticComment.id));
      setMessage(trimmed);
    } finally {
      setSending(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(message);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitMessage(message);
  }

  async function copyContent(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the content is still fully visible and
      // selectable, so there's nothing further to recover from here.
    }
  }

  function formatCommentTime(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
  }

  return (
    // order-first (below xl) puts the trigger/panel ahead of the main execution column in the
    // page's single-column mobile/laptop stack, so Ask Parfait stays discoverable near the top
    // rather than sinking to the bottom of a long meeting. xl:order-none restores DOM order,
    // where this is declared after the main column so it lands in the grid's second (right) track.
    <div className="order-first xl:order-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="secondary-button px-3 py-1.5 text-xs sm:text-sm xl:hidden"
      >
        Ask Parfait
      </button>

      {/* Always mounted (not conditionally rendered) so the xl+ rail can stay permanently visible
          -- visibility below xl is driven by `open` via the base/`hidden` classes, while the xl:
          overrides unconditionally force it visible and switch it from a fixed overlay to a
          sticky in-flow rail, regardless of `open`. */}
      <div
        className={`${open ? "fixed inset-0 z-40" : "hidden"} lg:inset-auto lg:bottom-4 lg:right-4 lg:top-20 xl:static xl:z-auto xl:block`}
      >
        <div
          ref={panelRef}
          role="complementary"
          aria-label="Ask Parfait"
          tabIndex={-1}
          className="flex h-full w-full flex-col overflow-hidden border-slate-200 bg-white shadow-2xl outline-none lg:h-[calc(100vh-6rem)] lg:w-[400px] lg:max-w-[92vw] lg:rounded-2xl lg:border xl:sticky xl:top-20 xl:h-[calc(100vh-6rem)] xl:max-h-[calc(100vh-6rem)] xl:w-full xl:max-w-none xl:shadow-sm"
        >
          <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-4 py-4 backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-sm font-semibold text-white">
                  P
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-slate-950">Ask Parfait</h2>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500">
                    Ask about this meeting or create follow-up work.
                  </p>
                  {meetingTitle ? (
                    <p className="mt-1 truncate text-[10px] font-medium uppercase tracking-wide text-slate-400">
                      {meetingTitle}
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close Ask Parfait"
                className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 xl:hidden"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          </header>

          <div
            ref={messagesRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50/70 px-4 py-4"
          >
            {loading && comments === null ? (
              <p className="py-8 text-center text-xs text-slate-500">Loading your conversation...</p>
            ) : null}

            {!loading && comments?.length === 0 ? (
              <div className="space-y-4 py-4 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-50 text-lg text-brand-700">
                  ✦
                </div>
                <p className="mx-auto max-w-xs text-sm leading-6 text-slate-600">
                  Ask Parfait what happened in this meeting, who owns what, or have it draft a
                  follow-up.
                </p>
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {suggestions.map((prompt) => (
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
                ) : null}
              </div>
            ) : null}

            {comments?.map((comment) => {
              const time = formatCommentTime(comment.created_at);

              if (comment.role === "system") {
                return (
                  <div key={comment.id} className="flex justify-center">
                    <p className="max-w-[90%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-center text-xs leading-5 text-slate-500">
                      <span className="font-semibold uppercase tracking-wide text-slate-400">
                        System{time ? ` · ${time}` : ""}:{" "}
                      </span>
                      {comment.message}
                    </p>
                  </div>
                );
              }

              const isUser = comment.role === "user";
              const generatedContent = comment.metadata?.generatedContent ?? [];
              const sources = comment.metadata?.sources ?? [];
              return (
                <div key={comment.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[92%] ${isUser ? "text-right" : "text-left"}`}>
                    <p
                      className={`mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide ${
                        isUser ? "text-brand-700" : "text-slate-400"
                      }`}
                    >
                      {isUser ? "You" : "Parfait"}
                      {time ? ` · ${time}` : ""}
                    </p>
                    {isUser ? (
                      <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-700 px-3 py-2.5 text-sm leading-5 text-white shadow-sm">
                        {comment.message}
                      </div>
                    ) : (
                      <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                        <ParfaitResponseRenderer legacyText={comment.message} />
                      </div>
                    )}

                    {generatedContent.length > 0 ? (
                      <div className="mt-2 space-y-2 text-left">
                        {generatedContent.map((item, index) => {
                          const key = `${comment.id}-${index}`;
                          const copyText = item.subject
                            ? `Subject: ${item.subject}\n\n${item.body}`
                            : item.body;
                          return (
                            <div
                              key={key}
                              className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
                            >
                              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                                {item.title}
                              </p>
                              {item.subject ? (
                                <p className="mt-1.5 text-xs">
                                  <span className="font-semibold text-slate-500">Subject </span>
                                  <span className="text-slate-800">{item.subject}</span>
                                </p>
                              ) : null}
                              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800">
                                {item.body}
                              </p>
                              <button
                                type="button"
                                onClick={() => void copyContent(key, copyText)}
                                className="tertiary-button mt-2 px-2.5 py-1 text-xs"
                              >
                                {copiedKey === key ? "Copied" : "Copy"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {sources.length > 0 ? (
                      <div className="mt-1.5 px-1 text-left text-[10px] text-slate-400">
                        <span className="font-semibold uppercase tracking-wide">Sources</span>
                        <ul className="mt-0.5 space-y-0.5">
                          {sources.map((source, index) => (
                            <li key={`${comment.id}-source-${index}`}>
                              {source.speaker} · {source.timestamp}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
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
          </div>

          <footer className="sticky bottom-0 border-t border-slate-100 bg-white p-3">
            <form onSubmit={sendMessage} className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  event.target.style.height = "auto";
                  event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="Ask anything about this meeting..."
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
            <p className="mt-2 text-center text-[10px] text-slate-400">
              Enter to send · Shift+Enter for a new line
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
