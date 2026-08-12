"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ProjectBrainOperationReview } from "@/components/project-brain-operation-review";
import { formatReadableDate } from "@/lib/format-date";
import type {
  Project,
  ProjectChangeProposal,
  ProjectChatMessage,
  ProjectMemory,
  MeetingCommitment,
  MeetingTask
} from "@/lib/types";
import {
  operationGroup,
  type ProjectBrainOperationGroup
} from "@/lib/project-brain/operations";
import {
  projectChangeOperationSchema,
  type ProjectChangeOperation
} from "@/lib/project-brain/schemas";

type BrainThread = { id: string } | null;

const suggestions = [
  "Describe this project",
  "Clarify the MVP",
  "Update the project scope",
  "Reorganize commitments",
  "Record completed work",
  "Add a project constraint"
];

function proposalOperations(proposal: ProjectChangeProposal) {
  const value = proposal.proposal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const operations = (value as { operations?: unknown }).operations;
  return Array.isArray(operations)
    ? (operations as unknown as ProjectChangeOperation[])
    : [];
}

function operationLabel(operation: ProjectChangeOperation) {
  return operation.type.replaceAll("_", " ");
}

export function ProjectBrainLauncher({
  starterPrompt
}: {
  starterPrompt?: string;
}) {
  return (
    <button
      type="button"
      className="premium-button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("project-brain-focus", {
            detail: { starterPrompt: starterPrompt ?? "" }
          })
        )
      }
    >
      Teach Parfait about this project
    </button>
  );
}

export function ProjectBrainPanel({
  project,
  initialThread,
  initialMessages,
  initialProposals,
  memory,
  decisions,
  constraints,
  milestones,
  tasks
}: {
  project: Project;
  initialThread: BrainThread;
  initialMessages: ProjectChatMessage[];
  initialProposals: ProjectChangeProposal[];
  memory: ProjectMemory | null;
  decisions: Array<{ id: string; title: string; description: string | null; status: string }>;
  constraints: Array<{ id: string; title: string; description: string | null; status: string }>;
  milestones: MeetingCommitment[];
  tasks: MeetingTask[];
}) {
  const router = useRouter();
  const [thread, setThread] = useState(initialThread);
  const [messages, setMessages] = useState(initialMessages);
  const [proposals, setProposals] = useState(initialProposals);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ProjectChangeProposal | null>(null);
  const [reviewOperations, setReviewOperations] = useState<ProjectChangeOperation[]>([]);
  const [enabled, setEnabled] = useState<boolean[]>([]);
  const [operationDrafts, setOperationDrafts] = useState<string[]>([]);
  const [operationErrors, setOperationErrors] = useState<Array<string | null>>(
    []
  );
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<string | null>(null);
  const [graphVersion, setGraphVersion] = useState(
    project.execution_graph_version ?? 0
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const proposalsById = useMemo(
    () => new Map(proposals.map((proposal) => [proposal.id, proposal])),
    [proposals]
  );
  const reviewCounts = useMemo(() => {
    const counts = new Map<ProjectBrainOperationGroup, number>();
    reviewOperations.forEach((operation) => {
      const group = operationGroup(operation);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    });
    return Array.from(counts.entries());
  }, [reviewOperations]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<{ starterPrompt?: string }>).detail;
      setCollapsed(false);
      setMobileOpen(true);
      if (detail?.starterPrompt) setDraft(detail.starterPrompt);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    };
    window.addEventListener("project-brain-focus", focus);
    return () => window.removeEventListener("project-brain-focus", focus);
  }, []);

  useEffect(() => {
    const closeTopLayer = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (reviewing) {
        setReviewing(null);
      } else if (memoryOpen) {
        setMemoryOpen(false);
      } else if (mobileOpen) {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", closeTopLayer);
    return () => window.removeEventListener("keydown", closeTopLayer);
  }, [memoryOpen, mobileOpen, reviewing]);

  useEffect(() => {
    setGraphVersion(project.execution_graph_version ?? 0);
  }, [project.execution_graph_version]);

  async function sendMessage(message = draft) {
    const value = message.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    setLastAttempt(value);
    if (message === draft) setDraft("");
    try {
      const response = await fetch(`/api/projects/${project.id}/brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: value, threadId: thread?.id ?? null })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Project Brain failed.");
      setThread(payload.thread);
      setMessages((current) => [...current, ...payload.messages]);
      if (payload.proposal) {
        setProposals((current) => [...current, payload.proposal]);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Project Brain failed.");
      setDraft(value);
    } finally {
      setLoading(false);
    }
  }

  async function clearDraftConversation() {
    if (loading) return;
    setError(null);
    const response = await fetch(`/api/projects/${project.id}/brain/threads`, {
      method: "POST"
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not start a new conversation.");
      return;
    }
    setThread(payload.thread);
    setMessages([]);
    setProposals([]);
    setDraft("");
    inputRef.current?.focus();
  }

  function openReview(proposal: ProjectChangeProposal) {
    const operations = proposalOperations(proposal);
    setReviewing(proposal);
    setReviewOperations(operations);
    setEnabled(operations.map(() => true));
    setOperationDrafts(operations.map((operation) => JSON.stringify(operation, null, 2)));
    setOperationErrors(operations.map(() => null));
    setReviewError(null);
  }

  function parseSelectedOperations() {
    return operationDrafts.flatMap((raw, index) => {
      if (!enabled[index]) return [];
      if (operationErrors[index]) {
        throw new Error(`Operation ${index + 1}: ${operationErrors[index]}`);
      }
      const parsed = projectChangeOperationSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `Operation ${index + 1}: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`
        );
      }
      return [parsed.data];
    });
  }

  function updateOperationDraft(index: number, value: string) {
    setOperationDrafts((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? value : item))
    );
    let validationError: string | null = null;
    try {
      const parsed = projectChangeOperationSchema.safeParse(JSON.parse(value));
      if (!parsed.success) {
        validationError = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
      }
    } catch {
      validationError = "Invalid JSON syntax.";
    }
    setOperationErrors((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? validationError : item
      )
    );
  }

  async function rejectProposal(proposal: ProjectChangeProposal) {
    const response = await fetch(
      `/api/projects/${project.id}/brain/proposals/${proposal.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" })
      }
    );
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not reject proposal.");
      return;
    }
    setProposals((current) =>
      current.map((item) => (item.id === proposal.id ? payload.proposal : item))
    );
    if (reviewing?.id === proposal.id) setReviewing(null);
  }

  async function applyProposal() {
    if (!reviewing) return;
    setReviewError(null);
    let operations: ProjectChangeOperation[];
    try {
      operations = parseSelectedOperations();
    } catch (parseError) {
      setReviewError(parseError instanceof Error ? parseError.message : "Invalid operation.");
      return;
    }
    if (operations.length === 0) {
      setReviewError("Select at least one operation to apply.");
      return;
    }
    setLoading(true);
    setApplySuccess(null);
    try {
      const response = await fetch(
        `/api/projects/${project.id}/brain/proposals/${reviewing.id}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operations })
        }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not apply proposal.");
      setProposals((current) =>
        current.map((item) =>
          item.id === reviewing.id
            ? {
                ...item,
                status: "applied",
                resulting_graph_version: payload.result.resultingGraphVersion
              }
            : item
        )
      );
      setReviewing(null);
      const nextVersion =
        payload.result.resultingGraphVersion ?? graphVersion + 1;
      setGraphVersion(nextVersion);
      setApplySuccess(
        `${operations.length} selected change${
          operations.length === 1 ? "" : "s"
        } applied. Project graph is now version ${nextVersion}.`
      );
      router.refresh();
    } catch (applyError) {
      setReviewError(
        applyError instanceof Error ? applyError.message : "Could not apply proposal."
      );
    } finally {
      setLoading(false);
    }
  }

  const body = (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-slate-950">Project Brain</h2>
            <span className="h-2 w-2 rounded-full bg-emerald-500" title="Ready" />
          </div>
          <p className="truncate text-xs text-slate-500">
            {project.name} · Graph v{graphVersion}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="secondary-button !px-2 !py-1 text-xs" onClick={() => setMemoryOpen(true)}>
            Memory
          </button>
          <button type="button" className="secondary-button !px-2 !py-1 text-xs" onClick={() => void clearDraftConversation()}>
            Clear draft
          </button>
          <button type="button" className="secondary-button !px-2 !py-1 text-xs lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close Project Brain">
            Close
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <div>
            <p className="text-sm font-medium text-slate-900">Teach Parfait what meetings missed.</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Project Brain can answer questions or prepare a reviewable project diff.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-left text-xs text-slate-700 hover:border-brand-300 hover:bg-brand-50"
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => {
          const metadata =
            message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
              ? (message.metadata as Record<string, unknown>)
              : {};
          const proposal =
            typeof metadata.proposal_id === "string"
              ? proposalsById.get(metadata.proposal_id)
              : undefined;
          return (
            <div key={message.id} className={message.role === "user" ? "ml-8" : "mr-5"}>
              <article
                className={
                  message.role === "user"
                    ? "rounded-2xl rounded-br-md bg-brand-600 px-4 py-3 text-sm text-white"
                    : "rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm text-slate-800"
                }
              >
                <p className="whitespace-pre-wrap leading-6">{message.content}</p>
              </article>
              <p className="mt-1 px-1 text-[10px] text-slate-400">
                {new Date(message.created_at).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit"
                })}
              </p>
              {proposal ? (
                <article className="mt-2 rounded-2xl border border-brand-200 bg-brand-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                      Proposed changes
                    </p>
                    <span className="text-[10px] capitalize text-slate-500">
                      {proposal.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-800">{proposal.summary}</p>
                  <ul className="mt-2 space-y-1 text-xs text-slate-600">
                    {proposalOperations(proposal).slice(0, 5).map((operation, index) => (
                      <li key={`${operation.type}-${index}`}>
                        • {operationLabel(operation)}
                      </li>
                    ))}
                  </ul>
                  {proposal.status === "pending_review" ? (
                    <div className="mt-3 flex gap-2">
                      <button type="button" className="premium-button !px-3 !py-1.5 text-xs" onClick={() => openReview(proposal)}>
                        Review changes
                      </button>
                      <button type="button" className="secondary-button !px-3 !py-1.5 text-xs" onClick={() => void rejectProposal(proposal)}>
                        Reject
                      </button>
                    </div>
                  ) : null}
                </article>
              ) : null}
            </div>
          );
        })}
        {loading ? (
          <div className="mr-8 rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm text-slate-500">
            Project Brain is thinking…
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700" role="alert">
          {error}
          {lastAttempt ? (
            <button type="button" className="ml-2 font-semibold underline" onClick={() => void sendMessage(lastAttempt)}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {applySuccess ? (
        <div
          className="border-t border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800"
          role="status"
        >
          {applySuccess}
        </div>
      ) : null}

      <form
        className="border-t border-slate-200 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage();
        }}
      >
        <label className="sr-only" htmlFor="project-brain-input">
          Message Project Brain
        </label>
        <textarea
          id="project-brain-input"
          ref={inputRef}
          className="premium-input min-h-20 resize-none"
          value={draft}
          maxLength={4000}
          placeholder="Teach Parfait about the project…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-[10px] text-slate-400">Enter to send · Shift+Enter for newline</p>
          <button type="submit" className="premium-button !px-4 !py-2 text-xs" disabled={loading || !draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className="premium-button fixed bottom-5 right-5 z-30 shadow-lg lg:hidden"
        onClick={() => setMobileOpen(true)}
      >
        Project Brain
      </button>

      <aside
        className={`hidden h-[calc(100vh-7rem)] shrink-0 lg:sticky lg:top-24 lg:block ${
          collapsed ? "w-14" : "w-[24rem] min-w-[22rem] max-w-[42rem] resize-x overflow-auto"
        }`}
      >
        <div className="relative h-full overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
          <button
            type="button"
            className="absolute right-2 top-2 z-20 rounded-lg bg-white px-2 py-1 text-xs text-slate-500 shadow"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand Project Brain" : "Collapse Project Brain"}
          >
            {collapsed ? "←" : "→"}
          </button>
          {collapsed ? (
            <button type="button" className="h-full w-full text-xs font-semibold [writing-mode:vertical-rl]" onClick={() => setCollapsed(false)}>
              Project Brain
            </button>
          ) : body}
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 bg-white lg:hidden" role="dialog" aria-modal="true" aria-label="Project Brain">
          {body}
        </div>
      ) : null}

      {memoryOpen ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="project-memory-title">
          <section className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 id="project-memory-title" className="text-xl font-semibold">Project Memory</h2>
              <button type="button" className="secondary-button" onClick={() => setMemoryOpen(false)}>Close</button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ["Project summary", "summary", memory?.summary],
                ["Goal", "goal", memory?.goal ?? project.goal],
                ["Product", "product_description", memory?.product_description],
                ["Audience", "target_audience", memory?.target_audience],
                ["Current scope", "current_scope", memory?.current_scope],
                ["Future scope", "future_scope", memory?.future_scope],
                ["Technology", "technical_context", memory?.technical_context],
                ["Design direction", "design_context", memory?.design_context],
                [
                  "Constraints",
                  "constraints",
                  constraints.length ? constraints : memory?.constraints
                ],
                ["Decisions", "decisions", decisions],
                ["Success criteria", "success_criteria", memory?.success_criteria],
                ["Assumptions", "assumptions", memory?.assumptions]
              ].map(([label, field, value]) => {
                const source =
                  memory?.provenance &&
                  typeof memory.provenance === "object" &&
                  !Array.isArray(memory.provenance)
                    ? (memory.provenance as Record<string, { source_type?: string }>)[
                        String(field)
                      ]?.source_type
                    : null;
                const confirmed =
                  memory?.confirmed_fields &&
                  typeof memory.confirmed_fields === "object" &&
                  !Array.isArray(memory.confirmed_fields) &&
                  Boolean(
                    (memory.confirmed_fields as Record<string, unknown>)[
                      String(field)
                    ]
                  );
                return (
                  <article key={String(label)} className="rounded-2xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{String(label)}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                      {value == null
                        ? "Not recorded"
                        : typeof value === "string"
                          ? value
                          : JSON.stringify(value, null, 2)}
                    </p>
                    <p className="mt-2 text-[10px] text-slate-400">
                      {source ? `Source: ${source.replaceAll("_", " ")}` : "No confirmed source"}
                      {` · ${confirmed ? "User-confirmed" : "AI-inferred"}`}
                      {memory?.updated_at
                        ? ` · Updated ${formatReadableDate(memory.updated_at)}`
                        : ""}
                    </p>
                    <button
                      type="button"
                      className="mt-2 text-xs font-semibold text-brand-700"
                      onClick={() => {
                        setMemoryOpen(false);
                        setDraft(`Update ${String(label).toLowerCase()}: `);
                        setMobileOpen(true);
                        window.setTimeout(() => inputRef.current?.focus(), 50);
                      }}
                    >
                      Edit through Project Brain
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {reviewing ? (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="proposal-review-title">
          <section className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="proposal-review-title" className="text-xl font-semibold">Review proposed changes</h2>
                <p className="mt-1 text-sm text-slate-500">{reviewing.summary}</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => setReviewing(null)}>Return to chat</button>
            </div>
            <div className="mt-5 rounded-2xl bg-slate-50 p-4">
              <p className="font-semibold text-slate-950">
                {reviewOperations.length} proposed change
                {reviewOperations.length === 1 ? "" : "s"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {reviewCounts.map(([group, count]) => (
                  <span
                    key={group}
                    className="rounded-full bg-white px-3 py-1 text-xs text-slate-600"
                  >
                    {count} {group.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="secondary-button !px-3 !py-1.5 text-xs"
                onClick={() => setEnabled(reviewOperations.map(() => true))}
              >
                Approve all
              </button>
              <button
                type="button"
                className="secondary-button !px-3 !py-1.5 text-xs"
                onClick={() => setEnabled(reviewOperations.map(() => false))}
              >
                Deselect all
              </button>
            </div>
            <div className="mt-5">
              <ProjectBrainOperationReview
                operations={reviewOperations}
                enabled={enabled}
                drafts={operationDrafts}
                errors={operationErrors}
                context={{ project, memory, milestones, tasks }}
                onToggle={(index, value) =>
                  setEnabled((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? value : item
                    )
                  )
                }
                onDraftChange={updateOperationDraft}
              />
            </div>
            {reviewError ? <p className="mt-3 text-sm text-rose-700" role="alert">{reviewError}</p> : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="secondary-button" onClick={() => void rejectProposal(reviewing)}>Reject proposal</button>
              <button
                type="button"
                className="premium-button"
                disabled={
                  loading ||
                  enabled.every((value) => !value) ||
                  operationErrors.some(
                    (item, index) => enabled[index] && Boolean(item)
                  )
                }
                onClick={() => void applyProposal()}
              >
                Approve selected & apply
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
