"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Modal, ModalActions } from "@/components/modal";
import { formatReadableDate } from "@/lib/format-date";
import { getDeliverableLifecycleState } from "@/lib/task-deliverable-lifecycle";
import { getDeliverablePanelTitle } from "@/lib/task-deliverables";
import type { MeetingCommitment, MeetingTask, TaskArtifact } from "@/lib/types";

type DialogKind = "accept" | "reopen" | "regenerate" | "edit-accepted-warning" | null;

function lifecycleBadgeClassName(state: "draft" | "accepted" | "failed") {
  if (state === "accepted") return "border-brand-200 bg-brand-50 text-brand-800";
  if (state === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function lifecycleLabel(state: "draft" | "accepted" | "failed") {
  if (state === "accepted") return "Accepted";
  if (state === "failed") return "Failed";
  return "Draft";
}

export function DeliverableFocusedView({
  initialArtifact,
  task,
  commitment,
  history,
  currentVersionId,
  generatedLabel
}: {
  initialArtifact: TaskArtifact;
  task: MeetingTask;
  commitment: Pick<MeetingCommitment, "id" | "title"> | null;
  history: TaskArtifact[];
  currentVersionId: string;
  generatedLabel: string | null;
}) {
  const router = useRouter();
  const [artifact, setArtifact] = useState(initialArtifact);
  const [taskState, setTaskState] = useState(task);
  const [editing, setEditing] = useState(false);
  const [editableTitle, setEditableTitle] = useState(artifact.title);
  const [editableContent, setEditableContent] = useState(artifact.content);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const isCurrent = artifact.id === currentVersionId;
  const lifecycleState = getDeliverableLifecycleState(artifact);
  const panelTitle = getDeliverablePanelTitle(artifact.deliverable_type ?? undefined);

  function closeDialog() {
    setDialog(null);
    setError(null);
    setBusy(false);
  }

  function beginEdit() {
    if (lifecycleState === "accepted") {
      setDialog("edit-accepted-warning");
      return;
    }
    setEditableTitle(artifact.title);
    setEditableContent(artifact.content);
    setEditing(true);
  }

  async function saveEdit() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/tasks/${task.id}/deliverable`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactId: artifact.id,
        title: editableTitle,
        content: editableContent
      })
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.artifact) {
      setError(result.error || "Failed to save deliverable.");
      return;
    }
    setEditing(false);
    closeDialog();
    router.push(`/deliverables/${result.artifact.id}` as Route);
    router.refresh();
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopyMessage("Copied");
    } catch {
      setCopyMessage("Unable to copy");
    }
    setTimeout(() => setCopyMessage(null), 2000);
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    const response = await fetch(
      `/api/tasks/${task.id}/generate-deliverable?regenerate=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() || undefined })
      }
    );
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.artifact) {
      setError(result.error || "Failed to regenerate deliverable.");
      return;
    }
    closeDialog();
    setInstruction("");
    router.push(`/deliverables/${result.artifact.id}` as Route);
    router.refresh();
  }

  async function restoreThisVersion() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/deliverables/${artifact.id}/restore`, {
      method: "POST"
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.artifact) {
      setError(result.error || "Failed to restore this version.");
      return;
    }
    router.push(`/deliverables/${result.artifact.id}` as Route);
    router.refresh();
  }

  async function acceptDeliverable() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/deliverables/${artifact.id}/accept`, { method: "POST" });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.artifact) {
      setError(result.error || "Failed to accept deliverable.");
      return;
    }
    setArtifact(result.artifact);
    if (result.task) setTaskState(result.task);
    closeDialog();
    router.refresh();
  }

  async function reopenDeliverable() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/deliverables/${artifact.id}/reopen`, { method: "POST" });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.artifact) {
      setError(result.error || "Failed to reopen deliverable.");
      return;
    }
    setArtifact(result.artifact);
    if (result.task) setTaskState(result.task);
    closeDialog();
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-6">
        {/* Header -- the deliverable itself, not the extraction pipeline, dominates this page. */}
        <div className="premium-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                {panelTitle}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
                {artifact.title}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-slate-600">
                <span
                  className={`badge-state ${lifecycleBadgeClassName(lifecycleState)}`}
                >
                  {lifecycleLabel(lifecycleState)}
                </span>
                <span>
                  <span className="text-slate-500">Task </span>
                  <Link
                    href={`/tasks/${task.id}` as Route}
                    className="font-semibold text-slate-800 hover:text-brand-700"
                  >
                    {task.task}
                  </Link>
                </span>
                {commitment ? (
                  <span>
                    <span className="text-slate-500">Commitment </span>
                    <Link
                      href={`/commitments/${commitment.id}` as Route}
                      className="font-semibold text-slate-800 hover:text-brand-700"
                    >
                      {commitment.title}
                    </Link>
                  </span>
                ) : null}
                {generatedLabel ? (
                  <span>
                    <span className="text-slate-500">Generated </span>
                    <span className="font-semibold text-slate-800">{generatedLabel}</span>
                  </span>
                ) : null}
                <span className="badge-meta">v{artifact.version}</span>
              </div>
              {!isCurrent ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  You&apos;re viewing an older version.{" "}
                  <Link href={`/deliverables/${currentVersionId}` as Route} className="font-semibold underline">
                    View current version →
                  </Link>
                </p>
              ) : null}
              {lifecycleState === "accepted" ? (
                <p className="text-xs text-slate-500">
                  Accepted {formatReadableDate(artifact.accepted_at ?? null) ?? ""}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            {isCurrent ? (
              <>
                <button type="button" onClick={beginEdit} className="secondary-button px-3 py-2 text-xs">
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setDialog("regenerate")}
                  className="secondary-button px-3 py-2 text-xs"
                >
                  Regenerate
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void restoreThisVersion()}
                disabled={busy}
                className="secondary-button px-3 py-2 text-xs"
              >
                {busy ? "Restoring…" : "Restore this version"}
              </button>
            )}
            <button type="button" onClick={copyContent} className="secondary-button px-3 py-2 text-xs">
              {copyMessage ?? "Copy"}
            </button>
            {isCurrent && lifecycleState === "draft" ? (
              <button
                type="button"
                onClick={() => setDialog("accept")}
                className="premium-button ml-auto px-4 py-2 text-xs"
              >
                Accept &amp; Complete Task
              </button>
            ) : null}
            {isCurrent && lifecycleState === "accepted" ? (
              <button
                type="button"
                onClick={() => setDialog("reopen")}
                className="tertiary-button ml-auto px-3 py-2 text-xs"
              >
                Reopen / Mark as Draft
              </button>
            ) : null}
          </div>
        </div>

        {lifecycleState === "failed" ? (
          <div className="premium-card space-y-3 border border-rose-200 p-5">
            <p className="text-sm font-semibold text-rose-700">Generation failed</p>
            <p className="text-sm text-slate-600">
              {artifact.content || "Parfait was unable to generate this deliverable."}
            </p>
            <button
              type="button"
              onClick={() => setDialog("regenerate")}
              className="premium-button px-4 py-2 text-sm"
            >
              Retry
            </button>
          </div>
        ) : editing ? (
          <div className="premium-card space-y-4 p-5 sm:p-6">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Title
              </label>
              <input
                value={editableTitle}
                onChange={(event) => setEditableTitle(event.target.value)}
                className="premium-input mt-2 w-full text-base font-semibold"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Content
              </label>
              <textarea
                value={editableContent}
                onChange={(event) => setEditableContent(event.target.value)}
                className="mt-2 min-h-[28rem] w-full resize-y rounded-2xl border border-slate-200 bg-white px-5 py-5 font-mono text-sm leading-7 text-slate-800 shadow-inner outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-500/10"
              />
            </div>
            {error ? <p className="text-sm text-rose-700">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                className="tertiary-button px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={busy}
                className="premium-button px-4 py-2 text-sm"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="premium-card p-5 sm:p-6">
            <div className="whitespace-pre-wrap text-sm leading-7 text-slate-800">
              {artifact.content}
            </div>
          </div>
        )}
      </div>

      {/* Version History -- progressive disclosure; clicking a version navigates to its own
          page rather than swapping content in place, so "inspect" never means "replace". */}
      <aside className="space-y-4 lg:sticky lg:top-6">
        <section className="premium-card p-5">
          <h2 className="text-sm font-semibold text-slate-900">Version History</h2>
          <ul className="mt-3 space-y-1.5">
            {history.map((version) => {
              const state = getDeliverableLifecycleState(version);
              const source =
                version.metadata &&
                typeof version.metadata === "object" &&
                !Array.isArray(version.metadata) &&
                (version.metadata as Record<string, unknown>).restored_from_version
                  ? `Restored from v${(version.metadata as Record<string, unknown>).restored_from_version}`
                  : version.status === "edited"
                    ? "Edited"
                    : version.status === "failed"
                      ? "Generation failed"
                      : "Generated by Parfait";
              const active = version.id === artifact.id;
              return (
                <li key={version.id}>
                  <Link
                    href={`/deliverables/${version.id}` as Route}
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition ${
                      active
                        ? "bg-brand-50 text-brand-900"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="font-semibold">
                        v{version.version} {version.id === currentVersionId ? "· Current" : ""}
                      </span>
                      <span className="block text-slate-500">{source}</span>
                    </span>
                    {state === "accepted" ? (
                      <span className="badge-state border-brand-200 bg-brand-50 text-brand-800 shrink-0">
                        Accepted
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </aside>

      <Modal open={dialog === "accept"} title="Accept this deliverable?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Accept this deliverable?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This will mark:
          <br />
          <span className="font-semibold text-slate-900">&ldquo;{task.task}&rdquo;</span>
          <br />
          as completed.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void acceptDeliverable()}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Accepting…" : "Accept & Complete Task"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "reopen"} title="Reopen this deliverable?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Reopen / mark as draft?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This deliverable will no longer count as accepted, and{" "}
          <span className="font-semibold text-slate-900">&ldquo;{task.task}&rdquo;</span> will
          reopen if it&apos;s still marked completed.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void reopenDeliverable()}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Reopening…" : "Reopen"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "regenerate"} title="Regenerate deliverable" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Regenerate</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The current version is preserved in Version History -- this creates a new version
          rather than replacing it.
        </p>
        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Optional instruction
          <textarea
            className="premium-input mt-2 min-h-16"
            value={instruction}
            maxLength={500}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Make it shorter and more founder-focused."
          />
        </label>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Parfait is regenerating…" : "Regenerate"}
          </button>
        </ModalActions>
      </Modal>

      <Modal
        open={dialog === "edit-accepted-warning"}
        title="Edit this accepted deliverable?"
        onClose={closeDialog}
      >
        <h2 className="text-base font-semibold text-slate-950">Edit this accepted deliverable?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Editing creates a new draft version. The accepted version is preserved in Version
          History, and{" "}
          <span className="font-semibold text-slate-900">&ldquo;{task.task}&rdquo;</span> will
          reopen since its accepted evidence will no longer be current.
        </p>
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setEditableTitle(artifact.title);
              setEditableContent(artifact.content);
              setEditing(true);
              closeDialog();
            }}
            className="premium-button px-4 py-2 text-sm"
          >
            Edit anyway
          </button>
        </ModalActions>
      </Modal>

      {taskState.status === "completed" && lifecycleState === "accepted" ? (
        <p className="sr-only" role="status">
          Task completed. Commitment progress updated.
        </p>
      ) : null}
    </div>
  );
}
