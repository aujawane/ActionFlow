"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ActionMenu } from "@/components/action-menu";
import { Modal, ModalActions } from "@/components/modal";
import { isCommittedWork } from "@/lib/execution-display";
import type { MeetingTask } from "@/lib/types";

type DestinationCommitment = { id: string; title: string };

const REPORT_REASONS: Array<{ value: string; label: string }> = [
  { value: "wrong_owner", label: "Wrong owner" },
  { value: "wrong_classification", label: "Wrong classification" },
  { value: "duplicate", label: "Duplicate" },
  { value: "missing_context", label: "Missing/incorrect context" },
  { value: "not_execution_work", label: "Should not be execution work" },
  { value: "other", label: "Other" }
];

type DialogKind = "move" | "standalone" | "future_scope" | "promote" | "evidence" | "report" | null;

/** The full Phase 6 correction surface for a single task: overflow trigger + every dialog it can
 * open. Self-contained (fetches its own move-destination options, performs its own mutations)
 * so it can be dropped into Commitment Workspace, Task Workspace, or a Meeting Detail panel
 * without each caller re-implementing the same fetch/dialog plumbing. */
export function TaskCorrectionMenu({
  task,
  onTaskUpdated
}: {
  task: MeetingTask;
  onTaskUpdated: (task: MeetingTask) => void;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [destinations, setDestinations] = useState<DestinationCommitment[] | null>(null);
  const [destinationId, setDestinationId] = useState("");

  const [reportReason, setReportReason] = useState("wrong_owner");
  const [reportNote, setReportNote] = useState("");
  const [reportSubmitted, setReportSubmitted] = useState(false);

  function closeDialog() {
    setDialog(null);
    setError(null);
    setBusy(false);
    setReportSubmitted(false);
  }

  async function openMoveDialog() {
    setDialog("move");
    setError(null);
    if (destinations !== null) return;
    const response = await fetch(`/api/tasks/${task.id}/commitment-options`);
    const result = await response.json().catch(() => ({}));
    if (response.ok && Array.isArray(result.commitments)) {
      setDestinations(result.commitments);
      if (result.commitments[0]) setDestinationId(result.commitments[0].id);
    } else {
      setDestinations([]);
    }
  }

  async function submitMove() {
    if (!destinationId) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/tasks/${task.id}/commitment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitment_id: destinationId })
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.task) {
      setError(result.error || "Failed to move task.");
      return;
    }
    onTaskUpdated(result.task as MeetingTask);
    router.refresh();
    closeDialog();
  }

  async function submitMakeStandalone() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/tasks/${task.id}/commitment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitment_id: null })
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.task) {
      setError(result.error || "Failed to make this task standalone.");
      return;
    }
    onTaskUpdated(result.task as MeetingTask);
    router.refresh();
    closeDialog();
  }

  async function submitClassification(next: "committed" | "future_consideration") {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/tasks/${task.id}/classification`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_classification: next })
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok || !result.task) {
      setError(result.error || "Failed to update this task.");
      return;
    }
    onTaskUpdated(result.task as MeetingTask);
    router.refresh();
    closeDialog();
  }

  async function submitReport() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/tasks/${task.id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reportReason, note: reportNote.trim() || undefined })
    });
    setBusy(false);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.error || "Failed to send report.");
      return;
    }
    setReportSubmitted(true);
    router.refresh();
  }

  const isActive = isCommittedWork(task);
  const items = [
    // Reorganizing where a task sits in the commitment hierarchy only makes sense for active
    // work -- a Future Scope task must be promoted back to active first, avoiding the ambiguous
    // state of a commitment_id pointing out of a classification that isn't active.
    isActive ? { label: "Move to another commitment…", onSelect: openMoveDialog } : null,
    isActive && task.commitment_id
      ? { label: "Make standalone", onSelect: () => setDialog("standalone") }
      : null,
    isActive
      ? { label: "Move to Future Scope", onSelect: () => setDialog("future_scope") }
      : { label: "Promote to active work", onSelect: () => setDialog("promote") },
    task.source_quote ? { label: "View source evidence", onSelect: () => setDialog("evidence") } : null,
    {
      label: "Report incorrect extraction",
      onSelect: () => setDialog("report"),
      variant: "destructive" as const
    }
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <>
      <ActionMenu label={`More actions for ${task.task}`} items={items} />

      <Modal open={dialog === "move"} title="Move to commitment" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Move to commitment</h2>
        <p className="mt-2 text-sm text-slate-600">
          Current: {task.commitment_id ? "part of a commitment" : "standalone"}
        </p>
        {destinations === null ? (
          <p className="mt-4 text-sm text-slate-500">Loading eligible commitments…</p>
        ) : destinations.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No other eligible commitments are available to move this task into.
          </p>
        ) : (
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Select destination
            <select
              className="premium-input mt-2"
              value={destinationId}
              onChange={(event) => setDestinationId(event.target.value)}
            >
              {destinations.map((commitment) => (
                <option key={commitment.id} value={commitment.id}>
                  {commitment.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={submitMove}
            disabled={busy || !destinationId}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Moving…" : "Move task"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "standalone"} title="Make this task standalone?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Make this task standalone?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          It will remain active work, but will no longer count toward its current commitment&apos;s
          progress. You can move it into a commitment again later.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={submitMakeStandalone}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Working…" : "Make standalone"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "future_scope"} title="Move to Future Scope?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Move to Future Scope?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This item will no longer count as active execution work, task workload, or commitment
          progress. It will still be visible under Future Scope, and you can promote it back to
          active work at any time.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submitClassification("future_consideration")}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Working…" : "Move to Future Scope"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "promote"} title="Promote to active work?" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Promote to active work?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This item will become a standalone task, counted toward open tasks and workload.
        </p>
        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submitClassification("committed")}
            disabled={busy}
            className="premium-button px-4 py-2 text-sm"
          >
            {busy ? "Working…" : "Promote to active work"}
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "evidence"} title="Source evidence" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Source evidence</h2>
        <p className="mt-1 text-xs text-slate-500">Why Parfait created this task.</p>
        {task.source_quote ? (
          <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm italic leading-6 text-slate-600">
            &ldquo;{task.source_quote}&rdquo;
          </blockquote>
        ) : (
          <p className="mt-3 text-sm text-slate-500">No source quote was captured.</p>
        )}
        <ModalActions>
          <button type="button" onClick={closeDialog} className="secondary-button px-4 py-2 text-sm">
            Close
          </button>
        </ModalActions>
      </Modal>

      <Modal open={dialog === "report"} title="Report incorrect extraction" onClose={closeDialog}>
        <h2 className="text-base font-semibold text-slate-950">Report incorrect extraction</h2>
        {reportSubmitted ? (
          <>
            <p className="mt-3 text-sm text-slate-600">
              Thanks -- this was recorded on the task&apos;s history.
            </p>
            <ModalActions>
              <button type="button" onClick={closeDialog} className="secondary-button px-4 py-2 text-sm">
                Close
              </button>
            </ModalActions>
          </>
        ) : (
          <>
            <fieldset className="mt-3 space-y-1.5">
              <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                What&apos;s wrong?
              </legend>
              {REPORT_REASONS.map((reason) => (
                <label key={reason.value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="report-reason"
                    value={reason.value}
                    checked={reportReason === reason.value}
                    onChange={() => setReportReason(reason.value)}
                    className="accent-brand-600"
                  />
                  {reason.label}
                </label>
              ))}
            </fieldset>
            <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Note (optional)
              <textarea
                className="premium-input mt-2 min-h-16"
                value={reportNote}
                maxLength={1000}
                onChange={(event) => setReportNote(event.target.value)}
                placeholder="Anything that would help explain the issue"
              />
            </label>
            {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
            <ModalActions>
              <button type="button" onClick={closeDialog} className="tertiary-button px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={busy}
                className="premium-button px-4 py-2 text-sm"
              >
                {busy ? "Sending…" : "Send report"}
              </button>
            </ModalActions>
          </>
        )}
      </Modal>
    </>
  );
}
